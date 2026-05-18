import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins/bearer";
import { jwt } from "better-auth/plugins/jwt";
import { oidcProvider } from "better-auth/plugins/oidc-provider";
import { createAccessControl } from "better-auth/plugins/access";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  hashPassword as baHashPassword,
  verifyPassword as baVerifyPassword,
} from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { env } from "../config.ts";
import * as schema from "../db/schema/index.ts";
import { account, oauthApplication } from "../db/schema/application.ts";
import {
  looksLikeDotnetIdentity,
  looksLikeFunderMapsCustom,
  verifyDotnetIdentityV3,
  verifyFunderMapsCustom,
} from "./legacy-password.ts";
import { sendMail } from "../services/mail.ts";

// OIDC trusted clients — first-party SSO consumers that bypass the consent
// screen and the DB lookup in the bundled `oidc-provider` plugin. The
// plugin's getClient() reads oauth_application rows but does NOT expose
// skipConsent (or requirePKCE) on the returned shape, so any row that
// should skip consent has to be hoisted into the `trustedClients` array at
// plugin construction time.
//
// Two sources, merged at startup:
//   1. Env-driven Grafana entry (legacy hardcode; preserved for backward
//      compat — the prod env still sets GRAFANA_OIDC_SECRET).
//   2. DB rows in application.oauth_application where disabled = false AND
//      skip_consent = true. The Grafana row may live here too; env wins
//      via order of insertion + BA's `find(client => clientId === id)`.
//
// Changing client config requires an API restart — getClient() reads
// `trustedClients` from the closure captured at plugin construction.
type OidcTrustedClient = NonNullable<
  Parameters<typeof oidcProvider>[0]["trustedClients"]
>[number];

async function loadDbTrustedClients(): Promise<OidcTrustedClient[]> {
  const rows = await db
    .select()
    .from(oauthApplication)
    .where(
      and(
        eq(oauthApplication.disabled, false),
        eq(oauthApplication.skipConsent, true),
      ),
    );
  return rows.map((r) => ({
    clientId: r.clientId,
    clientSecret: r.clientSecret ?? undefined,
    name: r.name,
    icon: r.icon ?? undefined,
    type: r.type as OidcTrustedClient["type"],
    redirectUrls: r.redirectUrls.split(",").map((u) => u.trim()).filter(Boolean),
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    disabled: r.disabled ?? false,
    skipConsent: true,
  }));
}

const grafanaTrustedClient: OidcTrustedClient | null = env.GRAFANA_OIDC_SECRET
  ? {
      clientId: "grafana",
      clientSecret: env.GRAFANA_OIDC_SECRET,
      name: "Grafana",
      type: "web",
      redirectUrls: ["https://analytics.fundermaps.com/login/generic_oauth"],
      metadata: null,
      disabled: false,
      skipConsent: true,
    }
  : null;

const dbTrustedClients = await loadDbTrustedClients();
const oidcTrustedClients: OidcTrustedClient[] = [
  ...(grafanaTrustedClient ? [grafanaTrustedClient] : []),
  ...dbTrustedClients.filter(
    (c) => c.clientId !== grafanaTrustedClient?.clientId,
  ),
];
console.log(
  `[oidc] loaded ${oidcTrustedClients.length} trusted client(s): ` +
    oidcTrustedClients.map((c) => c.clientId).join(", ") || "(none)",
);

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
  plugins: [
    bearer(),
    jwt(),
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
    // API-key plugin — mounted but not yet read by any auth middleware.
    // New `fmsk.`-prefixed keys are written into application.apikey via
    // the plugin's /api/auth/api-key/* endpoints; the legacy custom
    // middleware (src/middleware/auth.ts) and management routes still
    // run against application.auth_key. Dual-validate cutover lands in a
    // follow-up PR (Phase B of the apiKey migration in
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
    // OIDC/OAuth2 authorization server. Used by Grafana SSO (replaces the
    // Go OAuth2 server). loginPage points at ManagementFront's login —
    // when an unauthenticated user hits /api/auth/oauth2/authorize, the
    // plugin redirects there and ManagementFront completes the flow by
    // posting back the credentials. requirePKCE=false because Grafana's
    // generic_oauth client doesn't send code_verifier.
    oidcProvider({
      loginPage: "https://admin.fundermaps.com/login",
      requirePKCE: false,
      // Loaded at module init: env-driven Grafana hardcode (backward
      // compat) merged with DB rows where skip_consent = true. See the
      // loader above for why this is needed instead of pure DB lookup.
      trustedClients: oidcTrustedClients,
      getAdditionalUserInfoClaim: (u) => ({
        role: (u as { role?: string }).role ?? "user",
      }),
    }),
  ],
});
