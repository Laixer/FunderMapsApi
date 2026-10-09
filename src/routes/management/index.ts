import { Hono } from "hono";
import users from "./user.ts";
import orgs from "./organization.ts";
import mapsets from "./mapset.ts";
import layers from "./layer.ts";
import jobs from "./jobs.ts";
import sessions from "./session.ts";
import rateLimits from "./rate-limit.ts";
import contractors from "./contractor.ts";
import permission from "./permission.ts";
import workPackages from "./work-package.ts";
import type { AppEnv } from "../../types/context.ts";

const management = new Hono<AppEnv>();

management.route("/user", users);
management.route("/org", orgs);
management.route("/mapset", mapsets);
management.route("/layer", layers);
management.route("/jobs", jobs);
management.route("/session", sessions);
management.route("/rate-limit", rateLimits);
management.route("/contractor", contractors);
management.route("/permission", permission);
management.route("/work-packages", workPackages);

export default management;
