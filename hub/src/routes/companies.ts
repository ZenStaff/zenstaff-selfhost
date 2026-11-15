// Companies, invitations, members, machines and runners (with the AI account a company runner
// declares), Enterprise pack grants, company settings and the admin audit log.
import type { Kit } from "../app.ts";
import { acceptLanguage, asLanguage, bad, forbidden, notFound, obj, optStr, role, str } from "../http.ts";
import { ZEN_DOWNLOADS, inviterLabel } from "../downloads.ts";
import { ROLE_NAMES, inviteMail } from "../mailTemplates.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import { isPublicKey, statementMessage, verifyEd25519, canonicalJson } from "../signing.ts";
import * as store from "../store.ts";
import * as roles from "../storeRbac.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";
import { companyMemory } from "../memoryHosted.ts";
import { revokeMemberMemoryKeys, syncMemoryAccess } from "./memoryHosted.ts";

const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** Something that looks like a credential must never be sent as runner metadata. */
const SECRET_LIKE = /(sk-[A-Za-z0-9_-]{8,}|sk-ant-|AKIA[0-9A-Z]{12}|ghp_[A-Za-z0-9]{20}|[A-Za-z0-9_-]{40,})/;

export function isMemoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function registerCompanyRoutes(kit: Kit) {
  const { db, mailer, config, route, relay, notifier, requireRole, requirePermission } = kit;
  const nameOf = (userId: string) => store.getUser(db, userId)?.name ?? "someone";
  /** Settings plus whether hosted memory exists on this hub and is the company's memory (v13). */
  const withHosted = (companyId: string) => {
    const settings = team.companySettings(db, companyId);
    const row = companyMemory(db, companyId);
    return {
      ...settings,
      hosted: {
        available: config.memory !== undefined,
        activated: row !== null,
        active: row !== null && settings.memory.url === row.url,
        url: row?.url ?? config.memory?.publicUrl ?? null,
      },
    };
  };

  route("POST", "/v1/companies", ({ session, body }) => store.createCompany(db, session.user.id, str(body, "name", 80)));

  route("GET", "/v1/companies/:id", ({ session, params }) => {
    const companyId = params.id!;
    const myRole = requireRole(companyId, session.user.id);
    const access = roles.accessOf(db, companyId, session.user.id);
    const seesTeam = rbac.can(access, "echipa:vede");
    const assignments = new Map(roles.assignmentsOf(db, companyId).map((row) => [row.userId, row]));
    const roleNames = new Map(roles.rolesOf(db, companyId).map((role) => [role.id, role.name]));
    return {
      company: store.getCompany(db, companyId),
      role: myRole,
      access: roles.accessForClients(db, companyId, session.user.id),
      // Without "echipa: vede" a person sees only themselves.
      members: store
        .membersOf(db, companyId)
        .filter((member) => seesTeam || member.userId === session.user.id)
        .map((member) => {
          const customRoleId = assignments.get(member.userId)?.customRoleId ?? null;
          return {
            ...member,
            twoFactor: security.totpState(db, member.userId).enabled,
            customRoleId,
            customRoleName: customRoleId === null ? null : (roleNames.get(customRoleId) ?? null),
            scopedRoles: (assignments.get(member.userId)?.scoped ?? []).length,
            // v9 (perms-fine): what each member may do, for the company runner's own checks
            // (who may change an AI employee); team scopes listed per project.
            access: roles.accessForClients(db, companyId, member.userId),
          };
        }),
      invites: policy.canManageCompany(myRole) || rbac.can(access, "echipa:creeaza") ? store.pendingInvites(db, companyId) : [],
      runners: store.runnersOf(db, companyId).map((runner) => ({
        ...runner,
        online: relay.isOnline(runner.id),
        aiAccount: team.aiAccountOf(db, runner.id, companyId),
        keys: team.environmentKeys(db, runner.id),
        // How many companies this machine serves (one machine can be the runner of several).
        companies: store.runnerCompaniesOf(db, runner.id).length,
      })),
      settings: rbac.can(access, "memorie:vede") ? withHosted(companyId) : null,
    };
  });

  route("POST", "/v1/companies/:id/invites", async ({ session, params, body, req }) => {
    const user = session.user;
    const companyId = params.id!;
    const { role: myRole, access } = requirePermission(companyId, user.id, "echipa:creeaza");
    const invitedRole = role(body.role ?? "member");
    // A custom role with "echipa: creează" invites members and guests; admins only by owners.
    const allowed = policy.canInvite(myRole, invitedRole) || (rbac.can(access, "echipa:creeaza") && (invitedRole === "member" || invitedRole === "guest"));
    if (!allowed) throw forbidden("You cannot invite with that role.");
    // No company API key needed to invite: colleagues work on their own computers with their own AI
    // account. The key is needed only for the company server to work for them (the server refuses
    // colleagues' work without it, companyAiPolicy.ts in the app).
    const rawEmail = optStr(body, "email", 254);
    const email = rawEmail === null ? null : store.normalizeEmail(rawEmail);
    if (rawEmail !== null && email === null) throw bad("Enter a valid e-mail address.");
    const invite = store.createInvite(db, { companyId, email, role: invitedRole, createdBy: user.id });
    const link = `${config.publicUrl}/invite#${invite.token}`;
    const company = store.getCompany(db, companyId)!;
    if (email !== null) {
      // The invited person's own language when they have an account, else the inviter's page (the
      // dashboard sends its language) or browser; the link opens the invitation page in the same one.
      const lang = team.languageOfEmail(db, email) ?? asLanguage(body.lang) ?? acceptLanguage(req);
      const mailLink = lang === null ? link : `${config.publicUrl}/invite?lang=${lang}#${invite.token}`;
      await mailer.send({
        to: email,
        ...inviteMail(lang, { inviterName: user.name, inviterEmail: user.email, companyName: company.name, role: invitedRole, email, link: mailLink, publicUrl: config.publicUrl }),
      });
    }
    notifier.adminAction({
      companyId,
      actorUserId: user.id,
      action: "invite.create",
      summary: email === null ? `New ${invitedRole} invitation link created` : `${email} was invited as ${invitedRole}`,
    });
    return { inviteId: invite.id, token: invite.token, link };
  });

  // What the invitation page shows before sign-in: the company, who invites and the role (in both
  // languages, so the page needs no table of its own). The token is the secret: it travels in the
  // body, never in a URL, and an unknown, used, revoked or expired one gets a 404.
  route(
    "POST",
    "/v1/invites/preview",
    ({ body }) => {
      const token = str(body, "token", 300);
      const clean = (token.split("#").pop() ?? token).trim();
      const found = store.previewInvite(db, clean);
      if (found === null) throw notFound("This invitation is no longer valid.");
      return {
        companyName: found.company,
        inviter: inviterLabel(found.inviter, found.inviterEmail),
        role: found.role,
        roleName: { ro: ROLE_NAMES.ro[found.role] ?? found.role, en: ROLE_NAMES.en[found.role] ?? found.role },
        email: found.email,
      };
    },
    "public",
  );

  // The invitation link (token in the fragment, never sent to the hub by the browser): the page
  // says who invites to which company (invite.js asks /v1/invites/preview), how to get the app and
  // the steps; it also accepts in the web dashboard. One language at a time: ?lang=en|ro (the
  // e-mail's link carries it), else the browser's, else Romanian; the other one is a link away.
  kit.page("/invite", (req, url, res) => {
    const en = (asLanguage(url.searchParams.get("lang")) ?? acceptLanguage(req) ?? "ro") === "en";
    const t = en
      ? {
          lang: "en",
          title: "Zen Staff invitation",
          heading: `You have an <span class="accent">invitation</span>.`,
          lede: "Someone invited you to their company on Zen Staff.",
          steps: [
            `<b>Download Zen Staff:</b> <a href="${ZEN_DOWNLOADS.windows}">Windows</a> · <a href="${ZEN_DOWNLOADS.linuxAppImage}">Linux (AppImage)</a> · <a href="${ZEN_DOWNLOADS.linuxDeb}">Linux (.deb)</a> · <a href="${ZEN_DOWNLOADS.page}">other systems</a>`,
            "<b>Open it</b> and, on the first start, choose <b>I was invited</b>.",
            "<b>Sign in</b> with the address the invitation was sent to and paste this page's link.",
          ],
          copy: "Copy the invitation link",
          browser: "Or accept it in the browser",
          other: `<a href="/invite?lang=ro" id="other-lang">Română</a>`,
          quote: `One team, <span class="accent">its AI staff</span>, all in one place.`,
        }
      : {
          lang: "ro",
          title: "Invitație Zen Staff",
          heading: `Ai primit o <span class="accent">invitație</span>.`,
          lede: "Cineva te-a invitat în firma lui pe Zen Staff.",
          steps: [
            `<b>Descarcă Zen Staff:</b> <a href="${ZEN_DOWNLOADS.windows}">Windows</a> · <a href="${ZEN_DOWNLOADS.linuxAppImage}">Linux (AppImage)</a> · <a href="${ZEN_DOWNLOADS.linuxDeb}">Linux (.deb)</a> · <a href="${ZEN_DOWNLOADS.page}">alte sisteme</a>`,
            "<b>Deschide aplicația</b> și, la prima pornire, alege <b>Am primit o invitație</b>.",
            "<b>Intră în cont</b> cu adresa la care ai primit invitația și lipește linkul acestei pagini.",
          ],
          copy: "Copiază linkul invitației",
          browser: "Sau accept-o din browser",
          other: `<a href="/invite?lang=en" id="other-lang">English</a>`,
          quote: `O echipă și <span class="accent">angajații ei AI</span>, într-un singur loc.`,
        };
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    });
    res.end(
      `<!doctype html><html lang="${t.lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${t.title}</title>` +
        `<link rel="icon" href="/app/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app/assets/app.css"><script src="/app/assets/invite.js" defer></script>` +
        `<body><div class="auth"><div class="auth-l"><a class="brand-row" href="/app"><img class="lockup" src="/app/assets/logo.svg" alt="Zen Staff" width="168" height="29"></a>` +
        `<main class="auth-form" data-lang="${t.lang}"><h1 id="invite-title">${t.heading}</h1>` +
        `<p class="lede" id="invite-who">${t.lede}</p>` +
        `<ol class="invite-steps">${t.steps.map((step) => `<li>${step}</li>`).join("")}</ol>` +
        `<p><button type="button" class="btn loud" id="copy-link">${t.copy}</button></p>` +
        `<p><a class="btn" id="accept" href="/app/invitatie?lang=${t.lang}">${t.browser}</a></p>` +
        `<p class="note">${t.other}</p></main>` +
        `<div class="auth-foot"><span>Zen Staff · ZED-ZEN</span></div></div>` +
        `<div class="auth-r art morning" aria-hidden="true"><div class="glimpse"><img class="brand-sm" src="/app/assets/logo.svg" alt="" width="132" height="23">` +
        `<p class="quote">${t.quote}</p></div></div></div></body></html>`,
    );
  });

  route("DELETE", "/v1/companies/:id/invites/:inviteId", ({ session, params }) => {
    const companyId = params.id!;
    const { role: myRole } = requirePermission(companyId, session.user.id, "echipa:creeaza");
    const invite = store.pendingInvites(db, companyId).find((candidate) => candidate.id === params.inviteId);
    // Managers revoke any invitation; someone with "echipa: creează" only the ones they made.
    if (!policy.canManageCompany(myRole) && (invite === undefined || invite.createdBy !== session.user.id)) throw forbidden();
    store.revokeInvite(db, companyId, params.inviteId!);
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "invite.revoke", summary: "An invitation was revoked" });
    return { ok: true };
  });

  route("POST", "/v1/invites/accept", ({ session, body }) => {
    const user = session.user;
    const token = optStr(body, "token", 300);
    const inviteId = optStr(body, "inviteId", 80);
    const cleanToken = token === null ? null : (token.split("#").pop() ?? token).trim();
    const result =
      cleanToken !== null
        ? store.acceptInviteToken(db, cleanToken, user)
        : inviteId !== null
          ? store.acceptInviteById(db, inviteId, user)
          : null;
    if (result === null) throw bad("Paste the invitation link.");
    if (!result.ok) throw forbidden(result.reason);
    notifier.adminAction({ companyId: result.companyId, actorUserId: user.id, action: "invite.accept", summary: `${user.email} joined as ${result.role}` });
    return { companyId: result.companyId, role: result.role };
  });

  route("PATCH", "/v1/companies/:id/members/:userId", ({ session, params, body }) => {
    const companyId = params.id!;
    const targetUserId = params.userId!;
    const { role: actor } = requirePermission(companyId, session.user.id, "echipa:administreaza");
    const targetRole = store.roleOf(db, companyId, targetUserId);
    if (targetRole === null) throw notFound("No such member.");
    const newRole = role(body.role);
    const allowed = policy.canChangeRole({
      actor,
      actorUserId: session.user.id,
      targetUserId,
      targetRole,
      newRole,
      ownerCount: store.ownerCount(db, companyId),
    });
    if (!allowed) throw forbidden("You cannot give that role.");
    store.setRole(db, companyId, targetUserId, newRole);
    // Owners and admins have every permission: a custom role on them would only mislead.
    if (newRole === "owner" || newRole === "admin") roles.clearAccessOf(db, companyId, targetUserId);
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "member.role",
      summary: `${nameOf(targetUserId)} is now ${newRole} (was ${targetRole})`,
      alsoUserIds: [targetUserId],
    });
    void syncMemoryAccess(kit, companyId); // memory zones follow the new role
    return { ok: true };
  });

  route("DELETE", "/v1/companies/:id/members/:userId", ({ session, params, body }) => {
    const companyId = params.id!;
    const targetUserId = params.userId!;
    const actor = requireRole(companyId, session.user.id);
    const targetRole = store.roleOf(db, companyId, targetUserId);
    if (targetRole === null) throw notFound("No such member.");
    // Leaving needs nothing; removing someone else needs "echipa: administrează".
    if (targetUserId !== session.user.id) requirePermission(companyId, session.user.id, "echipa:administreaza");
    const allowed = policy.canRemoveMember({
      actor,
      actorUserId: session.user.id,
      targetUserId,
      targetRole,
      ownerCount: store.ownerCount(db, companyId),
    });
    if (!allowed) throw forbidden("You cannot remove this member.");
    const name = nameOf(targetUserId);
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "member.remove",
      summary: targetUserId === session.user.id ? `${name} left the company` : `${name} was removed from the company`,
      alsoUserIds: [targetUserId],
    });
    store.removeMember(db, companyId, targetUserId);
    // Only the person leaving decides to delete what their own memory got from this company.
    const forgetPersonal = targetUserId === session.user.id && body.forgetMemory === true;
    void revokeMemberMemoryKeys(kit, companyId, targetUserId, forgetPersonal);
    return { ok: true };
  });

  // ---- Environments and runners -----------------------------------------------------------

  route("POST", "/v1/environments", ({ session, body }) => {
    const registered = store.registerEnvironment(db, session.user.id, str(body, "name", 80));
    return { environmentId: registered.id, credential: registered.credential };
  }, "signin");

  const ownEnvironment = (environmentId: string, userId: string) => {
    const environment = store.getEnvironment(db, environmentId);
    if (environment === null || environment.ownerUserId !== userId) throw notFound("No such machine.");
    return environment;
  };

  route("PATCH", "/v1/environments/:id", ({ session, params, body }) => {
    ownEnvironment(params.id!, session.user.id);
    store.renameEnvironment(db, params.id!, str(body, "name", 80));
    return { ok: true };
  });

  route("DELETE", "/v1/environments/:id", ({ session, params }) => {
    const environment = ownEnvironment(params.id!, session.user.id);
    for (const companyId of environment.runnerCompanyIds) {
      notifier.adminAction({
        companyId,
        actorUserId: session.user.id,
        action: "runner.remove",
        summary: `Runner "${environment.name}" was removed`,
      });
    }
    relay.disconnect(environment.id);
    team.deleteEnvironment(db, environment.id);
    return { ok: true };
  }, "signin");

  /** The machine's own keys: runners sign their answers and receive end-to-end encrypted requests. */
  route("PUT", "/v1/environments/:id/keys", ({ session, params, body }) => {
    ownEnvironment(params.id!, session.user.id);
    if (!isPublicKey(body.signPublicKey) || !isPublicKey(body.boxPublicKey)) throw bad("Send the machine's public keys.");
    team.setEnvironmentKeys(db, params.id!, body.signPublicKey, body.boxPublicKey);
    return { ok: true };
  }, "signin");

  /**
   * v9: one machine can be the runner of several companies (one login, one service). Each company
   * is added by its own owner/admin who owns the machine, and keeps its own AI account, staff,
   * memory scope and sealing context (company id in every seal's AAD and every signed scope).
   */
  const addRunner = (userId: string, environment: store.StoredEnvironment, companyId: string) => {
    if (environment.runnerCompanyIds.includes(companyId)) return;
    requirePermission(companyId, userId, "dispozitive:administreaza");
    const allowed = policy.canRegisterRunner({ actorUserId: userId, environment, role: store.roleOf(db, companyId, userId) });
    if (!allowed) throw forbidden("Only owners and admins can register a company runner.");
    store.addRunnerCompany(db, environment.id, companyId);
    notifier.adminAction({ companyId, actorUserId: userId, action: "runner.add", summary: `New company runner: "${environment.name}"` });
  };
  const removeRunner = (userId: string, environment: store.StoredEnvironment, companyId: string) => {
    if (!environment.runnerCompanyIds.includes(companyId)) return;
    store.removeRunnerCompany(db, environment.id, companyId);
    notifier.adminAction({ companyId, actorUserId: userId, action: "runner.remove", summary: `"${environment.name}" is no longer a company runner` });
  };
  const runnerAnswer = (environmentId: string) => {
    const runnerCompanyIds = store.runnerCompaniesOf(db, environmentId);
    return { ok: true, runnerCompanyIds, runnerCompanyId: runnerCompanyIds[0] ?? null };
  };

  /**
   * `companyIds`: the full list of companies this machine serves. An older app sends `companyId`
   * (one company, or null to stop): that keeps its old meaning, the machine serves only that one.
   */
  route("PUT", "/v1/environments/:id/runner", ({ session, params, body }) => {
    const user = session.user;
    const environment = ownEnvironment(params.id!, user.id);
    let wanted: Array<string>;
    if (Array.isArray(body.companyIds)) {
      if (body.companyIds.length > 50 || !body.companyIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 80)) {
        throw bad("companyIds must be a list of company ids.");
      }
      wanted = [...new Set(body.companyIds as Array<string>)];
    } else {
      const companyId = optStr(body, "companyId", 80);
      wanted = companyId === null ? [] : [companyId];
    }
    for (const companyId of wanted) addRunner(user.id, environment, companyId);
    for (const companyId of environment.runnerCompanyIds) if (!wanted.includes(companyId)) removeRunner(user.id, environment, companyId);
    return runnerAnswer(environment.id);
  });

  route("POST", "/v1/environments/:id/runner/companies/:companyId", ({ session, params }) => {
    const environment = ownEnvironment(params.id!, session.user.id);
    addRunner(session.user.id, environment, params.companyId!);
    return runnerAnswer(environment.id);
  });

  route("DELETE", "/v1/environments/:id/runner/companies/:companyId", ({ session, params }) => {
    const environment = ownEnvironment(params.id!, session.user.id);
    if (!environment.runnerCompanyIds.includes(params.companyId!)) throw notFound("This machine is not a runner of that company.");
    removeRunner(session.user.id, environment, params.companyId!);
    return runnerAnswer(environment.id);
  });

  /**
   * Which AI account a company runner uses for company agents. Metadata only: the seat login or the
   * API key stays on the runner; anything that looks like a key is refused here.
   */
  route("PUT", "/v1/environments/:id/ai-account", ({ session, params, body }) => {
    const environment = ownEnvironment(params.id!, session.user.id);
    // Each company the machine serves has its own AI account; an older app names none (one company).
    if (environment.runnerCompanyIds.length === 0) throw forbidden("This machine is not a company runner.");
    const companyId = optStr(body, "companyId", 80) ?? (environment.runnerCompanyIds.length === 1 ? environment.runnerCompanyIds[0]! : null);
    if (companyId === null) throw bad("Say which company this AI account is for.");
    const allowed = policy.canSetRunnerAccount({
      actorUserId: session.user.id,
      environment,
      companyId,
      companyRole: store.roleOf(db, companyId, session.user.id),
    });
    if (!allowed) throw forbidden("Only the owner of a company runner (an owner or admin) can choose its AI account.");
    requirePermission(companyId, session.user.id, "dispozitive:administreaza");
    if (body.account === null) {
      team.setAiAccount(db, environment.id, companyId, null);
      return { ok: true, aiAccount: null, companyId };
    }
    const account = obj(body, "account");
    const provider = account.provider;
    const mode = account.mode;
    const label = str(account, "label", 80);
    if (provider !== "claude" && provider !== "codex") throw bad("provider must be claude or codex.");
    if (mode !== "seat" && mode !== "api-key") throw bad("mode must be seat or api-key.");
    if (SECRET_LIKE.test(label)) throw bad("Do not send keys to the hub. The key stays on the runner.");
    const aiAccount: team.AiAccount = { provider, mode, label, updatedAt: new Date().toISOString() };
    team.setAiAccount(db, environment.id, companyId, aiAccount);
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "runner.ai-account",
      summary: `Runner "${environment.name}" now uses ${label} (${provider}, ${mode === "seat" ? "seat login" : "company API key"})`,
    });
    return { ok: true, aiAccount, companyId };
  });

  // ---- Enterprise pack grants -------------------------------------------------------------

  route("GET", "/v1/companies/:id/grants", ({ session, params }) => {
    const { role: myRole } = requirePermission(params.id!, session.user.id, "pachete:vede");
    const grants = team.grantsOf(db, params.id!, policy.canManageGrants(myRole) ? null : session.user.id);
    return {
      grants: grants.map((grant) => ({
        ...grant,
        signerPublicKey: security.getDeviceKey(db, grant.signerKeyId)?.signPublicKey ?? null,
        signerCerts: security.certsOf(db, grant.signerKeyId),
      })),
    };
  });

  /**
   * An admin unlocks an Enterprise pack for one person ("use") or approves installing it
   * ("install"). The statement is signed by the admin's device; runners verify that signature
   * against device keys they pinned themselves before honouring it.
   */
  route("POST", "/v1/companies/:id/grants", ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canManageGrants(requirePermission(companyId, session.user.id, "pachete:aproba").role)) throw forbidden("Only owners and admins unlock Enterprise packs.");
    const packId = str(body, "packId", 80);
    if (!PACK_ID.test(packId)) throw bad("Unknown pack.");
    const kind = body.kind === "install" ? "install" : body.kind === "use" ? "use" : null;
    if (kind === null) throw bad("kind must be use or install.");
    const userId = kind === "use" ? str(body, "userId", 80) : null;
    const target = userId === null ? null : store.getUser(db, userId);
    if (userId !== null && (target === null || store.roleOf(db, companyId, userId) === null)) throw notFound("No such member.");
    const signer = security.deviceKeyOfSession(db, session.hash);
    if (signer === null) throw bad("This session has no device key; sign in again from Zen Staff.");
    const ts = body.ts;
    if (typeof ts !== "number" || Math.abs(Date.now() - ts) > 5 * 60_000) throw bad("The approval is too old; try again.");
    const statement = {
      action: "grant",
      companyId,
      packId,
      kind,
      userId,
      userEmail: target?.email ?? null,
      grantedBy: session.user.id,
      ts,
    };
    const signature = str(body, "signature", 200);
    if (!verifyEd25519(signer.signPublicKey, statementMessage(statement), signature)) throw bad("The approval signature is not valid.");
    const id = team.addGrant(db, {
      companyId,
      packId,
      kind,
      userId,
      grantedBy: session.user.id,
      statement: canonicalJson(statement),
      signerKeyId: signer.keyId,
      signature,
    });
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: kind === "use" ? "grant.use" : "grant.install",
      summary: kind === "use" ? `${target!.name} was unlocked for the Enterprise pack ${packId}` : `Installing the Enterprise pack ${packId} was approved`,
      ...(userId === null ? {} : { alsoUserIds: [userId] }),
    });
    return { id };
  });

  route("DELETE", "/v1/companies/:id/grants/:grantId", ({ session, params }) => {
    const companyId = params.id!;
    if (!policy.canManageGrants(requirePermission(companyId, session.user.id, "pachete:aproba").role)) throw forbidden();
    if (!team.revokeGrant(db, companyId, params.grantId!)) throw notFound("No such grant.");
    notifier.adminAction({ companyId, actorUserId: session.user.id, action: "grant.revoke", summary: "An Enterprise pack grant was revoked" });
    return { ok: true };
  });

  // ---- Company settings and audit ---------------------------------------------------------

  route("GET", "/v1/companies/:id/settings", ({ session, params }) => {
    requirePermission(params.id!, session.user.id, "memorie:vede");
    return withHosted(params.id!);
  });

  /** The company memory address and the save switch. The API key never comes to the hub. */
  route("PUT", "/v1/companies/:id/settings", ({ session, params, body }) => {
    const companyId = params.id!;
    if (!policy.canAdministerMemory(requirePermission(companyId, session.user.id, "memorie:administreaza").role)) throw forbidden("Only owners and admins change company settings.");
    const memory = obj(body, "memory");
    if ("key" in memory || "apiKey" in memory) throw bad("Do not send keys to the hub. The memory key stays on each machine.");
    const url = optStr(memory, "url", 300);
    if (url !== null && !isMemoryUrl(url)) throw bad("The memory address must start with https:// (or http://localhost).");
    if (memory.saveConversations !== undefined && typeof memory.saveConversations !== "boolean") throw bad("saveConversations must be true or false.");
    team.setCompanyMemorySettings(db, companyId, session.user.id, {
      url: url === null ? null : url.replace(/\/+$/, ""),
      saveConversations: memory.saveConversations === true,
    });
    notifier.adminAction({
      companyId,
      actorUserId: session.user.id,
      action: "settings.memory",
      summary: `Company memory ${url === null ? "was disconnected" : `now points to ${url}`}; saving conversations is ${memory.saveConversations === true ? "on" : "off"}`,
    });
    return withHosted(companyId);
  });

  route("GET", "/v1/companies/:id/audit", ({ session, params }) => {
    requirePermission(params.id!, session.user.id, "echipa:administreaza");
    return { entries: team.auditOf(db, params.id!) };
  });
}
