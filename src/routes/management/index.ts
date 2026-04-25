import { Hono } from "hono";
import apps from "./app.ts";
import users from "./user.ts";
import orgs from "./organization.ts";
import mapsets from "./mapset.ts";
import layers from "./layer.ts";
import incidents from "./incident.ts";
import jobs from "./jobs.ts";
import sessions from "./session.ts";
import type { AppEnv } from "../../types/context.ts";

const management = new Hono<AppEnv>();

management.route("/app", apps);
management.route("/user", users);
management.route("/org", orgs);
management.route("/mapset", mapsets);
management.route("/layer", layers);
management.route("/incident", incidents);
management.route("/jobs", jobs);
management.route("/session", sessions);

export default management;
