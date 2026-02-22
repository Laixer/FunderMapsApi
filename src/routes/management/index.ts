import { Hono } from "hono";
import apps from "./app.ts";
import users from "./user.ts";
import orgs from "./organization.ts";
import mapsets from "./mapset.ts";
import incidents from "./incident.ts";
import jobs from "./jobs.ts";
import type { AppEnv } from "../../types/context.ts";

const management = new Hono<AppEnv>();

management.route("/app", apps);
management.route("/user", users);
management.route("/org", orgs);
management.route("/mapset", mapsets);
management.route("/incident", incidents);
management.route("/jobs", jobs);

export default management;
