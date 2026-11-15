// Roles and permissions (v9) as pure rules: built-in sets, custom roles that replace them, scoped
// roles that only add, and AI staff acting with the permissions of the person who started them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as rbac from "../src/rbac.ts";

const custom = (id: string, permissions: Array<rbac.Permission>): rbac.RoleDef => ({ id, name: id, description: "", permissions, builtin: null });

describe("rbac", () => {
  it("knows 7 resources x 5 actions plus the two follow permissions", () => {
    assert.equal(rbac.ALL_PERMISSIONS.length, 7 * 5 + 2);
    assert.ok(rbac.isPermission("facturare:aproba"));
    assert.ok(rbac.isPermission("chats:urmareste"));
    assert.equal(rbac.isPermission("chats:everything"), false);
    assert.deepEqual(rbac.cleanPermissions(["echipa:vede", "chats:vede", "chats:vede"]), ["chats:vede", "echipa:vede"]);
    assert.equal(rbac.cleanPermissions(["chats:vede", "root"]), null);
    assert.equal(rbac.cleanPermissions("chats:vede"), null);
  });

  it("owners and admins can do everything; built-in Membru follows its own tasks, Invitat only watches", () => {
    for (const role of ["owner", "admin"] as const) {
      const access = rbac.resolveAccess({ role, customRole: custom("x", []), builtinOverride: [], scoped: [] });
      for (const permission of rbac.ALL_PERMISSIONS) assert.ok(rbac.can(access, permission), `${role} ${permission}`);
    }
    const member = rbac.resolveAccess({ role: "member", customRole: null, builtinOverride: null, scoped: [] });
    assert.ok(rbac.can(member, rbac.FOLLOW_OWN));
    assert.equal(rbac.can(member, rbac.FOLLOW_ALL), false);
    assert.equal(rbac.can(member, "echipa:administreaza"), false);
    const guest = rbac.resolveAccess({ role: "guest", customRole: null, builtinOverride: null, scoped: [] });
    assert.deepEqual(guest.permissions, ["chats:vede"]);
    assert.equal(rbac.can(null, "chats:vede"), false);
  });

  it("a company-wide custom role replaces the built-in set; a company may change Membru", () => {
    const accounting = custom("role_acc", ["facturare:vede", "facturare:administreaza", "chats:vede"]);
    const access = rbac.resolveAccess({ role: "member", customRole: accounting, builtinOverride: null, scoped: [] });
    assert.ok(rbac.can(access, "facturare:administreaza"));
    assert.equal(rbac.can(access, "angajati:creeaza"), false, "not inherited from Membru");
    const narrowed = rbac.resolveAccess({ role: "member", customRole: null, builtinOverride: ["chats:vede"], scoped: [] });
    assert.equal(rbac.can(narrowed, "angajati:trimite"), false);
  });

  it("scoped roles only count inside their project or team", () => {
    const developer = custom("role_dev", ["angajati:administreaza", "chats:trimite"]);
    const access = rbac.resolveAccess({
      role: "member",
      customRole: null,
      builtinOverride: null,
      scoped: [
        { role: developer, kind: "project", id: "p-site" },
        { role: developer, kind: "team", id: "team_sales" },
      ],
    });
    assert.equal(rbac.can(access, "angajati:administreaza"), false, "not company-wide");
    assert.ok(rbac.can(access, "angajati:administreaza", { projectId: "p-site" }));
    assert.equal(rbac.can(access, "angajati:administreaza", { projectId: "p-other" }), false);
    assert.ok(rbac.can(access, "angajati:administreaza", { projectId: "p-crm", teamIds: ["team_sales"] }));
    assert.ok(rbac.canSomewhere(access, "angajati:administreaza"));
    assert.equal(rbac.canSomewhere(access, "facturare:administreaza"), false);
  });

  it("AI staff never do more than the person who started them", () => {
    const noSend = rbac.resolveAccess({ role: "member", customRole: custom("role_ro", ["angajati:vede", "angajati:creeaza"]), builtinOverride: null, scoped: [] });
    assert.equal(rbac.agentCan(noSend, "angajati:trimite"), false);
    assert.equal(rbac.agentCan(noSend, "angajati:creeaza"), true);
    assert.equal(rbac.agentCan(null, "angajati:vede"), false, "a run with nobody behind it has no rights");
    const owner = rbac.resolveAccess({ role: "owner", customRole: null, builtinOverride: null, scoped: [] });
    assert.ok(rbac.agentCan(owner, "angajati:trimite"));
  });

  it("only owners and admins edit roles", () => {
    assert.deepEqual((["owner", "admin", "member", "guest", null] as const).map((role) => rbac.canEditRoles(role)), [true, true, false, false, false]);
  });
  it("lists a team grant for each project of the team, for checks that know only the project", () => {
    const tasks = custom("role_tasks", ["angajati:creeaza"]);
    const access = rbac.resolveAccess({ role: "member", customRole: custom("see", ["angajati:vede"]), builtinOverride: null, scoped: [{ role: tasks, kind: "team", id: "team_dev" }] });
    const projects = [
      { id: "p-site", teamId: "team_dev" },
      { id: "p-app", teamId: "team_dev" },
      { id: "p-pos", teamId: null },
    ];
    const expanded = rbac.withTeamProjects(access, projects)!;
    assert.ok(rbac.can(expanded, "angajati:creeaza", { projectId: "p-site" }));
    assert.ok(rbac.can(expanded, "angajati:creeaza", { projectId: "p-app" }));
    assert.equal(rbac.can(expanded, "angajati:creeaza", { projectId: "p-pos" }), false);
    assert.equal(rbac.can(expanded, "angajati:creeaza"), false, "still not company-wide");
    // The team grant itself stays; nothing is listed twice; owners and plain roles are unchanged.
    assert.equal(expanded.scoped.filter((grant) => grant.kind === "team").length, 1);
    assert.deepEqual(rbac.withTeamProjects(expanded, projects), expanded);
    const owner = rbac.resolveAccess({ role: "owner", customRole: null, builtinOverride: null, scoped: [] });
    assert.equal(rbac.withTeamProjects(owner, projects), owner);
    assert.equal(rbac.withTeamProjects(null, projects), null);
  });
});
