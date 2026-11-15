// Academy team progress and learning signals, and the notifications list.
import type { Kit } from "../app.ts";
import { bad, forbidden, str } from "../http.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import * as roles from "../storeRbac.ts";
import * as team from "../storeTeam.ts";

const LESSON_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TOPIC = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function registerTeamRoutes(kit: Kit) {
  const { db, route, requireRole } = kit;

  route("PUT", "/v1/companies/:id/academy/progress", ({ session, params, body }) => {
    requireRole(params.id!, session.user.id);
    const lessonId = str(body, "lessonId", 80);
    if (!LESSON_ID.test(lessonId)) throw bad("Unknown lesson.");
    if (typeof body.done !== "boolean") throw bad("done must be true or false.");
    team.setLessonDone(db, params.id!, session.user.id, lessonId, body.done);
    return { ok: true };
  });

  /** Owners and admins see the whole team; everyone else sees their own lessons. */
  route("GET", "/v1/companies/:id/academy/progress", ({ session, params }) => {
    const myRole = requireRole(params.id!, session.user.id);
    const all = policy.canSeeTeamProgress(myRole) || rbac.can(roles.accessOf(db, params.id!, session.user.id), "echipa:administreaza");
    return { team: all, progress: team.progressOf(db, params.id!, all ? null : session.user.id) };
  });

  /** The app's "Help improve the Academy" counts (topic labels, sanitized searches), opt-in. */
  route("PUT", "/v1/companies/:id/academy/signals", ({ session, params, body }) => {
    requireRole(params.id!, session.user.id);
    const topics: Record<string, number> = {};
    if (typeof body.topics !== "object" || body.topics === null || Array.isArray(body.topics)) throw bad("topics must be an object.");
    for (const [topic, count] of Object.entries(body.topics as Record<string, unknown>).slice(0, 100)) {
      if (TOPIC.test(topic) && typeof count === "number" && Number.isInteger(count) && count >= 0) topics[topic] = Math.min(count, 100_000);
    }
    const searches = Array.isArray(body.searches)
      ? body.searches.filter((item): item is string => typeof item === "string" && item.length <= 80).slice(0, 50)
      : [];
    team.setSignals(db, params.id!, session.user.id, topics, searches);
    return { ok: true };
  });

  route("GET", "/v1/companies/:id/academy/signals", ({ session, params }) => {
    if (!policy.canSeeTeamProgress(requireRole(params.id!, session.user.id))) throw forbidden();
    return team.signalTotals(db, params.id!);
  });

  route("GET", "/v1/notifications", ({ session }) => ({
    notifications: team.notificationsOf(db, session.user.id),
    unread: team.unreadCount(db, session.user.id),
  }));

  route("POST", "/v1/notifications/read", ({ session, body }) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 200) : null;
    team.markNotificationsRead(db, session.user.id, ids);
    return { ok: true, unread: team.unreadCount(db, session.user.id) };
  });
}
