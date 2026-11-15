// GET /v1/stats: the "Cifre" tab of the platform admin (/app/admin/cifre), for operators only
// (hub_staff, HUB_ADMIN_EMAILS or HUB_STATS_EMAILS) and only in a session that passed two-factor.
// Everyone else gets 404, as if the route did not exist. Each view is in the platform audit chain.
import type { Kit } from "../app.ts";
import { makeStats } from "../stats.ts";
import { makeAdminGate } from "./admin.ts";

export function registerStatsRoutes(kit: Kit) {
  const { db, config, route, log } = kit;
  const answer = makeStats(config.stats, db, log);
  const { gate, audit } = makeAdminGate(kit);
  const handler: Parameters<Kit["route"]>[2] = async ({ session }) => {
    gate(session, "stats");
    audit(session, "view", "cifre", { summary: "Stats" });
    return answer();
  };
  route("GET", "/v1/stats", handler);
  route("GET", "/v1/admin/stats", handler);
}
