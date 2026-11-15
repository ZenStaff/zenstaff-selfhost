// First-device approval alerts. A runner pins a person's first device key as "pending" and asks
// the hub, as the runner (its credential, not a person's session), to tell the people who can
// approve it: the runner's owner and the owners/admins of the company the request came for. The
// approval itself happens on the runner (Team page); the hub only delivers the alert.
import type { Kit } from "../app.ts";
import { bad, HttpError, makeLimiter, notFound, optStr, str } from "../http.ts";
import { fingerprintOf } from "../signing.ts";
import * as store from "../store.ts";
import { isUserSuspended } from "../storeAdmin.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";

/** One alert per runner and key in this window (a runner restarting does not resend it). */
const ALERT_REPEAT_MS = 12 * 60 * 60_000;

export function registerRunnerAlertRoutes(kit: Kit) {
  const { db, route, notifier } = kit;
  // Per runner: a burst of new people is fine, a runner spamming alerts is not.
  const perRunner = makeLimiter(20, 60 * 60_000, "Too many approval alerts from this runner. Wait an hour.");

  route(
    "POST",
    "/v1/runner/pending-device",
    ({ req, body }) => {
      const header = req.headers.authorization ?? "";
      const credential = header.startsWith("Runner ") ? header.slice(7).trim() : "";
      const environment = credential === "" ? null : store.environmentForCredential(db, credential);
      // A machine of a suspended account (platform admin) is refused like an unknown one.
      if (environment === null || isUserSuspended(db, environment.ownerUserId)) throw new HttpError(401, "Unknown runner credential.", "runner_signed_out");
      perRunner(`env:${environment.id}`);
      const userId = str(body, "userId", 80);
      const keyId = str(body, "keyId", 40);
      const companyId = optStr(body, "companyId", 80);
      const device = security.getDeviceKey(db, keyId);
      // Only a real, live device of that person: a runner cannot make the hub e-mail arbitrary text.
      if (device === null || device.userId !== userId || device.revoked) throw notFound("No such device.");
      const person = store.getUser(db, userId);
      if (person === null) throw notFound("No such device.");
      // The company must be one this runner serves: its runner company or a company it shares in.
      if (
        companyId !== null &&
        !environment.runnerCompanyIds.includes(companyId) &&
        !store.liveSharesOfEnvironment(db, environment.id).some((share) => share.companyId === companyId)
      ) {
        throw bad("This runner does not serve that company.");
      }
      const fresh = team.recordDeviceAlert(db, {
        environmentId: environment.id,
        keyId,
        userId,
        companyId,
        withinMs: ALERT_REPEAT_MS,
      });
      if (!fresh) return { ok: true, notified: 0 };
      const recipients = new Set<string>([environment.ownerUserId]);
      if (companyId !== null) for (const manager of team.managersOf(db, companyId)) recipients.add(manager.id);
      const fingerprint = fingerprintOf(device.signPublicKey);
      notifier.people({
        userIds: [...recipients],
        kind: "device",
        companyId,
        shareId: null,
        actorUserId: userId,
        title: `New device of ${person.name} waiting for approval on "${environment.name}"`,
        body: `${person.name} (${person.email}) used a new device with the runner "${environment.name}". Until it is approved there, it can only read. Key fingerprint: ${fingerprint}. Check it with ${person.name} (Team > Account > Device keys on their side), then approve or reject it in Zen Staff > Team > Account on "${environment.name}".`,
      });
      return { ok: true, notified: recipients.size };
    },
    "public",
  );
}
