import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as policy from "../src/policy.ts";
import type { EnvironmentRecord, Role, ShareRecord } from "../src/policy.ts";

const ACME = "co_acme";
const OTHER = "co_other";

const roles: Record<string, Partial<Record<string, Role>>> = {
  alex: { [ACME]: "owner" },
  maria: { [ACME]: "member" },
  admin: { [ACME]: "admin" },
  gina: { [ACME]: "guest" },
  olga: { [OTHER]: "owner" },
};
const lookup = (userId: string) => (companyId: string) => roles[userId]?.[companyId] ?? null;

const alexLaptop: EnvironmentRecord = { id: "env_alex", ownerUserId: "alex", runnerCompanyIds: [] };
const acmeRunner: EnvironmentRecord = { id: "env_alex", ownerUserId: "alex", runnerCompanyIds: [ACME] };

const share = (overrides: Partial<ShareRecord> = {}): ShareRecord => ({
  id: "sh_1",
  environmentId: "env_alex",
  threadId: "thread-1",
  ownerUserId: "alex",
  companyId: ACME,
  kind: "personal",
  audienceUserId: null,
  handoverState: null,
  revokedAt: null,
  ...overrides,
});

describe("personal chats are never promptable by others", () => {
  for (const env of [alexLaptop, acmeRunner]) {
    for (const audience of [null, "maria", "admin", "gina"]) {
      it(`audience=${audience ?? "company"} runner=${env.runnerCompanyIds[0] ?? "none"}`, () => {
        const s = share({ kind: "personal", audienceUserId: audience });
        for (const userId of ["maria", "admin", "gina", "olga"]) {
          assert.equal(policy.canPromptShare(userId, s, env, lookup(userId)), false, userId);
        }
      });
    }
  }

  it("the owner of the account may prompt their own chat from another device", () => {
    assert.equal(policy.canPromptShare("alex", share(), alexLaptop, lookup("alex")), true);
  });

  it("a company owner cannot prompt a member's personal chat", () => {
    const mariaShare = share({ ownerUserId: "maria", environmentId: "env_maria" });
    const mariaEnv: EnvironmentRecord = { id: "env_maria", ownerUserId: "maria", runnerCompanyIds: [] };
    assert.equal(policy.canPromptShare("alex", mariaShare, mariaEnv, lookup("alex")), false);
    assert.equal(policy.canViewShare("alex", mariaShare, lookup("alex")), true);
  });
});

describe("personal chat sharing: live view, comments, copy", () => {
  it("company-wide share: members view, comment and copy; guests do not see it", () => {
    const s = share();
    for (const userId of ["maria", "admin"]) {
      assert.equal(policy.canViewShare(userId, s, lookup(userId)), true);
      assert.equal(policy.canCommentShare(userId, s, lookup(userId)), true);
      assert.equal(policy.canCopyShare(userId, s, lookup(userId)), true);
    }
    assert.equal(policy.canViewShare("gina", s, lookup("gina")), false);
  });

  it("share with one person: only that person (a guest too) sees it", () => {
    const toGina = share({ audienceUserId: "gina" });
    assert.equal(policy.canViewShare("gina", toGina, lookup("gina")), true);
    assert.equal(policy.canPromptShare("gina", toGina, alexLaptop, lookup("gina")), false);
    assert.equal(policy.canViewShare("maria", toGina, lookup("maria")), false);
  });

  it("revoked shares are invisible to everyone but stay unpromptable", () => {
    const revoked = share({ revokedAt: "2026-01-01T00:00:00Z" });
    for (const userId of ["alex", "maria", "admin"]) {
      assert.equal(policy.canViewShare(userId, revoked, lookup(userId)), false);
      assert.equal(policy.canPromptShare(userId, revoked, alexLaptop, lookup(userId)), false);
    }
  });

  it("the owner does not copy their own chat", () => {
    assert.equal(policy.canCopyShare("alex", share(), lookup("alex")), false);
  });
});

describe("company chats", () => {
  const companyShare = share({ kind: "company" });

  it("owners and admins write while it runs on the company runner; members do not (decision 08.11.2026)", () => {
    for (const userId of ["alex", "admin"]) {
      assert.equal(policy.canPromptShare(userId, companyShare, acmeRunner, lookup(userId)), true);
    }
    assert.equal(policy.canPromptShare("maria", companyShare, acmeRunner, lookup("maria")), false);
    assert.equal(policy.canViewShare("maria", companyShare, lookup("maria")), true);
  });

  it("one machine serving several companies writes only the chats of the companies it serves", () => {
    const both: EnvironmentRecord = { ...acmeRunner, runnerCompanyIds: [OTHER, ACME] };
    assert.equal(policy.canPromptShare("alex", companyShare, both, lookup("alex")), true);
    const otherShare = share({ kind: "company", companyId: OTHER });
    // Alex is not in OTHER: serving it does not make him a writer there.
    assert.equal(policy.canPromptShare("alex", otherShare, both, lookup("alex")), false);
  });

  it("a guest cannot prompt, even when the chat is shared with them by name", () => {
    const toGina = share({ kind: "company", audienceUserId: "gina" });
    assert.equal(policy.canViewShare("gina", toGina, lookup("gina")), true);
    assert.equal(policy.canPromptShare("gina", toGina, acmeRunner, lookup("gina")), false);
  });

  it("nobody writes once the machine stops being the company's runner", () => {
    for (const userId of ["alex", "maria"]) {
      assert.equal(policy.canPromptShare(userId, companyShare, alexLaptop, lookup(userId)), false);
    }
  });

  it("a runner of another company does not make the chat writable", () => {
    const otherRunner: EnvironmentRecord = { ...acmeRunner, runnerCompanyIds: [OTHER] };
    assert.equal(policy.canPromptShare("maria", companyShare, otherRunner, lookup("maria")), false);
  });

  it("company chats can only be created on that company's runner, not by guests", () => {
    const base = {
      actorUserId: "alex",
      kind: "company" as const,
      companyId: ACME,
      actorRole: "owner" as Role,
      audienceUserId: null,
      audienceRole: null,
    };
    assert.equal(policy.canCreateShare({ ...base, environment: alexLaptop }).ok, false);
    assert.equal(policy.canCreateShare({ ...base, environment: acmeRunner }).ok, true);
    const ginaRunner: EnvironmentRecord = { id: "env_gina", ownerUserId: "gina", runnerCompanyIds: [ACME] };
    assert.equal(
      policy.canCreateShare({ ...base, actorUserId: "gina", actorRole: "guest", environment: ginaRunner }).ok,
      false,
    );
  });
});

describe("cross-company isolation", () => {
  it("members of another company see nothing", () => {
    for (const kind of ["personal", "company"] as const) {
      const s = share({ kind });
      assert.equal(policy.canViewShare("olga", s, lookup("olga")), false);
      assert.equal(policy.canCommentShare("olga", s, lookup("olga")), false);
      assert.equal(policy.canCopyShare("olga", s, lookup("olga")), false);
      assert.equal(policy.canPromptShare("olga", s, acmeRunner, lookup("olga")), false);
    }
  });

  it("a share addressed to an outsider is refused at creation", () => {
    const decision = policy.canCreateShare({
      actorUserId: "alex",
      kind: "personal",
      environment: alexLaptop,
      companyId: ACME,
      actorRole: "owner",
      audienceUserId: "olga",
      audienceRole: null,
    });
    assert.equal(decision.ok, false);
  });

  it("nobody shares another person's machine", () => {
    const decision = policy.canCreateShare({
      actorUserId: "maria",
      kind: "personal",
      environment: alexLaptop,
      companyId: ACME,
      actorRole: "member",
      audienceUserId: null,
      audienceRole: null,
    });
    assert.equal(decision.ok, false);
  });

  it("a user removed from the company loses access to its shares", () => {
    const formerLookup = () => null;
    assert.equal(policy.canViewShare("maria", share(), formerLookup), false);
    assert.equal(policy.canPromptShare("maria", share({ kind: "company" }), acmeRunner, formerLookup), false);
  });
});

describe("hand over", () => {
  const handover = share({ kind: "handover", audienceUserId: "maria", handoverState: "pending" });

  it("only the named colleague sees and accepts it, nobody prompts it", () => {
    assert.equal(policy.canAcceptHandover("maria", handover, lookup("maria")), true);
    assert.equal(policy.canAcceptHandover("admin", handover, lookup("admin")), false);
    assert.equal(policy.canViewShare("admin", handover, lookup("admin")), false);
    for (const userId of ["maria", "admin"]) {
      assert.equal(policy.canPromptShare(userId, handover, acmeRunner, lookup(userId)), false);
    }
  });

  it("is not accepted twice and not handed to guests", () => {
    const done = { ...handover, handoverState: "completed" as const };
    assert.equal(policy.canAcceptHandover("maria", done, lookup("maria")), false);
    const decision = policy.canCreateShare({
      actorUserId: "alex",
      kind: "handover",
      environment: alexLaptop,
      companyId: ACME,
      actorRole: "owner",
      audienceUserId: "gina",
      audienceRole: "guest",
    });
    assert.equal(decision.ok, false);
  });
});

describe("company administration", () => {
  it("invitations by role", () => {
    assert.equal(policy.canInvite("owner", "admin"), true);
    assert.equal(policy.canInvite("admin", "admin"), false);
    assert.equal(policy.canInvite("admin", "member"), true);
    assert.equal(policy.canInvite("member", "guest"), false);
    assert.equal(policy.canInvite("owner", "owner"), false);
    assert.equal(policy.canInvite(null, "member"), false);
  });

  it("the last owner cannot be demoted or leave", () => {
    const base = { actor: "owner" as Role, actorUserId: "alex", targetUserId: "alex", targetRole: "owner" as Role };
    assert.equal(policy.canChangeRole({ ...base, newRole: "admin", ownerCount: 1 }), false);
    assert.equal(policy.canChangeRole({ ...base, newRole: "admin", ownerCount: 2 }), true);
    assert.equal(policy.canRemoveMember({ ...base, ownerCount: 1 }), false);
  });

  it("admins manage members and guests only", () => {
    const base = { actor: "admin" as Role, actorUserId: "admin", ownerCount: 1 };
    assert.equal(policy.canChangeRole({ ...base, targetUserId: "maria", targetRole: "member", newRole: "guest" }), true);
    assert.equal(policy.canChangeRole({ ...base, targetUserId: "maria", targetRole: "member", newRole: "admin" }), false);
    assert.equal(policy.canChangeRole({ ...base, targetUserId: "alex", targetRole: "owner", newRole: "member" }), false);
    assert.equal(policy.canRemoveMember({ ...base, targetUserId: "alex", targetRole: "owner" }), false);
    assert.equal(policy.canRemoveMember({ ...base, targetUserId: "maria", targetRole: "member" }), true);
  });

  it("only the machine's owner, as company admin, registers it as runner", () => {
    assert.equal(policy.canRegisterRunner({ actorUserId: "alex", environment: alexLaptop, role: "owner" }), true);
    assert.equal(policy.canRegisterRunner({ actorUserId: "alex", environment: alexLaptop, role: "member" }), false);
    assert.equal(policy.canRegisterRunner({ actorUserId: "maria", environment: alexLaptop, role: "admin" }), false);
  });
});

describe("two-factor and admin rules", () => {
  it("owners and admins must use two-factor; members may", () => {
    assert.equal(policy.requiresTwoFactor(["member", "guest"]), false);
    assert.equal(policy.requiresTwoFactor(["member", "admin"]), true);
    assert.equal(policy.twoFactorGate({ roles: ["owner"], totpEnabled: false, sessionVerified: false }), "enroll");
    assert.equal(policy.twoFactorGate({ roles: ["owner"], totpEnabled: true, sessionVerified: false }), "verify");
    assert.equal(policy.twoFactorGate({ roles: ["owner"], totpEnabled: true, sessionVerified: true }), "ok");
    assert.equal(policy.twoFactorGate({ roles: ["member"], totpEnabled: false, sessionVerified: false }), "ok");
    // A member who turned it on must enter it too.
    assert.equal(policy.twoFactorGate({ roles: ["member"], totpEnabled: true, sessionVerified: false }), "verify");
    assert.equal(policy.canDisableTwoFactor(["member"]), true);
    assert.equal(policy.canDisableTwoFactor(["admin"]), false);
  });

  it("grants, memory erasure and team views are for owners and admins", () => {
    for (const check of [policy.canManageGrants, policy.canAdministerMemory, policy.canSeeTeamProgress]) {
      assert.deepEqual(
        (["owner", "admin", "member", "guest", null] as const).map((role) => check(role)),
        [true, true, false, false, false],
      );
    }
  });

  it("only the runner's own owner, managing the company, picks its AI account", () => {
    assert.equal(policy.canSetRunnerAccount({ actorUserId: "alex", environment: acmeRunner, companyId: ACME, companyRole: "owner" }), true);
    assert.equal(policy.canSetRunnerAccount({ actorUserId: "alex", environment: acmeRunner, companyId: OTHER, companyRole: "owner" }), false);
    assert.equal(policy.canSetRunnerAccount({ actorUserId: "alex", environment: alexLaptop, companyId: ACME, companyRole: "owner" }), false);
    assert.equal(policy.canSetRunnerAccount({ actorUserId: "admin", environment: acmeRunner, companyId: ACME, companyRole: "admin" }), false);
    assert.equal(policy.canSetRunnerAccount({ actorUserId: "alex", environment: acmeRunner, companyId: ACME, companyRole: "member" }), false);
  });

  it("new-share notifications go to the named person or every full member but the owner", () => {
    assert.deepEqual(policy.shareAudience({ ownerUserId: "alex", audienceUserId: null }, ["alex", "maria", "admin"]), ["maria", "admin"]);
    assert.deepEqual(policy.shareAudience({ ownerUserId: "alex", audienceUserId: "gina" }, ["alex", "maria"]), ["gina"]);
  });
});
