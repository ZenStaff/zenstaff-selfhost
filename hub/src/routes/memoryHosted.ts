// Hosted company memory (hub v13, src/memoryHosted.ts): activation by an owner/admin, one memory key
// per member machine, revocation of a machine's key and of a leaving member's keys.
// v17: memory zones (departments = teams, projects) sent to zen-memory from the hub roles, the
// company's memory rules, and each person's own memory ("Memoria mea") with one key per device,
// bound to the person, never to a company. No route here takes another person's id for the
// personal memory: everything under /v1/me/memory acts on the signed-in user only.
import type { Kit } from "../app.ts";
import { HttpError, bad, forbidden, notFound, str } from "../http.ts";
import * as hosted from "../memoryHosted.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import * as store from "../store.ts";
import * as roles from "../storeRbac.ts";
import * as team from "../storeTeam.ts";

const unavailable = () => new HttpError(409, "Hosted company memory is not available on this hub.", "memory_hosted_unavailable");

export function registerMemoryHostedRoutes(kit: Kit) {
  const { db, config, route, notifier, requirePermission, log } = kit;
  const memory = config.memory ?? null;
  const admin = memory === null ? null : hosted.memoryAdmin(memory);
  const activating = new Map<string, Promise<hosted.CompanyMemoryRow>>();

  /** True when the company's memory address on the hub is the hosted one. */
  const usesHosted = (companyId: string, row: hosted.CompanyMemoryRow | null) =>
    row !== null && team.companySettings(db, companyId).memory.url === row.url;

  const statusOf = (companyId: string, userId: string) => {
    const row = hosted.companyMemory(db, companyId);
    return {
      available: memory !== null,
      activated: row !== null,
      active: usesHosted(companyId, row),
      url: row?.url ?? memory?.publicUrl ?? null,
      activatedAt: row?.activatedAt ?? null,
      machines: hosted.activeKeys(db, companyId, userId).map((key) => ({ keyId: key.keyId, machine: key.machine, issuedAt: key.issuedAt })),
      rules: row === null ? null : { autoPromoteDecisions: row.autoPromoteDecisions, sensitivePolicy: row.sensitivePolicy },
      accessSyncedAt: row?.accessSyncedAt ?? null,
    };
  };

  route("GET", "/v1/companies/:id/memory/hosted", async ({ session, params }) => {
    requireMemorySomewhere(params.id!, session.user.id);
    await syncMemoryAccess(kit, params.id!); // best effort: the zones follow the roles
    return statusOf(params.id!, session.user.id);
  });

  /** `memorie:vede` for the company or for any team/project (a scoped person reads only their zones). */
  const requireMemorySomewhere = (companyId: string, userId: string) => {
    const role = kit.requireRole(companyId, userId);
    const access = roles.accessOf(db, companyId, userId);
    if (!rbac.canSomewhere(access, "memorie:vede")) {
      throw new HttpError(403, `Your role does not allow this (${rbac.describePermission("memorie:vede")}).`, "permission_denied");
    }
    return { role, access };
  };

  /** Owners/admins: the company's memory rules. */
  route("PUT", "/v1/companies/:id/memory/hosted/rules", async ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canAdministerMemory(requirePermission(companyId, session.user.id, "memorie:administreaza").role)) {
      throw forbidden("Only owners and admins change the memory rules.");
    }
    const row = hosted.companyMemory(db, companyId);
    if (row === null) throw new HttpError(409, "Company memory is not turned on yet.", "memory_not_activated");
    if (body.autoPromoteDecisions !== undefined && typeof body.autoPromoteDecisions !== "boolean") throw bad("autoPromoteDecisions must be true or false.");
    if (body.sensitivePolicy !== undefined && body.sensitivePolicy !== "personal" && body.sensitivePolicy !== "drop") throw bad("sensitivePolicy is personal or drop.");
    const next = {
      autoPromoteDecisions: body.autoPromoteDecisions === undefined ? row.autoPromoteDecisions : (body.autoPromoteDecisions as boolean),
      sensitivePolicy: body.sensitivePolicy === undefined ? row.sensitivePolicy : (body.sensitivePolicy as "personal" | "drop"),
    };
    hosted.setMemoryRules(db, companyId, next, session.user.id);
    const synced = await syncMemoryAccess(kit, companyId);
    if (!synced) throw new HttpError(502, "The memory service is not reachable; the rules are saved and are sent at the next sync.", "memory_unreachable");
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "settings.memory",
      summary: `Memory rules: decisions from company chats ${next.autoPromoteDecisions ? "go to company memory automatically" : "stay personal when they look personal"}; sensitive data ${next.sensitivePolicy === "drop" ? "is dropped" : "goes to the person's own memory"}`,
    });
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "memory.rules", target: `company:${companyId}`, detail: next });
    return statusOf(companyId, session.user.id);
  });

  /** Owners/admins: which memory zones exist and who reads each (names from the team list). */
  route("GET", "/v1/companies/:id/memory/hosted/zones", async ({ session, params }) => {
    const companyId = params.id!;
    if (!policy.canAdministerMemory(requirePermission(companyId, session.user.id, "memorie:administreaza").role)) {
      throw forbidden("Only owners and admins see who reads each memory zone.");
    }
    const view = hosted.buildAccess(db, companyId);
    const restricted = hosted.restrictedZones(db, companyId);
    const nameOf = (userId: string) => store.getUser(db, userId)?.name ?? userId;
    const readers = (ref: string) =>
      view.members.filter((m) => m.admin || (ref === "company" ? m.company : m.zones.includes(ref))).map((m) => ({ userId: m.user_ref, name: nameOf(m.user_ref), admin: m.admin }));
    await syncMemoryAccess(kit, companyId);
    return {
      zones: [
        { ref: "company", kind: "company", name: "Toată firma", parentRef: null, readers: readers("company") },
        ...view.zones.map((zone) => ({
          ref: zone.ref,
          kind: zone.kind,
          name: zone.name,
          parentRef: zone.parent_ref ?? null,
          restricted: restricted.has(zone.ref),
          readers: readers(zone.ref),
        })),
      ],
      syncedAt: hosted.companyMemory(db, companyId)?.accessSyncedAt ?? null,
      rules: (() => {
        const row = hosted.companyMemory(db, companyId);
        return row === null ? null : { autoPromoteDecisions: row.autoPromoteDecisions, sensitivePolicy: row.sensitivePolicy };
      })(),
    };
  });

  /** Owners/admins: create the company's hosted memory (once) and point the company at it. */
  route("POST", "/v1/companies/:id/memory/hosted/activate", async ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canAdministerMemory(requirePermission(companyId, session.user.id, "memorie:administreaza").role)) {
      throw forbidden("Only owners and admins turn on company memory.");
    }
    if (memory === null || admin === null) throw unavailable();
    if (body.saveConversations !== undefined && typeof body.saveConversations !== "boolean") throw bad("saveConversations must be true or false.");
    let row = hosted.companyMemory(db, companyId);
    if (row === null) {
      const pending =
        activating.get(companyId) ??
        (async () => {
          const company = store.getCompany(db, companyId);
          if (company === null) throw notFound("No such company.");
          // A memory company made for this hub company before (by us, or before a hub restore) is
          // adopted by its name suffix "(hub <id>)" instead of creating a second one.
          const suffix = `(hub ${companyId})`;
          const existing = (await admin.listCompanies()).companies.find((row) => row.name.endsWith(suffix));
          const memoryCompanyId = existing?.company_id ?? (await admin.createCompany(`${company.name} ${suffix}`)).company_id;
          // Keys made outside the hub (the creation key, an operator's) are never handed out: every
          // machine gets its own key.
          const keys = await admin.listKeys(memoryCompanyId);
          for (const key of keys.keys) if (key.revoked_at === null) await admin.revokeKey(memoryCompanyId, key.key_id);
          hosted.saveCompanyMemory(db, companyId, memoryCompanyId, memory.publicUrl, session.user.id);
          return hosted.companyMemory(db, companyId)!;
        })().finally(() => activating.delete(companyId));
      activating.set(companyId, pending);
      try {
        row = await pending;
      } catch (error) {
        if (error instanceof hosted.MemoryAdminError) throw new HttpError(502, error.message, "memory_unreachable");
        throw error;
      }
    }
    team.setCompanyMemorySettings(db, companyId, session.user.id, { url: row.url, saveConversations: body.saveConversations !== false });
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "settings.memory",
      summary: `Hosted company memory is on (${row.url}); saving conversations is ${body.saveConversations !== false ? "on" : "off"}`,
    });
    return statusOf(companyId, session.user.id);
  });

  /** Owners/admins: a restricted zone is read only by people with a role scoped to it. */
  route("PUT", "/v1/companies/:id/memory/hosted/zones/:ref", async ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canAdministerMemory(requirePermission(companyId, session.user.id, "memorie:administreaza").role)) {
      throw forbidden("Only owners and admins change who reads a memory zone.");
    }
    const ref = decodeURIComponent(params.ref!);
    if (!hosted.buildAccess(db, companyId).zones.some((zone) => zone.ref === ref)) throw notFound("No such memory zone.");
    if (typeof body.restricted !== "boolean") throw bad("restricted must be true or false.");
    hosted.setZoneRestricted(db, companyId, ref, body.restricted, session.user.id);
    kit.auditLog.append({ companyId, actorUserId: session.user.id, action: "memory.zone", target: ref, detail: { restricted: body.restricted } });
    const synced = await syncMemoryAccess(kit, companyId);
    return { ok: true, synced };
  });

  /** A member machine's own memory key. Asking again from the same machine replaces the old key. */
  route("POST", "/v1/companies/:id/memory/hosted/keys", async ({ session, params, body }) => {
    const companyId = params.id!;
    requireMemorySomewhere(companyId, session.user.id);
    if (memory === null || admin === null) throw unavailable();
    const row = hosted.companyMemory(db, companyId);
    if (row === null) throw new HttpError(409, "Company memory is not turned on yet. An owner or admin turns it on.", "memory_not_activated");
    if (!usesHosted(companyId, row)) throw new HttpError(409, "This company uses its own memory server.", "memory_own_server");
    const machine = str(body, "machine", 80).trim();
    if (machine === "") throw bad("machine is required.");
    const mine = hosted.activeKeys(db, companyId, session.user.id);
    try {
      for (const old of mine.filter((key) => key.machine === machine)) {
        await admin.revokeKey(row.memoryCompanyId, old.keyId);
        hosted.markRevoked(db, old.keyId);
      }
      if (mine.filter((key) => key.machine !== machine).length >= hosted.MAX_ACTIVE_KEYS_PER_MEMBER) {
        throw new HttpError(429, `At most ${hosted.MAX_ACTIVE_KEYS_PER_MEMBER} machines per person. Remove one in Team > Company > Memory.`, "memory_too_many_keys");
      }
      // zones first, so the new key (bound to this person) reads exactly what their roles allow
      if (!(await syncMemoryAccess(kit, companyId))) throw new hosted.MemoryAdminError("The memory service did not take the access list.");
      const issued = await admin.issueKey(row.memoryCompanyId, session.user.id);
      hosted.recordKey(db, companyId, session.user.id, machine, issued.key_id);
      const personal = hosted.userMemory(db, session.user.id);
      if (personal !== null) await admin.linkPerson(personal.personId, row.memoryCompanyId);
      log(`[memory] key ${issued.key_id} issued for company ${companyId}, user ${session.user.id}, machine ${JSON.stringify(machine)}`);
      return { url: row.url, apiKey: issued.api_key, keyId: issued.key_id };
    } catch (error) {
      if (error instanceof hosted.MemoryAdminError) throw new HttpError(502, error.message, "memory_unreachable");
      throw error;
    }
  });

  /** Remove a machine's key: your own, or anyone's for those who administer the team. */
  route("DELETE", "/v1/companies/:id/memory/hosted/keys/:keyId", async ({ session, params }) => {
    const companyId = params.id!;
    const access = requireMemorySomewhere(companyId, session.user.id);
    const key = hosted.activeKeys(db, companyId).find((row) => row.keyId === params.keyId);
    if (key === undefined) throw notFound("No such memory key.");
    if (key.userId !== session.user.id && !policy.canAdministerMemory(access.role)) throw forbidden("Only owners and admins remove other people's machines.");
    const row = hosted.companyMemory(db, companyId);
    if (row === null || admin === null) throw unavailable();
    try {
      await admin.revokeKey(row.memoryCompanyId, key.keyId);
    } catch (error) {
      if (error instanceof hosted.MemoryAdminError) throw new HttpError(502, error.message, "memory_unreachable");
      throw error;
    }
    hosted.markRevoked(db, key.keyId);
    return { ok: true };
  });

  // ---- "Memoria mea": the signed-in person's own memory (v17) ----------------------------------

  const personalStatus = (userId: string) => {
    const mine = hosted.userMemory(db, userId);
    const companies = (db.prepare("SELECT company_id FROM memberships WHERE user_id = ?").all(userId) as Array<{ company_id: string }>)
      .map((row) => ({ companyId: row.company_id, row: hosted.companyMemory(db, row.company_id) }))
      .filter((entry) => entry.row !== null)
      .map((entry) => ({ companyId: entry.companyId, name: store.getCompany(db, entry.companyId)?.name ?? entry.companyId }));
    return {
      available: memory !== null,
      active: mine !== null,
      url: memory?.publicUrl ?? null,
      createdAt: mine?.createdAt ?? null,
      machines: hosted.activePersonalKeys(db, userId),
      companies,
    };
  };

  const memoryCall = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof hosted.MemoryAdminError) throw new HttpError(502, error.message, "memory_unreachable");
      throw error;
    }
  };

  /** Links the person's memory to every company of theirs that uses hosted memory. */
  const linkAll = async (userId: string, personId: string) => {
    if (admin === null) return;
    for (const membership of db.prepare("SELECT company_id FROM memberships WHERE user_id = ?").all(userId) as Array<{ company_id: string }>) {
      const row = hosted.companyMemory(db, membership.company_id);
      if (row !== null) await admin.linkPerson(personId, row.memoryCompanyId);
    }
  };

  route("GET", "/v1/me/memory", ({ session }) => personalStatus(session.user.id));

  /** Turns on the person's own memory (once; asking again keeps the same one). */
  route("POST", "/v1/me/memory/activate", async ({ session }) => {
    if (memory === null || admin === null) throw unavailable();
    const userId = session.user.id;
    await memoryCall(async () => {
      const created = await admin.createPerson(userId);
      hosted.saveUserMemory(db, userId, created.person_id);
      await linkAll(userId, created.person_id);
    });
    kit.auditLog.append({ companyId: null, actorUserId: userId, action: "memory.personal.activate", target: `user:${userId}`, detail: {} });
    return personalStatus(userId);
  });

  /** This device's key for the person's own memory (the same memory on every device). */
  route("POST", "/v1/me/memory/keys", async ({ session, body }) => {
    if (memory === null || admin === null) throw unavailable();
    const userId = session.user.id;
    const mine = hosted.userMemory(db, userId);
    if (mine === null) throw new HttpError(409, "Your own memory is not turned on yet.", "memory_personal_off");
    const machine = str(body, "machine", 80).trim();
    if (machine === "") throw bad("machine is required.");
    return memoryCall(async () => {
      const keys = hosted.activePersonalKeys(db, userId);
      for (const old of keys.filter((key) => key.machine === machine)) {
        await admin.revokePersonKey(mine.personId, old.keyId);
        hosted.markPersonalRevoked(db, old.keyId);
      }
      if (keys.filter((key) => key.machine !== machine).length >= hosted.MAX_ACTIVE_KEYS_PER_MEMBER) {
        throw new HttpError(429, `At most ${hosted.MAX_ACTIVE_KEYS_PER_MEMBER} devices. Remove one in Settings > Memoria mea.`, "memory_too_many_keys");
      }
      const issued = await admin.issuePersonKey(mine.personId);
      hosted.recordPersonalKey(db, userId, machine, issued.key_id);
      await linkAll(userId, mine.personId);
      log(`[memory] personal key ${issued.key_id} issued for user ${userId}, machine ${JSON.stringify(machine)}`);
      return { url: memory.publicUrl, apiKey: issued.api_key, keyId: issued.key_id };
    });
  });

  route("DELETE", "/v1/me/memory/keys/:keyId", async ({ session, params }) => {
    const userId = session.user.id;
    const mine = hosted.userMemory(db, userId);
    const key = hosted.activePersonalKeys(db, userId).find((row) => row.keyId === params.keyId);
    if (mine === null || key === undefined) throw notFound("No such device key.");
    if (admin === null) throw unavailable();
    await memoryCall(() => admin.revokePersonKey(mine.personId, key.keyId));
    hosted.markPersonalRevoked(db, key.keyId);
    return { ok: true };
  });

  /** Deletes what the person's memory got from one company's chats (also after leaving it). */
  route("POST", "/v1/me/memory/companies/:id/forget", async ({ session, params }) => {
    const userId = session.user.id;
    const mine = hosted.userMemory(db, userId);
    const row = hosted.companyMemory(db, params.id!);
    if (mine === null || row === null || admin === null) throw notFound("Nothing to delete for this company.");
    const res = await memoryCall(() => admin.unlinkPerson(mine.personId, row.memoryCompanyId, true));
    if (store.roleOf(db, params.id!, userId) !== null) await memoryCall(() => admin.linkPerson(mine.personId, row.memoryCompanyId));
    kit.auditLog.append({ companyId: null, actorUserId: userId, action: "memory.personal.forget_company", target: `company:${params.id!}`, detail: {} });
    return { ok: true, factsDeleted: res.forgotten?.facts_deleted ?? 0 };
  });

  /** Deletes the person's whole memory: its key is destroyed first (crypto-shredding). */
  route("DELETE", "/v1/me/memory", async ({ session, body }) => {
    const userId = session.user.id;
    if (body.confirm !== "sterge") throw bad('Send {"confirm": "sterge"} to delete your memory for good.');
    const mine = hosted.userMemory(db, userId);
    if (mine === null) return { ok: true, deleted: false };
    if (admin === null) throw unavailable();
    await memoryCall(() => admin.deletePerson(mine.personId));
    hosted.deleteUserMemory(db, userId);
    kit.auditLog.append({ companyId: null, actorUserId: userId, action: "memory.personal.delete", target: `user:${userId}`, detail: {} });
    return { ok: true, deleted: true };
  });
}

/**
 * Sends the company's zones, who reads them and its rules to zen-memory (best effort: false when
 * the memory is not activated or not reachable; the next sync catches up).
 */
export async function syncMemoryAccess(kit: Pick<Kit, "db" | "config" | "log">, companyId: string): Promise<boolean> {
  const memory = kit.config.memory ?? null;
  const row = hosted.companyMemory(kit.db, companyId);
  if (memory === null || row === null) return false;
  try {
    await hosted.memoryAdmin(memory).syncAccess(row.memoryCompanyId, hosted.buildAccess(kit.db, companyId));
    hosted.markAccessSynced(kit.db, companyId);
    return true;
  } catch (error) {
    kit.log(`[memory] access sync for ${companyId} failed: ${String(error)}`);
    return false;
  }
}

/** Account deletion (for the route that deletes a hub account): the person's memory goes with it. */
export async function deletePersonalMemory(kit: Pick<Kit, "db" | "config" | "log">, userId: string): Promise<void> {
  const memory = kit.config.memory ?? null;
  const mine = hosted.userMemory(kit.db, userId);
  if (memory === null || mine === null) return;
  await hosted.memoryAdmin(memory).deletePerson(mine.personId);
  hosted.deleteUserMemory(kit.db, userId);
}

/**
 * A person left or was removed: revoke their memory keys in that company (best effort; a key whose
 * revocation fails stays listed as active and is retried the next time anything is revoked for them).
 */
export async function revokeMemberMemoryKeys(
  kit: Pick<Kit, "db" | "config" | "log">,
  companyId: string,
  userId: string,
  forgetPersonal = false,
): Promise<void> {
  const memory = kit.config.memory ?? null;
  const row = hosted.companyMemory(kit.db, companyId);
  if (memory === null || row === null) return;
  const admin = hosted.memoryAdmin(memory);
  // Their own memory goes with them (detached from the company) or loses what came from it, at
  // their choice; nothing of it stays with the company.
  const personal = hosted.userMemory(kit.db, userId);
  if (personal !== null) {
    try {
      await admin.unlinkPerson(personal.personId, row.memoryCompanyId, forgetPersonal);
    } catch (error) {
      kit.log(`[memory] detaching the personal memory of ${userId} from ${companyId} failed: ${String(error)}`);
    }
  }
  await syncMemoryAccess(kit, companyId);
  for (const key of hosted.activeKeys(kit.db, companyId, userId)) {
    try {
      await admin.revokeKey(row.memoryCompanyId, key.keyId);
      hosted.markRevoked(kit.db, key.keyId);
    } catch (error) {
      kit.log(`[memory] revoking key ${key.keyId} of user ${userId} in ${companyId} failed: ${String(error)}`);
    }
  }
}
