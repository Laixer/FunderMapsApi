import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/client.ts";
import { env } from "../config.ts";
import * as schema from "../db/schema/index.ts";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  baseURL: env.BASE_URL,
  basePath: "/api/auth",
  secret: env.AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
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
