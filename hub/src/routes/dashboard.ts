// Read endpoints for the web dashboard (/app), plus the company profile (name and details for
// invoicing). They summarize what the hub already keeps: records, routing and times. AI staff
// profiles stay sealed to the company runners, so the dashboard lists ids, versions and managers.
import type { Kit } from "../app.ts";
import { bad, forbidden, type Json, obj, optStr } from "../http.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import { PRICES } from "../billing/plan.ts";
import { isValidRoCui } from "../billing/taxId.ts";
import { fingerprintOf } from "../signing.ts";
import * as store from "../store.ts";
import * as roles from "../storeRbac.ts";
import * as companyStore from "../storeCompany.ts";
import * as dashboard from "../storeDashboard.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";

/** The hosted plan's price, shown on the Plan page; payments are not built yet (trial). */
export const HOSTED_PRICE_EUR_PER_SEAT = PRICES.seatEur;

const TAX_ID = /^(RO)?[0-9]{2,10}$|^[A-Z]{2}[0-9A-Z+*]{2,13}$/;

/** Validates the company details form; empty strings clear a field. */
export function parseDetails(input: Json): dashboard.CompanyDetails {
  const text = (key: string, max: number) => {
    const value = optStr(input, key, max);
    return value === null || value === "" ? null : value;
  };
  const taxRaw = text("taxId", 20);
  const taxId = taxRaw === null ? null : taxRaw.replace(/\s+/g, "").toUpperCase();
  if (taxId !== null && (!TAX_ID.test(taxId) || (taxId.startsWith("RO") && !/^RO[0-9]+$/.test(taxId)))) throw bad("CUI must be digits, optionally starting with RO (e.g. RO12345678).");
  if (taxId !== null && /^(RO)?[0-9]+$/.test(taxId) && !isValidRoCui(taxId)) throw bad("This CUI is not valid (check digit).");
  const emailRaw = text("billingEmail", 254);
  const billingEmail = emailRaw === null ? null : store.normalizeEmail(emailRaw);
  if (emailRaw !== null && billingEmail === null) throw bad("Enter a valid billing e-mail address.");
  return {
    legalName: text("legalName", 160),
    taxId,
    registryNo: text("registryNo", 40),
    address: text("address", 300),
    city: text("city", 80),
    county: text("county", 80),
    country: text("country", 60),
    billingEmail,
  };
}

const billingAccess = (state: { access: string; reason: string; graceEndsAt: number | null }) => ({
  access: state.access,
  reason: state.reason,
  graceEndsAt: state.graceEndsAt === null ? null : new Date(state.graceEndsAt).toISOString(),
});

export function registerDashboardRoutes(kit: Kit) {
  const { db, config, route, relay, requireRole, billing } = kit;
  const accessIn = (companyId: string, userId: string) => roles.accessOf(db, companyId, userId);

  route("GET", "/v1/companies/:id/overview", ({ session, params }) => {
    const companyId = params.id!;
    const myRole = requireRole(companyId, session.user.id);
    const access = accessIn(companyId, session.user.id);
    const manager = policy.canManageCompany(myRole);
    const full = policy.isFullMember(myRole);
    const seesStaff = policy.canUseStaff(myRole) && rbac.can(access, "angajati:vede");
    const seesBilling = rbac.can(access, "facturare:vede");
    const members = store.membersOf(db, companyId);
    const byRole = { owner: 0, admin: 0, member: 0, guest: 0 } as Record<policy.Role, number>;
    for (const member of members) byRole[member.role] += 1;
    const runners = store.runnersOf(db, companyId).map((runner) => {
      const account = team.aiAccountOf(db, runner.id, companyId);
      return {
        id: runner.id,
        name: runner.name,
        ownerName: runner.ownerName,
        online: relay.isOnline(runner.id),
        lastSeenAt: runner.lastSeenAt,
        aiAccount: account === null ? null : { provider: account.provider, mode: account.mode, label: account.label },
      };
    });
    const staff = seesStaff ? companyStore.staffOf(db, companyId).filter((item) => item.deletedAt === null) : [];
    const packs = rbac.can(access, "pachete:vede") ? companyStore.packsOf(db, companyId) : [];
    const status = companyStore.packStatusOf(db, companyId, policy.canSeeAllPackStatus(myRole) ? null : session.user.id);
    const devices = dashboard.devicesWaiting(db, companyId, manager ? null : session.user.id);
    const company = store.getCompany(db, companyId)!;
    const kind = config.plan ?? "selfhost";
    return {
      company: { ...company, details: full && seesBilling ? dashboard.companyDetails(db, companyId) : null },
      role: myRole,
      access,
      plan: {
        kind,
        /** Hosted: the subscription status (none = not paying yet); self-host: none. */
        status: billing.statusOf(companyId),
        ...billingAccess(billing.access(companyId)),
        seats: byRole.owner + byRole.admin + byRole.member,
        guests: byRole.guest,
        pricePerSeatEur: kind === "hosted" ? HOSTED_PRICE_EUR_PER_SEAT : 0,
      },
      members: {
        total: members.length,
        byRole,
        withoutTwoFactor: manager ? members.filter((member) => !security.totpState(db, member.userId).enabled).length : null,
      },
      invites: { pending: manager ? store.pendingInvites(db, companyId).length : null },
      runners,
      staff: {
        visible: seesStaff,
        total: staff.length,
        items: staff.slice(0, 12).map((item) => ({
          staffId: item.staffId,
          version: item.version,
          managerName: item.managerUserId === null ? null : (store.getUser(db, item.managerUserId)?.name ?? null),
          updatedAt: item.updatedAt,
        })),
      },
      packs: {
        total: packs.length,
        installing: status.filter((row) => row.state === "installing" && !row.hidden).length,
        failed: status
          .filter((row) => row.state === "failed" && !row.hidden)
          .map((row) => ({ packId: row.packId, environmentName: row.environmentName, userName: row.userName, error: row.error, updatedAt: row.updatedAt })),
      },
      approvals: {
        devices: devices.map((device) => ({
          keyId: device.keyId,
          userName: device.userName,
          email: device.email,
          deviceLabel: device.deviceLabel,
          runnerName: device.runnerName,
          reportedAt: device.reportedAt,
          fingerprint: fingerprintOf(device.signPublicKey),
        })),
        handovers: dashboard.handoversWaiting(db, companyId, session.user.id),
      },
      activity: full ? dashboard.weekActivity(db, companyId) : null,
      trend: full ? dashboard.trend(db, companyId, manager ? null : session.user.id) : null,
    };
  });

  /** The company's AI staff without the sealed profiles: ids, versions, managers, runners, times. */
  route("GET", "/v1/companies/:id/staff/summary", ({ session, params }) => {
    const companyId = params.id!;
    if (!policy.canUseStaff(requireRole(companyId, session.user.id))) throw forbidden("Guests do not see the company's AI staff.");
    kit.requirePermission(companyId, session.user.id, "angajati:vede");
    const runnerNames = new Map(store.runnersOf(db, companyId).map((runner) => [runner.id, runner.name]));
    return {
      staff: companyStore
        .staffOf(db, companyId)
        .filter((item) => item.deletedAt === null)
        .map((item) => ({
          staffId: item.staffId,
          version: item.version,
          managerUserId: item.managerUserId,
          managerName: item.managerUserId === null ? null : (store.getUser(db, item.managerUserId)?.name ?? null),
          updatedByName: item.updatedByName,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          projectId: item.projectId,
          runners: Object.keys(item.sealed).map((environmentId) => ({
            environmentId,
            name: runnerNames.get(environmentId) ?? null,
            online: relay.isOnline(environmentId),
          })),
        })),
    };
  });

  /** Rename the company and keep its details for invoicing (owners and admins). */
  route("PATCH", "/v1/companies/:id", ({ session, params, body }) => {
    const companyId = params.id!;
    const myRole = requireRole(companyId, session.user.id);
    // Renaming: owners and admins. The invoicing details: anyone whose role has "facturare:
    // administrează" (owners, admins, or a custom role such as Contabilitate).
    if (body.name !== undefined && !policy.canManageCompany(myRole)) throw forbidden("Only owners and admins change the company's details.");
    if (body.details !== undefined) kit.requirePermission(companyId, session.user.id, "facturare:administreaza");
    if (body.name === undefined && body.details === undefined && !policy.canManageCompany(myRole)) throw forbidden("Only owners and admins change the company's details.");
    const name = optStr(body, "name", 80);
    if (body.name !== undefined && (name === null || name === "")) throw bad("name is required.");
    const details = body.details === undefined ? undefined : parseDetails(obj(body, "details"));
    if (name === null && details === undefined) throw bad("Send a name or details.");
    const before = store.getCompany(db, companyId)!;
    dashboard.setCompanyProfile(db, companyId, { ...(name === null ? {} : { name }), ...(details === undefined ? {} : { details }) });
    const changes = [
      ...(name !== null && name !== before.name ? [`renamed from "${before.name}" to "${name}"`] : []),
      ...(details === undefined ? [] : ["details for invoicing updated"]),
    ];
    if (changes.length > 0) team.audit(db, { companyId, actorUserId: session.user.id, action: "company.profile", detail: `Company ${changes.join("; ")}` });
    return { company: store.getCompany(db, companyId), details: dashboard.companyDetails(db, companyId) };
  });

  /** The person's own account events (passkeys); company events: /v1/companies/:id/audit. */
  route("GET", "/v1/me/audit", ({ session }) => ({ entries: dashboard.accountAuditOf(db, session.user.id) }));
}
