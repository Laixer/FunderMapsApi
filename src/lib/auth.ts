import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
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
  ],
});
