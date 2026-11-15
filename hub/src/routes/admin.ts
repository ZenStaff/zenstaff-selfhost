// The platform admin (/app/admin, /v1/admin/*): for hub staff only (hub_staff, or the bootstrap
// e-mails in HUB_ADMIN_EMAILS / HUB_STATS_EMAILS for operators and HUB_LIBRARY_REVIEWERS for
// reviewers). Every route re-checks the staff role on the server, needs a session that passed
// two-factor, and writes to the platform audit chain (who, what, on what, address and device).
// Everyone else gets 404, as if the routes did not exist.
//
// Privacy, by construction: nothing here reads chats, shared views, company memory, files or the
// content of approvals, and there is no "sign in as". Only metadata (names, e-mails, roles, dates,
// counts, plans) leaves these routes.
import type { Kit } from "../app.ts";
import { type AuditEvent, PLATFORM_CHAIN, toCsv } from "../auditChain.ts";
import { bad, HttpError, type Json, notFound, optStr, str } from "../http.ts";
import { inviteMail, twoFactorResetMail } from "../mailTemplates.ts";
import * as admin from "../storeAdmin.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";
import type { SessionInfo } from "../storeSecurity.ts";

export interface StaffAccess {
  readonly roles: ReadonlyArray<admin.StaffRole>;
  readonly caps: ReadonlyArray<admin.AdminCap>;
}

/** The staff check every admin route (and the Cifre route) runs, plus the platform audit trail. */
export function makeAdminGate(kit: Kit) {
  const { db, config, auditLog } = kit;
  const boot = admin.staffBootstrap({ adminEmails: config.adminEmails, statsEmails: config.stats?.emails, libraryReviewers: config.libraryReviewers });

  const audit = (session: SessionInfo, action: string, target: string | null, detail: Record<string, unknown>) =>
    auditLog.append({
      companyId: null,
      chain: PLATFORM_CHAIN,
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      actorName: session.user.name,
      action: `admin.${action}`,
      target,
      detail,
    });

  const staffOf = (session: SessionInfo): StaffAccess => {
    const roles = admin.staffRolesOf(db, session.user, boot);
    return { roles, caps: admin.capsOf(roles) };
  };

  const gate = (session: SessionInfo, cap: admin.AdminCap): StaffAccess => {
    const staff = staffOf(session);
    if (staff.roles.length === 0) throw notFound();
    if (session.mfaAt === null) {
      throw new HttpError(403, "The admin needs a session that passed two-factor. Sign out and sign in again with your code.", "admin_two_factor");
    }
    if (!staff.caps.includes(cap)) {
      audit(session, "denied", cap, { summary: `Refused: ${cap} is not allowed for ${staff.roles.join(", ")}`, roles: staff.roles, cap });
      throw new HttpError(403, "Your platform role does not allow this.", "admin_forbidden");
    }
    return staff;
  };

  return { boot, gate, audit, staffOf };
}

const reasonOf = (body: Json, what = "reason") => {
  const reason = (optStr(body, what, 500) ?? "").trim();
  if (reason.length < 5) throw bad("Write the reason (at least 5 characters); it goes to the admin journal.");
  return reason;
};

const flag = (value: string | null) => (value === "yes" || value === "on" || value === "1" ? true : value === "no" || value === "off" || value === "0" ? false : null);

const filtersOf = (query: URLSearchParams, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.flatMap((key) => (query.get(key) ? [[key, query.get(key)!.slice(0, 100)]] : [])));

const presentEvent = (event: AuditEvent) => ({
  seq: event.seq,
  chainSeq: event.chainSeq,
  id: event.id,
  ts: event.ts,
  action: event.action,
  actorUserId: event.actorUserId,
  actorEmail: event.actorEmail,
  actorName: event.actorName,
  target: event.target,
  detail: event.detail,
  ip: event.ip,
  deviceId: event.deviceId,
  userAgent: event.userAgent,
  prevHash: event.prevHash,
  hash: event.hash,
});

export function registerAdminRoutes(kit: Kit) {
  const { db, route, config, relay, mailer, auditLog } = kit;
  const { gate, audit, boot, staffOf } = makeAdminGate(kit);
  const defaults = admin.planDefaults(config.plan);

  const companyOr404 = (companyId: string) => {
    const row = admin.companyRow(db, companyId, defaults);
    if (row === null) throw notFound("No such company.");
    return row;
  };
  const accountOr404 = (userId: string) => {
    const account = admin.getAccount(db, userId);
    if (account === null) throw notFound("No such account.");
    return account;
  };

  /** Runners online right now; support and operators see plans only with billing.view. */
  const presentCompany = (row: admin.CompanyRow, staff: StaffAccess) => {
    const { runnerIds, ...rest } = row;
    const online = runnerIds.filter((id) => relay.isOnline(id)).length;
    const base = { ...rest, runnersOnline: online };
    if (staff.caps.includes("billing.view")) return base;
    const { plan: _plan, status: _status, planSet: _set, pricePerSeat: _price, seatsPaid: _paid, ...noBilling } = base;
    return noBilling;
  };

  /** Staff accounts are suspended or reset only by operators (support cannot lock out the team). */
  const protectStaff = (session: SessionInfo, staff: StaffAccess, target: { id: string; email: string }) => {
    if (target.id === session.user.id) throw bad("Do this from your own Securitate page, not from the admin.");
    const targetRoles = admin.staffRolesOf(db, target, boot);
    if (targetRoles.length > 0 && !staff.roles.includes("operator")) throw new HttpError(403, "Only an operator acts on another staff account.", "admin_forbidden");
  };

  // ---- Who am I ------------------------------------------------------------------------------

  route("GET", "/v1/admin/me", ({ session }) => {
    const staff = staffOf(session);
    if (staff.roles.length === 0) throw notFound();
    return { roles: staff.roles, caps: staff.caps, twoFactorSession: session.mfaAt !== null };
  });

  // ---- Firme ---------------------------------------------------------------------------------

  route("GET", "/v1/admin/companies", ({ session, query }) => {
    const staff = gate(session, "companies");
    const page = admin.companiesPage(
      db,
      {
        q: query.get("q")?.slice(0, 100) ?? null,
        plan: staff.caps.includes("billing.view") ? query.get("plan") : null,
        status: staff.caps.includes("billing.view") ? query.get("status") : null,
        suspended: flag(query.get("suspended")),
        sort: query.get("sort"),
      },
      admin.pageQuery(query),
      defaults,
    );
    audit(session, "view", "firme", { summary: `Companies, page ${page.page}`, filters: filtersOf(query, ["q", "plan", "status", "suspended", "sort", "page"]) });
    return { ...page, items: page.items.map((row) => presentCompany(row, staff)) };
  });

  route("GET", "/v1/admin/companies/:id", ({ session, params }) => {
    const staff = gate(session, "companies");
    const row = companyOr404(params.id!);
    const people = admin.companyPeople(db, row.id);
    audit(session, "view", `company:${row.id}`, { summary: `Company ${row.name}` });
    return {
      company: presentCompany(row, staff),
      members: people.members,
      invites: people.invites,
      runners: people.runners.map((runner) => ({ ...runner, online: relay.isOnline(runner.id) })),
      ...(staff.caps.includes("billing.view") ? { subscription: admin.subscriptionOf(db, row.id, defaults) } : {}),
    };
  });

  // ---- Conturi -------------------------------------------------------------------------------

  route("GET", "/v1/admin/accounts", ({ session, query }) => {
    gate(session, "accounts");
    const page = admin.accountsPage(
      db,
      { q: query.get("q")?.slice(0, 100) ?? null, twoFactor: flag(query.get("twofa")), suspended: flag(query.get("suspended")), companyId: query.get("company") },
      admin.pageQuery(query),
    );
    audit(session, "view", "conturi", { summary: `Accounts, page ${page.page}`, filters: filtersOf(query, ["q", "twofa", "suspended", "company", "page"]) });
    return { ...page, items: page.items.map((row) => ({ ...row, staff: admin.staffRolesOf(db, row, boot) })) };
  });

  // ---- Abonamente ----------------------------------------------------------------------------

  route("GET", "/v1/admin/subscriptions/:id", ({ session, params }) => {
    gate(session, "billing.view");
    const row = companyOr404(params.id!);
    audit(session, "view", `company:${row.id}`, { summary: `Subscription of ${row.name}` });
    return {
      company: { id: row.id, name: row.name, owner: row.owner, seatsUsed: row.seatsUsed, members: row.members },
      subscription: admin.subscriptionOf(db, row.id, defaults),
      history: admin.subscriptionHistory(db, row.id),
      payments: admin.paymentsOf(db, row.id, kit.billing.enabled),
      prices: admin.PLAN_PRICE,
    };
  });

  route("PUT", "/v1/admin/subscriptions/:id", ({ session, params, body }) => {
    gate(session, "billing.edit");
    const row = companyOr404(params.id!);
    let next: admin.SubscriptionInput;
    try {
      next = admin.normalizeSubscription({ ...body, plan: body.plan });
    } catch (error) {
      throw bad(error instanceof Error ? error.message : "Check the plan.");
    }
    const reason = (optStr(body, "reason", 500) ?? "").trim() || next.note;
    const { before, after } = admin.setSubscription(db, { companyId: row.id, next, actorUserId: session.user.id, action: "set", reason, defaults });
    audit(session, "plan.set", `company:${row.id}`, {
      summary: `${row.name}: ${before.plan}/${before.status} -> ${after.plan}/${after.status}, ${after.seats} seats at ${after.pricePerSeat} EUR`,
      before: before.set ? { plan: before.plan, status: before.status, seats: before.seats, pricePerSeat: before.pricePerSeat, periodEnd: before.periodEnd, invoiceRef: before.invoiceRef } : null,
      after: { plan: after.plan, status: after.status, seats: after.seats, pricePerSeat: after.pricePerSeat, periodStart: after.periodStart, periodEnd: after.periodEnd, trialEnd: after.trialEnd, invoiceRef: after.invoiceRef },
      reason,
    });
    return { subscription: after, history: admin.subscriptionHistory(db, row.id) };
  });

  route("POST", "/v1/admin/subscriptions/:id/trial", ({ session, params, body }) => {
    gate(session, "billing.edit");
    const row = companyOr404(params.id!);
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw bad("Extend the trial by 1 to 90 days.");
    const reason = reasonOf(body);
    const current = admin.subscriptionOf(db, row.id, defaults);
    if (current.plan === "free" || current.plan === "selfhost") throw bad("A free plan has no trial.");
    const from = current.trialEnd !== null && current.trialEnd > admin.today() ? current.trialEnd : admin.today();
    const trialEnd = admin.addDays(from, days);
    const next = admin.normalizeSubscription({ ...current, status: "trial", trialEnd });
    const { after } = admin.setSubscription(db, { companyId: row.id, next, actorUserId: session.user.id, action: "trial", reason, defaults });
    audit(session, "plan.trial", `company:${row.id}`, { summary: `${row.name}: trial until ${trialEnd} (+${days} days)`, days, trialEnd, before: current.trialEnd, reason });
    return { subscription: after, history: admin.subscriptionHistory(db, row.id) };
  });

  // ---- Suport --------------------------------------------------------------------------------

  route("POST", "/v1/admin/invites/:id/resend", async ({ session, params, body }) => {
    gate(session, "support");
    const reason = reasonOf(body);
    const renewed = admin.renewInvite(db, params.id!);
    if (renewed === null) throw notFound("No such open invitation.");
    if (!renewed.ok) throw bad("This is a link invitation with no e-mail; the company makes a new one.");
    const link = `${config.publicUrl}/invite#${renewed.token}`;
    await mailer.send({
      to: renewed.email,
      ...inviteMail(team.languageOfEmail(db, renewed.email), { inviterName: renewed.inviterName, companyName: renewed.companyName, role: renewed.role, email: renewed.email, link, publicUrl: config.publicUrl }),
    });
    audit(session, "invite.resend", `invite:${params.id!}`, { summary: `Invitation to ${renewed.companyName} sent again to ${renewed.email}`, companyId: renewed.companyId, email: renewed.email, reason });
    return { ok: true };
  });

  route("POST", "/v1/admin/accounts/:id/sessions/revoke", ({ session, params, body }) => {
    const staff = gate(session, "support");
    const account = accountOr404(params.id!);
    protectStaff(session, staff, account);
    const reason = reasonOf(body);
    const revoked = admin.revokeAllSessions(db, account.id);
    relay.broadcastDeviceRevoked(account.id, revoked.keyIds);
    audit(session, "sessions.revoke", `user:${account.id}`, { summary: `${account.email}: ${revoked.sessions} sessions ended`, email: account.email, sessions: revoked.sessions, deviceKeys: revoked.keyIds.length, reason });
    return { ok: true, sessions: revoked.sessions };
  });

  route("POST", "/v1/admin/accounts/:id/two-factor/reset", async ({ session, params, body }) => {
    const staff = gate(session, "support");
    const account = accountOr404(params.id!);
    protectStaff(session, staff, account);
    const reason = reasonOf(body);
    // The typed confirmation: the account's e-mail, exactly (case aside).
    const typed = str(body, "confirm", 254).trim().toLowerCase();
    if (typed !== account.email.toLowerCase()) throw new HttpError(400, "Type the account's e-mail address to confirm.", "confirm_mismatch");
    const had = security.totpState(db, account.id).enabled;
    security.disableTotp(db, account.id);
    const revoked = admin.revokeAllSessions(db, account.id);
    relay.broadcastDeviceRevoked(account.id, revoked.keyIds);
    await mailer.send({ to: account.email, ...twoFactorResetMail(team.languageOfEmail(db, account.email), { name: account.name, reason, publicUrl: config.publicUrl }) });
    audit(session, "twofactor.reset", `user:${account.id}`, { summary: `${account.email}: two-factor reset, ${revoked.sessions} sessions ended, e-mailed`, email: account.email, hadTwoFactor: had, sessions: revoked.sessions, reason });
    return { ok: true, sessions: revoked.sessions };
  });

  const suspendAccount = (suspend: boolean) => ({ session, params, body }: { session: SessionInfo; params: Record<string, string>; body: Json }) => {
    const staff = gate(session, "support");
    const account = accountOr404(params.id!);
    protectStaff(session, staff, account);
    const reason = reasonOf(body);
    if (suspend === (account.suspendedAt !== null)) throw bad(suspend ? "This account is already suspended." : "This account is not suspended.");
    admin.setUserSuspended(db, account.id, suspend ? reason : null);
    let sessions = 0;
    if (suspend) {
      const revoked = admin.revokeAllSessions(db, account.id);
      sessions = revoked.sessions;
      relay.broadcastDeviceRevoked(account.id, revoked.keyIds);
      for (const environmentId of admin.environmentsOwnedBy(db, account.id)) relay.disconnect(environmentId);
    }
    audit(session, suspend ? "account.suspend" : "account.unsuspend", `user:${account.id}`, {
      summary: `${account.email} ${suspend ? `suspended (${sessions} sessions ended)` : "can sign in again"}`,
      email: account.email,
      reason,
    });
    return { ok: true };
  };
  route("POST", "/v1/admin/accounts/:id/suspend", suspendAccount(true));
  route("POST", "/v1/admin/accounts/:id/unsuspend", suspendAccount(false));

  const suspendCompany = (suspend: boolean) => ({ session, params, body }: { session: SessionInfo; params: Record<string, string>; body: Json }) => {
    gate(session, "support");
    const row = companyOr404(params.id!);
    const reason = reasonOf(body);
    if (suspend === (row.suspended !== null)) throw bad(suspend ? "This company is already suspended." : "This company is not suspended.");
    admin.setCompanySuspended(db, row.id, suspend ? reason : null);
    audit(session, suspend ? "company.suspend" : "company.unsuspend", `company:${row.id}`, { summary: `${row.name} ${suspend ? "suspended: its runners refuse every request" : "active again"}`, reason });
    return { ok: true };
  };
  route("POST", "/v1/admin/companies/:id/suspend", suspendCompany(true));
  route("POST", "/v1/admin/companies/:id/unsuspend", suspendCompany(false));

  // ---- Bibliotecă: the platform staff (reviewers and the rest) ------------------------------

  route("GET", "/v1/admin/staff", ({ session }) => {
    gate(session, "staff");
    return { staff: admin.listStaff(db, boot), roles: admin.STAFF_ROLES, caps: admin.ROLE_CAPS };
  });

  route("PUT", "/v1/admin/staff", ({ session, body }) => {
    gate(session, "staff");
    const email = str(body, "email", 254).trim().toLowerCase();
    const roleName = str(body, "role", 20);
    if (!(admin.STAFF_ROLES as ReadonlyArray<string>).includes(roleName)) throw bad("Choose a role: operator, reviewer or support.");
    const role = roleName as admin.StaffRole;
    const user = admin.userByEmail(db, email);
    if (user === null) throw notFound("No account with that e-mail. Ask them to sign in to the hub once.");
    if (user.id === session.user.id) throw bad("You cannot change your own staff role.");
    const before = admin.setStaffRole(db, user.id, role, session.user.id);
    audit(session, "staff.set", `user:${user.id}`, { summary: `${user.email} is now ${role}${before === null ? "" : ` (was ${before})`}`, email: user.email, role, before });
    return { staff: admin.listStaff(db, boot) };
  });

  route("DELETE", "/v1/admin/staff/:userId", ({ session, params }) => {
    gate(session, "staff");
    const user = accountOr404(params.userId!);
    if (user.id === session.user.id) throw bad("You cannot remove yourself from the staff.");
    const before = admin.removeStaff(db, user.id);
    if (before === null) throw notFound("Not on the staff list (people set by environment variables are changed there).");
    audit(session, "staff.remove", `user:${user.id}`, { summary: `${user.email} is no longer ${before}`, email: user.email, before });
    return { staff: admin.listStaff(db, boot) };
  });

  // ---- Jurnal admin --------------------------------------------------------------------------

  const journalFilter = (query: URLSearchParams): admin.JournalFilter => ({
    q: query.get("q")?.slice(0, 100) ?? null,
    action: query.get("action")?.slice(0, 80) ?? null,
    actor: query.get("actor")?.slice(0, 254) ?? null,
    from: query.get("from"),
    to: query.get("to"),
  });

  route("GET", "/v1/admin/journal", ({ session, query }) => {
    gate(session, "journal");
    // The view is written first, so the page shows its own visit at the top.
    audit(session, "view", "jurnal", { summary: "Admin journal", filters: filtersOf(query, ["q", "action", "actor", "from", "to", "page"]) });
    const page = admin.journalPage(auditLog.db, journalFilter(query), admin.pageQuery(query, 50), (seqs) => auditLog.eventsBySeq(seqs));
    return { ...page, items: page.items.map(presentEvent), actions: admin.journalActions(auditLog.db) };
  });

  route("GET", "/v1/admin/journal/export", ({ session, query }) => {
    gate(session, "journal");
    const format = query.get("format") === "csv" ? "csv" : "json";
    const events = auditLog.eventsBySeq(admin.journalSeqs(auditLog.db, journalFilter(query), 10_000)).toReversed();
    audit(session, "journal.export", "jurnal", { summary: `Admin journal exported (${format}, ${events.length} rows)`, format, rows: events.length, filters: filtersOf(query, ["q", "action", "actor", "from", "to"]) });
    const filename = `jurnal-platforma-${admin.today()}.${format}`;
    if (format === "csv") return { filename, contentType: "text/csv; charset=utf-8", body: toCsv(events) };
    return {
      filename,
      contentType: "application/json",
      body: JSON.stringify({ chain: PLATFORM_CHAIN, exportedAt: new Date().toISOString(), algorithm: "sha256(prev_hash + canonical_json(row))", events: events.map(presentEvent) }, null, 2),
    };
  });

  route("GET", "/v1/admin/journal/verify", ({ session }) => {
    gate(session, "journal");
    const result = admin.verifyPlatformChain(auditLog.db, db);
    audit(session, "journal.verify", "jurnal", { summary: `Chain checked: ${result.ok ? "intact" : "broken"} (${result.checked} rows)`, ok: result.ok });
    return result;
  });
}
