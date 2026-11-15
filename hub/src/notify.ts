// Notifications (in-app list + e-mail) and security alerts for admin actions. E-mail never blocks
// or fails the request that caused it; failures are logged.
import type { Db } from "./db.ts";
import type { Mailer } from "./mail.ts";
import * as store from "./store.ts";
import * as team from "./storeTeam.ts";

/**
 * Kinds of in-app notifications. Since v4 they carry routing only: who did it (`actorUserId`),
 * which share, which kind. Chat titles and comment text never reach the hub in clear, so the
 * stored title/body and the e-mails are generic; the app fills the chat title from the runner.
 */
export type NotificationKind =
  | "share"
  | "comment"
  | "handover"
  | "handover.accepted"
  | "handover.declined"
  | "device"
  | "grant";

export interface Notifier {
  /** In-app notification + e-mail (unless the person turned e-mails off). */
  people(input: {
    readonly userIds: ReadonlyArray<string>;
    readonly kind: NotificationKind;
    readonly companyId: string | null;
    readonly shareId: string | null;
    readonly actorUserId: string | null;
    readonly title: string;
    readonly body: string;
  }): void;
  /**
   * Admin action alert: e-mail to every owner and admin of the company (and `alsoUserIds`),
   * always, plus the audit log. These are security e-mails; they cannot be turned off.
   */
  adminAction(input: {
    readonly companyId: string;
    readonly actorUserId: string;
    readonly action: string;
    readonly summary: string;
    readonly alsoUserIds?: ReadonlyArray<string>;
  }): void;
  /** Security e-mail to one person about their own account (new device, 2FA changes). */
  account(userId: string, subject: string, text: string): void;
}

export function makeNotifier(input: {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly log: (line: string) => void;
}): Notifier {
  const { db, mailer, publicUrl, log } = input;
  const mail = (to: string, subject: string, text: string) => {
    mailer.send({ to, subject, text }).catch((error: unknown) => log(`[mail] to=${to} failed: ${String(error)}`));
  };
  const footer = `\n\n--\nZen Staff hub ${publicUrl}`;
  return {
    people({ userIds, kind, companyId, shareId, actorUserId, title, body }) {
      for (const userId of new Set(userIds)) {
        team.addNotification(db, { userId, kind, companyId, shareId, actorUserId, title, body });
        const user = store.getUser(db, userId);
        if (user === null || !team.preferencesOf(db, userId).notifyEmail) continue;
        mail(user.email, title, `${body}\n\nOpen Zen Staff > Team to see it.${footer}`);
      }
    },
    adminAction({ companyId, actorUserId, action, summary, alsoUserIds = [] }) {
      team.audit(db, { companyId, actorUserId, action, detail: summary });
      const company = store.getCompany(db, companyId);
      const actor = store.getUser(db, actorUserId);
      const recipients = new Map<string, string>();
      for (const manager of team.managersOf(db, companyId)) recipients.set(manager.id, manager.email);
      for (const userId of alsoUserIds) {
        const user = store.getUser(db, userId);
        if (user !== null) recipients.set(user.id, user.email);
      }
      const subject = `[${company?.name ?? "Zen Staff"}] ${summary}`;
      const text = `${summary}\n\nBy ${actor?.name ?? "someone"} (${actor?.email ?? "unknown"}) at ${new Date().toISOString()}.\n\nIf you did not expect this, open Zen Staff > Team, check the members and runners, and sign out unknown sessions.${footer}`;
      for (const email of recipients.values()) mail(email, subject, text);
    },
    account(userId, subject, text) {
      const user = store.getUser(db, userId);
      if (user !== null) mail(user.email, subject, `${text}${footer}`);
    },
  };
}
