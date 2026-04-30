import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { jwt } from "better-auth/plugins/jwt";
import { oidcProvider } from "better-auth/plugins/oidc-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  hashPassword as baHashPassword,
  verifyPassword as baVerifyPassword,
} from "better-auth/crypto";
import { db } from "../db/client.ts";
import { env } from "../config.ts";
import * as schema from "../db/schema/index.ts";
import {
  looksLikeDotnetIdentity,
  looksLikeFunderMapsCustom,
  verifyDotnetIdentityV3,
  verifyFunderMapsCustom,
} from "./legacy-password.ts";
import { sendMail } from "../services/mail.ts";

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
          return verifyFunderMapsCustom(hash, password);
        }
        // Standard .NET Identity v3 (variable-size); kept for completeness.
        if (looksLikeDotnetIdentity(hash)) {
          return verifyDotnetIdentityV3(hash, password);
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
    // OIDC/OAuth2 authorization server. Used by Grafana SSO (replaces the
    // Go OAuth2 server). loginPage points at ManagementFront's login —
    // when an unauthenticated user hits /api/auth/oauth2/authorize, the
    // plugin redirects there and ManagementFront completes the flow by
    // posting back the credentials. requirePKCE=false because Grafana's
    // generic_oauth client doesn't send code_verifier.
    oidcProvider({
      loginPage: "https://admin.fundermaps.com/login",
      requirePKCE: false,
      // Grafana is a first-party SSO consumer — skip the consent screen.
      // trustedClients short-circuits the DB lookup, so the matching row in
      // application.oauth_application is kept for record-keeping but the
      // values here are what BA actually uses at request time.
      trustedClients: env.GRAFANA_OIDC_SECRET
        ? [
            {
              clientId: "grafana",
              clientSecret: env.GRAFANA_OIDC_SECRET,
              name: "Grafana",
              type: "web",
              redirectUrls: [
                "https://analytics.fundermaps.com/login/generic_oauth",
              ],
              metadata: null,
              disabled: false,
              skipConsent: true,
            },
          ]
        : [],
      getAdditionalUserInfoClaim: (u) => ({
        role: (u as { role?: string }).role ?? "user",
      }),
    }),
  ],
});
