import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import { organization } from "better-auth/plugins/organization";
import { bearer } from "better-auth/plugins/bearer";
import { jwt } from "better-auth/plugins/jwt";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createAccessControl } from "better-auth/plugins/access";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  hashPassword as baHashPassword,
  verifyPassword as baVerifyPassword,
} from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { env } from "../config.ts";
import * as schema from "../db/schema/index.ts";
import { account } from "../db/schema/application.ts";
import {
  looksLikeDotnetIdentity,
  looksLikeFunderMapsCustom,
  verifyDotnetIdentityV3,
  verifyFunderMapsCustom,
} from "./legacy-password.ts";
import { sendMail } from "../services/mail.ts";
import { ac as orgAc, roles as orgRoles } from "./permissions.ts";

// Fire-and-forget rehash: when a legacy PBKDF2 hash verifies, swap it for
// BA scrypt so the next login takes the native path. Account.password is
// unique per user (16-byte salt), so WHERE password = oldHash is exact.
function upgradeLegacyHash(oldHash: string, password: string): void {
  void (async () => {
    try {
      const newHash = await baHashPassword(password);
      await db
        .update(account)
        .set({ password: newHash, updatedAt: new Date() })
        .where(eq(account.password, oldHash));
    } catch (error) {
      // Non-fatal: next login will retry the upgrade.
      console.warn("Failed to upgrade legacy password hash", error);
    }
  })();
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  baseURL: env.BASE_URL,
  basePath: "/api/auth",
  secret: env.AUTH_SECRET,
  trustedOrigins: env.TRUSTED_ORIGINS,
  emailAndPassword: {
    enabled: true,
    password: {
      hash: baHashPassword,
      verify: async ({ hash, password }) => {
        // FunderMaps custom PBKDF2 format (272 migrated users from C# era).
        // Fixed-size 49-byte payload — try this first since it's the
        // dominant legacy format.
        if (looksLikeFunderMapsCustom(hash)) {
          const ok = verifyFunderMapsCustom(hash, password);
          if (ok) upgradeLegacyHash(hash, password);
          return ok;
        }
        // Standard .NET Identity v3 (variable-size); kept for completeness.
        if (looksLikeDotnetIdentity(hash)) {
          const ok = verifyDotnetIdentityV3(hash, password);
          if (ok) upgradeLegacyHash(hash, password);
          return ok;
        }
        // Anything else is treated as Better Auth's native scrypt format
        // ("salt:hex(key)"). New users land here from day 1.
        return baVerifyPassword({ hash, password });
      },
    },
    // Password reset email. The frontend POSTs /api/auth/request-password-reset
    // with { email, redirectTo: "<frontend>/reset-password" }; Better Auth
    // generates a one-time token, embeds it in `url`, and invokes this hook.
    // The link sends the user to <baseURL>/api/auth/reset-password/<token>?
    // callbackURL=<frontend>, which validates and redirects to the frontend
    // with ?token=<valid_token> in the query.
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        from: "FunderMaps <noreply@fundermaps.com>",
        to: [user.email],
        subject: "Reset your FunderMaps password",
        body:
          `Hi ${user.name || user.email},\n\n` +
          `A password reset was requested for your FunderMaps account.\n\n` +
          `Open the link below to set a new password (valid for 1 hour):\n${url}\n\n` +
          `If you did not request this, ignore this email — your password is unchanged.`,
      });
    },
    // Wipe all active sessions when a user resets their password — defensive
    // against stolen-credential scenarios where the attacker still has a
    // valid bearer token from before the reset.
    revokeSessionsOnPasswordReset: true,
  },
  user: {
    modelName: "user",
    fields: {
      image: "avatar",
    },
    additionalFields: {
      givenName: {
        type: "string",
        required: false,
        fieldName: "given_name",
      },
      lastName: {
        type: "string",
        required: false,
        fieldName: "last_name",
      },
      jobTitle: {
        type: "string",
        required: false,
        fieldName: "job_title",
      },
      phoneNumber: {
        type: "string",
        required: false,
        fieldName: "phone_number",
      },
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
    },
  },
  session: {
    modelName: "session",
  },
  account: {
    modelName: "account",
  },
  advanced: {
    database: {
      // BA's default ids are 32-char alnum strings; the org-plugin tables
      // (organization_user.id, invitation, organization_custom_role) are
      // uuid-typed like the rest of the application schema, so generate
      // uuids everywhere. Text-typed id columns (session, apikey) accept
      // them too — only the format of NEW rows changes, and nothing parses
      // those ids.
      generateId: () => crypto.randomUUID(),
    },
  },
  plugins: [
    bearer(),
    jwt(),
    // Organization plugin (auth-migration Phase 2, FunderMaps#1006). Mapped
    // via schema overrides onto the EXISTING application.organization +
    // organization_user tables — BA reads/writes the same rows the API
    // already uses, so there is no dual-write phase and the C# Webservice
    // (EOL Aug 2026) keeps seeing the columns it knows.
    //
    // Roles keep the exact names stored in organization_user.role (reader/
    // writer/verifier/superuser — see permissions.ts), so zero data
    // migration. dynamicAccessControl lets org admins define custom roles
    // with a JSON permission map (application.organization_custom_role);
    // the management portal surfaces that later.
    //
    // NOTE: route-level permission checks do NOT go through BA's
    // hasPermission endpoint — it requires a BA session, which API-key
    // callers don't have. src/lib/auth-helpers.ts authorizes against the
    // same permission map in-process for both auth paths.
    organization({
      ac: orgAc,
      roles: orgRoles,
      creatorRole: "superuser",
      dynamicAccessControl: {
        enabled: true,
      },
      schema: {
        member: {
          modelName: "organizationUser",
        },
      },
    }),
    // Admin plugin — adopted in *supplementing* mode. The existing
    // /api/management/* surface (gated by src/middleware/admin.ts) stays
    // as-is; the plugin layers on top to provide server-side ban
    // enforcement (user.banned / ban_reason / ban_expires), session
    // impersonation (session.impersonated_by), and a standard
    // setRole/listUserSessions/banUser surface under /api/auth/admin/*.
    //
    // The plugin's built-in role names are `admin` and `user`; we keep
    // the existing FunderMaps `administrator` literal by aliasing
    // adminAc's permission set under that name via the access-control
    // system. No data migration on application.user.role is needed.
    admin({
      ac: createAccessControl(defaultStatements),
      roles: {
        administrator: adminAc,
        user: userAc,
      },
      adminRoles: ["administrator"],
      defaultRole: "user",
    }),
    // API-key plugin — the primary key-validation path. `fmsk.`-prefixed
    // keys are written into application.apikey via the plugin's
    // /api/auth/api-key/* endpoints, and src/middleware/auth.ts validates
    // incoming keys with `auth.api.verifyApiKey()` first, falling back to a
    // SHA-256 lookup against the legacy application.auth_key table for
    // unrotated keys (drained in Phase D, post-Dec-2026; see
    // project_better_auth_migration.md). The `fmsk.` prefix matches our
    // existing keys' visual format; BA's docs recommend an underscore
    // suffix but the literal stays as-is for customer continuity.
    //
    // Rate-limit is OFF at the plugin level: BA's default is 10
    // requests/day, which would lock out paying billable customers
    // instantly. The TS Webservice serves >>10 calls/day per key by
    // design (every request is a billable product call). If we ever
    // want per-key throttling, it's an opt-in at key-creation time, not
    // a global default.
    apiKey({
      defaultPrefix: "fmsk.",
      rateLimit: {
        enabled: false,
      },
    }),
    // OAuth 2.1 / OIDC authorization server (`@better-auth/oauth-provider`,
    // replaces the deprecated bundled `oidc-provider` plugin 2026-05-18).
    // loginPage is the dedicated auth SPA (auth.fundermaps.com): when an
    // unauthenticated user hits /api/auth/oauth2/authorize, the plugin appends
    // the signed authorization request to this URL and redirects there; after
    // login the SPA replays that query string back to /oauth2/authorize.
    //
    // `requirePKCE` is now a per-client column (application.oauth_application.
    // require_pkce); the Grafana row needs it set false. New first-party
    // clients (auth SPA) should leave it null/true.
    //
    // `skip_consent` is also a per-client column read directly from DB by
    // the new plugin — no more startup-time `trustedClients` hoisting.
    //
    // `consentPage` is never reached: every first-party FunderMaps app is a
    // trusted client (skip_consent=true). Kept only because the plugin requires
    // the option; the placeholder URL 404s and that's fine.
    oauthProvider({
      loginPage: env.LOGIN_PAGE_URL,
      consentPage: "https://admin.fundermaps.com/oauth/consent",
      // Suppress boot warnings about discovery routes. The plugin defines
      // its metadata under /api/auth/.well-known/* but the OIDC spec wants
      // them at /.well-known/*/<issuer-path>. Grafana doesn't use discovery
      // (its config has explicit auth_url/token_url/userinfo_url), so this
      // doesn't block prod. If/when the auth SPA needs discovery, wire the
      // exported `oauthProviderAuthServerMetadata` /
      // `oauthProviderOpenIdConfigMetadata` helpers into Hono at the root
      // /.well-known/* paths and clear these flags.
      silenceWarnings: {
        oauthAuthServerConfig: true,
        openidConfig: true,
      },
      customAccessTokenClaims: ({ user: u }) => ({
        role: (u as { role?: string } | null | undefined)?.role ?? "user",
      }),
      customIdTokenClaims: ({ user: u }) => ({
        role: (u as { role?: string } | null | undefined)?.role ?? "user",
      }),
    }),
  ],
});
