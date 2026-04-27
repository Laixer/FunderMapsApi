import type { InferSelectModel } from "drizzle-orm";
import type { user, organization } from "../db/schema/application.ts";

export type AuthUser = InferSelectModel<typeof user> & {
  organizations: (Pick<InferSelectModel<typeof organization>, "id" | "name"> & {
    role: string | null;
  })[];
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
    tracker?: {
      product: string;
      buildingId: string;
      organizationId: string;
      identifier: string;
    };
  };
};
