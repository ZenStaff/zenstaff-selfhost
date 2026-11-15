// Shared chats: create, list, revoke, comment, and the relay calls (view, copy, prompt, hand-over).
// Every relay call carries the caller's device signature; the hub checks it and the runner checks
// it again against keys it pinned itself (signing.ts).
//
// v4: titles and comments are end-to-end. A new share's title is sealed by the owner's runner to
// its own key; a comment is sealed by the author's app to the runner's key and signed by their
// device. The hub stores the ciphertext and hands it to the runner (`thread.meta`), which answers
// the reader sealed to their device. Notifications and e-mails carry who, which share and which
// kind, never a title or a comment.
import type { Kit } from "../app.ts";
import { bad, forbidden, type Json, notFound, obj, optStr, str } from "../http.ts";
import * as policy from "../policy.ts";
import * as rbac from "../rbac.ts";
import type { RelayComment, RelayRequest } from "../relay.ts";
import { makeSignedDevice } from "../relaySign.ts";
import { parseRequestSignature } from "../signing.ts";
import * as store from "../store.ts";
import * as roles from "../storeRbac.ts";
import * as security from "../storeSecurity.ts";
import * as team from "../storeTeam.ts";

const VIEW_POLL_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 60_000;
const META_TIMEOUT_MS = 15_000;
/** A sealed comment (4000 characters of text, sealed and base64url) or title fits in this. */
const SEALED_COMMENT_MAX = 24_000;
const SEALED_TITLE_MAX = 2_000;

export function registerShareRoutes(kit: Kit) {
  const { db, route, relay, notifier } = kit;

  const loadShare = (shareId: string) => {
    const share = store.getShare(db, shareId);
    if (share === null) throw notFound("This chat is no longer shared.");
    const environment = store.getEnvironment(db, share.environmentId);
    if (environment === null) throw notFound("This chat is no longer shared.");
    return { share, environment };
  };

  /**
   * v9: the role's chat permissions on top of the share rules. The owner of a shared chat keeps
   * every right on their own share; everyone else also needs "chats: vede" to watch, "chats:
   * creează" to comment or copy, "chats: trimite" to write.
   */
  const allows = (userId: string, share: store.StoredShare, permission: rbac.Permission) =>
    share.ownerUserId === userId || rbac.can(roles.accessOf(db, share.companyId, userId), permission);
  const shareRights = (userId: string, share: store.StoredShare, environment: store.StoredEnvironment) => {
    const base = policy.sharePermissions(userId, share, environment, store.membershipLookup(db, userId));
    const view = base.view && allows(userId, share, "chats:vede");
    return {
      view,
      comment: view && base.comment && allows(userId, share, "chats:creeaza"),
      prompt: view && base.prompt && allows(userId, share, "chats:trimite"),
      copy: view && base.copy && allows(userId, share, "chats:creeaza"),
      acceptHandover: base.acceptHandover && allows(userId, share, "chats:creeaza"),
      revoke: base.revoke,
    };
  };
  const rightsOf = (userId: string, shareId: string) => {
    const { share, environment } = loadShare(shareId);
    return { share, environment, rights: shareRights(userId, share, environment) };
  };

  const describeShare = (user: store.User, share: store.StoredShare) => {
    const environment = store.getEnvironment(db, share.environmentId);
    if (environment === null) return null;
    const permissions = shareRights(user.id, share, environment);
    if (!permissions.view) return null;
    const owner = store.getUser(db, share.ownerUserId);
    const audience = share.audienceUserId === null ? null : store.getUser(db, share.audienceUserId);
    return {
      id: share.id,
      // Plaintext only on shares made before v4; the app asks the runner for the real title.
      title: share.title,
      titleSealed: share.titleSealed !== null,
      kind: share.kind,
      threadId: share.ownerUserId === user.id ? share.threadId : null,
      companyId: share.companyId,
      companyName: store.getCompany(db, share.companyId)?.name ?? "",
      ownerName: owner?.name ?? "",
      mine: share.ownerUserId === user.id,
      audienceName: audience?.name ?? null,
      environmentName: environment.name,
      online: relay.isOnline(environment.id),
      handoverState: share.handoverState,
      createdAt: share.createdAt,
      permissions,
      // For end-to-end encryption: the runner's public keys (the client pins them on first use).
      runner: { environmentId: environment.id, keys: team.environmentKeys(db, environment.id) },
      comments: store.commentsOf(db, share.id).length,
    };
  };

  route("GET", "/v1/shares", ({ session }) => ({
    shares: store
      .candidateSharesFor(db, session.user.id)
      .map((share) => describeShare(session.user, share))
      .filter((share) => share !== null),
  }));

  route("POST", "/v1/shares", ({ session, body }) => {
    const user = session.user;
    const environmentId = str(body, "environmentId", 80);
    const companyId = str(body, "companyId", 80);
    const kind = str(body, "kind", 20) as policy.ShareKind;
    if (!["personal", "company", "handover"].includes(kind)) throw bad("Unknown share kind.");
    const audienceUserId = optStr(body, "audienceUserId", 80);
    const environment = store.getEnvironment(db, environmentId);
    if (environment === null) throw notFound("No such machine.");
    const decision = policy.canCreateShare({
      actorUserId: user.id,
      kind,
      environment,
      companyId,
      actorRole: store.roleOf(db, companyId, user.id),
      audienceUserId,
      audienceRole: audienceUserId === null ? null : store.roleOf(db, companyId, audienceUserId),
    });
    if (!decision.ok) throw forbidden(decision.reason);
    kit.requirePermission(companyId, user.id, "chats:creeaza");
    const share = store.createShare(db, {
      environmentId,
      threadId: str(body, "threadId", 200),
      ownerUserId: user.id,
      companyId,
      kind,
      audienceUserId,
      // A plaintext `title` from an older app is ignored on purpose: the hub keeps no chat titles.
      titleSealed: optStr(body, "titleSealed", SEALED_TITLE_MAX),
    });
    const audience = policy.shareAudience(share, team.fullMembersOf(db, companyId).map((member) => member.id));
    const companyName = store.getCompany(db, companyId)?.name ?? "your company";
    notifier.people({
      userIds: audience,
      kind: kind === "handover" ? "handover" : "share",
      companyId,
      shareId: share.id,
      actorUserId: user.id,
      title: kind === "handover" ? `${user.name} wants to hand over a chat to you` : `${user.name} shared a chat`,
      body:
        kind === "handover"
          ? `${user.name} is handing over a chat to you in ${companyName}. Accept it to continue the work on your side.`
          : `${user.name} shared a chat with ${audienceUserId === null ? "the company" : "you"} in ${companyName}.`,
    });
    return describeShare(user, share);
  });

  route("GET", "/v1/shares/:id", ({ session, params }) => {
    const { share } = loadShare(params.id!);
    const described = describeShare(session.user, share);
    if (described === null) throw notFound("This chat is no longer shared.");
    // Legacy (pre-v4) comments are plaintext; sealed ones are only announced here and read
    // through the runner (POST /v1/shares/:id/meta).
    const comments = store.commentsOf(db, share.id).map((comment) =>
      comment.sealed === null
        ? {
            id: comment.id,
            messageId: comment.messageId,
            body: comment.body,
            createdAt: comment.createdAt,
            authorId: comment.authorId,
            authorName: comment.authorName,
            legacy: true,
          }
        : {
            id: comment.id,
            messageId: null,
            body: null,
            createdAt: comment.createdAt,
            authorId: comment.authorId,
            authorName: comment.authorName,
            sealed: true,
          },
    );
    return { share: described, comments };
  });

  route("DELETE", "/v1/shares/:id", ({ session, params }) => {
    const { share } = loadShare(params.id!);
    if (!policy.canRevokeShare(session.user.id, share, store.membershipLookup(db, session.user.id))) {
      throw notFound("This chat is no longer shared.");
    }
    store.revokeShare(db, share.id);
    return { ok: true };
  });

  route("POST", "/v1/shares/:id/comments", ({ session, params, body }) => {
    const user = session.user;
    const { share, rights } = rightsOf(user.id, params.id!);
    if (!rights.view) throw notFound("This chat is no longer shared.");
    if (!rights.comment) throw forbidden("Your role does not allow comments here (chats: creeaza).");
    const input = obj(body, "input");
    if (typeof body.body === "string" && Object.keys(input).length === 0) {
      throw bad("Comments are end-to-end encrypted now. Update Zen Staff to comment.");
    }
    if (Object.keys(input).some((key) => key !== "sealed")) throw bad("Send only the sealed comment.");
    const sealed = str(input, "sealed", SEALED_COMMENT_MAX);
    const { sig, device } = signedDevice(session, "comment.add", share.id, input, body.sig);
    const comment = store.addComment(db, {
      shareId: share.id,
      authorUserId: user.id,
      sealed,
      sig: JSON.stringify(sig),
      deviceKeyId: device.keyId,
    });
    const involved = new Set([share.ownerUserId, ...store.commentsOf(db, share.id).map((item) => item.authorId)]);
    involved.delete(user.id);
    notifier.people({
      userIds: [...involved],
      kind: "comment",
      companyId: share.companyId,
      shareId: share.id,
      actorUserId: user.id,
      title: `${user.name} commented on a shared chat`,
      body: `${user.name} left a comment on a chat shared in ${store.getCompany(db, share.companyId)?.name ?? "your company"}.`,
    });
    return comment;
  });

  // ---- Relay -----------------------------------------------------------------------------------

  /** Checks the device signature on a relay call; returns what the runner needs to check it too. */
  const signedDevice = makeSignedDevice(db);

  const relayFor = (
    session: security.SessionInfo,
    share: store.StoredShare,
    op: string,
    body: Json,
    timeoutMs: number,
  ) => {
    const input = obj(body, "input");
    const { sig, device } = signedDevice(session, op, share.id, input, body.sig);
    const request: RelayRequest = {
      op,
      shareId: share.id,
      threadId: share.threadId,
      shareKind: share.kind,
      companyId: share.companyId,
      actor: { userId: session.user.id, email: session.user.email, name: session.user.name },
      actorAccess: roles.accessForClients(db, share.companyId, session.user.id),
      input,
      sig,
      device,
    };
    return { request, call: () => relay.call(share.environmentId, request, timeoutMs) };
  };

  route("POST", "/v1/shares/:id/view", ({ session, params, body }) => {
    const { share, rights } = rightsOf(session.user.id, params.id!);
    if (!rights.view) throw notFound("This chat is no longer shared.");
    return relayFor(session, share, "thread.view", body, VIEW_POLL_TIMEOUT_MS + 5_000).call();
  });

  route("POST", "/v1/shares/:id/export", ({ session, params, body }) => {
    const { share, rights } = rightsOf(session.user.id, params.id!);
    if (!rights.copy) throw forbidden("You cannot copy this chat.");
    return relayFor(session, share, "thread.export", body, RELAY_TIMEOUT_MS).call();
  });

  /** Title and comments, opened by the runner and sealed back to the reader's device. */
  route("POST", "/v1/shares/:id/meta", ({ session, params, body }) => {
    const { share, rights } = rightsOf(session.user.id, params.id!);
    if (!rights.view) throw notFound("This chat is no longer shared.");
    const { request } = relayFor(session, share, "thread.meta", body, META_TIMEOUT_MS);
    const comments: Array<RelayComment> = store.commentsOf(db, share.id).map((comment) => {
      const base = { id: comment.id, authorId: comment.authorId, authorName: comment.authorName, createdAt: comment.createdAt };
      if (comment.sealed === null) return { ...base, legacy: { body: comment.body ?? "", messageId: comment.messageId } };
      const key = comment.deviceKeyId === null ? null : security.getDeviceKey(db, comment.deviceKeyId);
      const sig = comment.sig === null ? null : parseRequestSignature(JSON.parse(comment.sig));
      return {
        ...base,
        sealed: comment.sealed,
        ...(sig === null ? {} : { sig }),
        ...(key === null
          ? {}
          : {
              device: {
                userId: key.userId,
                keyId: key.keyId,
                signPublicKey: key.signPublicKey,
                boxPublicKey: key.boxPublicKey,
                certs: security.certsOf(db, key.keyId),
              },
            }),
      };
    });
    return relay.call(share.environmentId, { ...request, comments, titleSealed: share.titleSealed }, META_TIMEOUT_MS);
  });

  /** One attachment for "Continue on my side" / a hand-over, sealed like the export. */
  route("POST", "/v1/shares/:id/attachment", ({ session, params, body }) => {
    const { share, rights } = rightsOf(session.user.id, params.id!);
    if (!rights.copy && !rights.acceptHandover) throw forbidden("You cannot copy this chat.");
    return relayFor(session, share, "thread.attachment", body, RELAY_TIMEOUT_MS).call();
  });

  route("POST", "/v1/shares/:id/prompt", ({ session, params, body }) => {
    const { share, rights } = rightsOf(session.user.id, params.id!);
    if (!rights.view) throw notFound("This chat is no longer shared.");
    if (!rights.prompt) {
      throw forbidden(
        share.kind === "personal"
          ? "This chat runs on a colleague's own AI account. Use Continue on my side to work on it."
          : "You cannot write in this chat.",
      );
    }
    return relayFor(session, share, "thread.prompt", body, RELAY_TIMEOUT_MS).call();
  });

  route("POST", "/v1/shares/:id/handover/accept", ({ session, params, body }) => {
    const { share } = loadShare(params.id!);
    if (!shareRights(session.user.id, share, loadShare(share.id).environment).acceptHandover) {
      throw forbidden("This hand-over is not for you or is no longer pending.");
    }
    return relayFor(session, share, "thread.export", body, RELAY_TIMEOUT_MS).call();
  });

  route("POST", "/v1/shares/:id/handover/complete", ({ session, params, body }) => {
    const { share } = loadShare(params.id!);
    if (!shareRights(session.user.id, share, loadShare(share.id).environment).acceptHandover) {
      throw forbidden("This hand-over is not for you or is no longer pending.");
    }
    // Signed by the colleague, so the source runner archives only on their word.
    const { request } = relayFor(session, share, "thread.handedOver", body, RELAY_TIMEOUT_MS);
    store.setHandoverState(db, share.id, "completed");
    for (const other of store.liveSharesOfEnvironment(db, share.environmentId)) {
      if (other.threadId === share.threadId) store.revokeShare(db, other.id);
    }
    relay.notify(share.environmentId, request);
    notifier.people({
      userIds: [share.ownerUserId],
      kind: "handover.accepted",
      companyId: share.companyId,
      shareId: share.id,
      actorUserId: session.user.id,
      title: `${session.user.name} accepted your hand-over`,
      body: `${session.user.name} took over the chat you handed over. Your copy was archived.`,
    });
    return { ok: true };
  });

  route("POST", "/v1/shares/:id/handover/decline", ({ session, params }) => {
    const { share } = loadShare(params.id!);
    if (!shareRights(session.user.id, share, loadShare(share.id).environment).acceptHandover) {
      throw forbidden("This hand-over is not for you or is no longer pending.");
    }
    store.setHandoverState(db, share.id, "declined");
    notifier.people({
      userIds: [share.ownerUserId],
      kind: "handover.declined",
      companyId: share.companyId,
      shareId: share.id,
      actorUserId: session.user.id,
      title: `${session.user.name} declined your hand-over`,
      body: `${session.user.name} declined the chat you handed over. It stays with you.`,
    });
    return { ok: true };
  });
}
