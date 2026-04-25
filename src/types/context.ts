import type { InferSelectModel } from "drizzle-orm";
import type { user, organization } from "../db/schema/application.ts";

export type AuthUser = InferSelectModel<typeof user> & {
  organizations: Pick<InferSelectModel<typeof organization>, "id" | "name">[];
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
    tracker?: { name: string; buildingId: string; identifier: string };
  };
};
