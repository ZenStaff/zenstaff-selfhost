// Authorization rules, as pure functions over plain records. Every route goes through these; the
// tests in test/policy.test.ts pin them. The runner re-checks the rules it can see (see docs).

export type Role = "owner" | "admin" | "member" | "guest";
export const ROLES: ReadonlyArray<Role> = ["owner", "admin", "member", "guest"];

export type ShareKind = "personal" | "company" | "handover";

export interface ShareRecord {
  readonly id: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly companyId: string;
  readonly kind: ShareKind;
  /** null = everyone in the company except guests. */
  readonly audienceUserId: string | null;
  readonly handoverState: "pending" | "completed" | "declined" | null;
  readonly revokedAt: string | null;
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly ownerUserId: string;
  /**
   * The companies this environment is the runner of (v9: one machine may serve several companies,
   * each with its own AI account, staff, memory scope and sealing context).
   */
  readonly runnerCompanyIds: ReadonlyArray<string>;
}

/** The caller's role in a company, or null when not a member. */
export type MembershipLookup = (companyId: string) => Role | null;

const rank: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

export function isMember(role: Role | null): role is Role {
  return role !== null;
}

/** Full members can write in company chats and see company-wide shares; guests cannot. */
export function isFullMember(role: Role | null): boolean {
  return role !== null && rank[role] >= rank.member;
}

export function canManageCompany(role: Role | null): boolean {
  return role !== null && rank[role] >= rank.admin;
}

// ---- Companies and members -------------------------------------------------------------------

export function canInvite(inviter: Role | null, invitedRole: Role): boolean {
  if (!canManageCompany(inviter) || invitedRole === "owner") return false;
  // Admins invite members and guests; only owners create admins.
  return invitedRole === "admin" ? inviter === "owner" : true;
}

export function canChangeRole(input: {
  readonly actor: Role | null;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly targetRole: Role;
  readonly newRole: Role;
  readonly ownerCount: number;
}): boolean {
  const { actor, targetRole, newRole } = input;
  if (!canManageCompany(actor)) return false;
  if (targetRole === "owner" && newRole !== "owner" && input.ownerCount <= 1) return false;
  if (actor === "owner") return true;
  // Admins manage members and guests only, and cannot promote above member.
  if (input.actorUserId === input.targetUserId) return false;
  return rank[targetRole] <= rank.member && rank[newRole] <= rank.member;
}

export function canRemoveMember(input: {
  readonly actor: Role | null;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly targetRole: Role;
  readonly ownerCount: number;
}): boolean {
  if (input.actorUserId === input.targetUserId) {
    // Anyone may leave, except the last owner.
    return !(input.targetRole === "owner" && input.ownerCount <= 1);
  }
  if (!canManageCompany(input.actor)) return false;
  if (input.targetRole === "owner") return input.actor === "owner" && input.ownerCount > 1;
  return input.actor === "owner" || rank[input.targetRole] <= rank.member;
}

// ---- Environments and runners ----------------------------------------------------------------

/** A machine becomes a company runner only by its own owner, who must manage the company. */
export function canRegisterRunner(input: {
  readonly actorUserId: string;
  readonly environment: EnvironmentRecord;
  readonly role: Role | null;
}): boolean {
  return input.environment.ownerUserId === input.actorUserId && canManageCompany(input.role);
}

// ---- Shares ----------------------------------------------------------------------------------

export type ShareCreateDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function canCreateShare(input: {
  readonly actorUserId: string;
  readonly kind: ShareKind;
  readonly environment: EnvironmentRecord;
  readonly companyId: string;
  readonly actorRole: Role | null;
  readonly audienceUserId: string | null;
  readonly audienceRole: Role | null;
}): ShareCreateDecision {
  const { environment, kind } = input;
  if (environment.ownerUserId !== input.actorUserId) {
    return { ok: false, reason: "Only the owner of this machine can share its chats." };
  }
  if (!isMember(input.actorRole)) {
    return { ok: false, reason: "You are not a member of this company." };
  }
  if (input.audienceUserId !== null && !isMember(input.audienceRole)) {
    return { ok: false, reason: "That person is not a member of this company." };
  }
  if (input.audienceUserId === input.actorUserId) {
    return { ok: false, reason: "You cannot share a chat with yourself." };
  }
  switch (kind) {
    case "personal":
      return { ok: true };
    case "company":
      if (!environment.runnerCompanyIds.includes(input.companyId)) {
        return {
          ok: false,
          reason: "Company chats run on a runner of that company. Register this machine first.",
        };
      }
      if (!isFullMember(input.actorRole)) {
        return { ok: false, reason: "Guests cannot create company chats." };
      }
      return { ok: true };
    case "handover":
      if (input.audienceUserId === null) {
        return { ok: false, reason: "Hand over needs one colleague." };
      }
      if (!isFullMember(input.audienceRole)) {
        return { ok: false, reason: "Chats can be handed over to members, not guests." };
      }
      return { ok: true };
  }
}

function isLive(share: ShareRecord): boolean {
  return share.revokedAt === null;
}

/** Who sees the chat live (and its comments). */
export function canViewShare(
  userId: string,
  share: ShareRecord,
  roleIn: MembershipLookup,
): boolean {
  if (!isLive(share)) return false;
  const role = roleIn(share.companyId);
  if (share.ownerUserId === userId) return isMember(role);
  if (!isMember(role)) return false;
  if (share.kind === "handover") {
    return share.audienceUserId === userId && share.handoverState === "pending";
  }
  if (share.audienceUserId !== null) return share.audienceUserId === userId;
  // Company-wide: full members only; a guest sees only what was shared with them by name.
  return isFullMember(role);
}

export function canCommentShare(
  userId: string,
  share: ShareRecord,
  roleIn: MembershipLookup,
): boolean {
  return share.kind !== "handover" && canViewShare(userId, share, roleIn);
}

/**
 * Who may send a prompt to the agent through the hub.
 * - Personal chats: only the person whose account runs them (from their own phone or browser).
 *   Never a colleague, whatever their role.
 * - Company chats: owners and admins only, and only while the chat runs on that company's runner.
 *   Members do not start or write free chats on the company server (decision 08.11.2026): their
 *   work there starts as a task for the company's AI staff, and they follow it read-only.
 * - Guests: never.
 */
export function canPromptShare(
  userId: string,
  share: ShareRecord,
  environment: EnvironmentRecord,
  roleIn: MembershipLookup,
): boolean {
  if (!canViewShare(userId, share, roleIn)) return false;
  if (environment.id !== share.environmentId) return false;
  const role = roleIn(share.companyId);
  if (share.kind === "personal") {
    return userId === share.ownerUserId && userId === environment.ownerUserId;
  }
  if (share.kind === "company") {
    return environment.runnerCompanyIds.includes(share.companyId) && canManageCompany(role);
  }
  return false;
}

/** "Continue on my side": a copy of the history into the caller's own environment. */
export function canCopyShare(
  userId: string,
  share: ShareRecord,
  roleIn: MembershipLookup,
): boolean {
  return canViewShare(userId, share, roleIn) && share.ownerUserId !== userId;
}

export function canAcceptHandover(
  userId: string,
  share: ShareRecord,
  roleIn: MembershipLookup,
): boolean {
  return (
    share.kind === "handover" &&
    share.handoverState === "pending" &&
    share.audienceUserId === userId &&
    isFullMember(roleIn(share.companyId)) &&
    isLive(share)
  );
}

export function canRevokeShare(userId: string, share: ShareRecord, roleIn: MembershipLookup) {
  return share.ownerUserId === userId || canManageCompany(roleIn(share.companyId));
}

/** What the caller may do with a share, for the client to show the right buttons. */
export function sharePermissions(
  userId: string,
  share: ShareRecord,
  environment: EnvironmentRecord,
  roleIn: MembershipLookup,
) {
  return {
    view: canViewShare(userId, share, roleIn),
    comment: canCommentShare(userId, share, roleIn),
    prompt: canPromptShare(userId, share, environment, roleIn),
    copy: canCopyShare(userId, share, roleIn),
    acceptHandover: canAcceptHandover(userId, share, roleIn),
    revoke: canRevokeShare(userId, share, roleIn),
  };
}

// ---- Two-factor authentication --------------------------------------------------------------

/** Owners and admins of any company must use two-factor authentication; members may. */
export function requiresTwoFactor(roles: ReadonlyArray<Role>): boolean {
  return roles.some((role) => role === "owner" || role === "admin");
}

/**
 * What a session may do: everything ("ok"), or only the sign-in routes until the person sets up
 * two-factor authentication ("enroll") or enters a code on this session ("verify").
 */
export function twoFactorGate(input: {
  readonly roles: ReadonlyArray<Role>;
  readonly totpEnabled: boolean;
  readonly sessionVerified: boolean;
}): "ok" | "enroll" | "verify" {
  if (input.totpEnabled) return input.sessionVerified ? "ok" : "verify";
  return requiresTwoFactor(input.roles) ? "enroll" : "ok";
}

/** Only people who are not required to keep two-factor authentication can switch it off. */
export function canDisableTwoFactor(roles: ReadonlyArray<Role>): boolean {
  return !requiresTwoFactor(roles);
}

// ---- Grants, settings, team views -----------------------------------------------------------

/** Enterprise pack grants and install approvals: owners and admins. */
export function canManageGrants(role: Role | null): boolean {
  return canManageCompany(role);
}

/** Company memory "Forget this" (GDPR erasure) and memory settings: owners and admins. */
export function canAdministerMemory(role: Role | null): boolean {
  return canManageCompany(role);
}

/** Team-wide Academy progress and signals: owners and admins; everyone sees their own. */
export function canSeeTeamProgress(role: Role | null): boolean {
  return canManageCompany(role);
}

/** The AI account a company runner uses: its own owner, who must manage the company. */
export function canSetRunnerAccount(input: {
  readonly actorUserId: string;
  readonly environment: EnvironmentRecord;
  readonly companyId: string;
  readonly companyRole: Role | null;
}): boolean {
  return (
    input.environment.ownerUserId === input.actorUserId &&
    input.environment.runnerCompanyIds.includes(input.companyId) &&
    canManageCompany(input.companyRole)
  );
}

/** Who is told about a new share: the named person, or every full member except the owner. */
export function shareAudience(
  share: Pick<ShareRecord, "ownerUserId" | "audienceUserId">,
  fullMemberIds: ReadonlyArray<string>,
): Array<string> {
  if (share.audienceUserId !== null) {
    return share.audienceUserId === share.ownerUserId ? [] : [share.audienceUserId];
  }
  return fullMemberIds.filter((id) => id !== share.ownerUserId);
}

// ---- Company AI staff and company packs (v6) -------------------------------------------------

/**
 * Who may write an AI employee's profile. Owners and admins create, change and delete any of
 * them. The agent's manager (a full member) may change the profile of an agent they already
 * manage, but cannot create or delete one, nor hand the agent to someone else.
 */
export function canEditStaff(input: {
  readonly role: Role | null;
  readonly actorUserId: string;
  /** The stored record, or null when this write creates the agent. */
  readonly existing: { readonly managerUserId: string | null; readonly deleted: boolean } | null;
  readonly managerUserId: string | null;
  readonly deleted: boolean;
}): boolean {
  if (canManageCompany(input.role)) return true;
  if (!isFullMember(input.role)) return false;
  const existing = input.existing;
  return (
    existing !== null &&
    !existing.deleted &&
    !input.deleted &&
    existing.managerUserId === input.actorUserId &&
    input.managerUserId === input.actorUserId
  );
}

/** Reading the (sealed) staff list and giving an agent a task: full members, not guests. */
export function canUseStaff(role: Role | null): boolean {
  return isFullMember(role);
}

/** Installing a pack for the whole company (and removing it): owners and admins. */
export function canManageCompanyPacks(role: Role | null): boolean {
  return canManageCompany(role);
}

/** Every member's app reports its own install status; admins see everyone's. */
export function canSeeAllPackStatus(role: Role | null): boolean {
  return canManageCompany(role);
}
