// Client approval links (v14). The app uploads a copy of a finished deliverable for one of the
// freelancer's hub companies; the client opens `/aprobare/<token>` in any browser, without an
// account, and answers "Aprobă" or "Cere modificări". The app reads the answer back by id.
//
// - Upload: a signed-in person with `chats:trimite` in the company. Images, video, PDF and text
//   only, checked by their bytes (approvalFiles.ts), per-file, per-link and per-company caps.
// - The link: 256 random bits, only the SHA-256 kept; expires (default 14 days, at most 90), can be
//   revoked, shows only that deliverable. Unknown, expired and revoked links answer the same page.
// - The page: no script (CSP), noindex, no referrer, no framing; files served with their checked
//   type, nosniff, a sandbox CSP and Content-Disposition (PDF and text download, images and video
//   inline, Range for video).
// - Rate limits per address and per link; the form refuses another site's Origin.
// - Events go to the audit log; the sender gets an in-app notice and, for an answer, an e-mail.
// - Expired and revoked links lose their files within the hour; rows go 90 days later.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Kit } from "../app.ts";
import { APPROVAL_LIMITS, ApprovalFileError, stripControl, type ApprovalStorage, checkFile, type CheckedFile } from "../approvalFiles.ts";
import { approvalPage, approvalText, gonePage, messagePage, type RenderedPage, SECURITY_HEADERS } from "../approvalPage.ts";
import { bad, clientIp, HttpError, makeLimiter, notFound, optStr, str, type Json } from "../http.ts";
import { approvalDecidedMail } from "../mailTemplates.ts";
import * as rbac from "../rbac.ts";
import * as store from "../store.ts";
import * as approvals from "../storeApprovals.ts";
import * as roles from "../storeRbac.ts";
import * as team from "../storeTeam.ts";

export const APPROVAL_PATH = "/aprobare/";
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const KEEP_ROWS_DAYS = 90;
/** Default cap of stored files per company (links whose files are still there). */
export const DEFAULT_COMPANY_BYTES = 1024 * 1024 * 1024;

/** Link previews (WhatsApp, Slack, mail scanners) fetch the page too; they do not count as "Văzut". */
const PREVIEW_AGENTS = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|linkedin|skype|embedly|outlook|googleimageproxy|curl|wget|python-requests|headless/i;

export function isPreviewAgent(userAgent: string | undefined): boolean {
  return userAgent === undefined || userAgent.trim() === "" || PREVIEW_AGENTS.test(userAgent);
}

export interface ApprovalView {
  readonly id: string;
  readonly companyId: string;
  readonly title: string;
  readonly clientName: string;
  readonly language: approvals.ApprovalLanguage;
  readonly status: approvals.ApprovalStatus;
  readonly active: boolean;
  readonly comment: string | null;
  readonly decidedByName: string | null;
  readonly viewCount: number;
  readonly firstViewedAt: string | null;
  readonly lastViewedAt: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly files: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly size: number }>;
}

export function approvalView(approval: approvals.Approval, files: ReadonlyArray<approvals.ApprovalFileRow>, now = Date.now()): ApprovalView {
  return {
    id: approval.id,
    companyId: approval.companyId,
    title: approval.title,
    clientName: approval.clientName,
    language: approval.language,
    status: approval.status,
    active: approvals.isOpen(approval, now),
    comment: approval.comment,
    decidedByName: approval.decidedByName,
    viewCount: approval.viewCount,
    firstViewedAt: approval.firstViewedAt,
    lastViewedAt: approval.lastViewedAt,
    decidedAt: approval.decidedAt,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    revokedAt: approval.revokedAt,
    files: files.filter((file) => file.role === "file").map((file) => ({ name: file.name, kind: file.kind, size: file.size })),
  };
}

/** Removes the files of expired and revoked links, then rows closed for 90 days. */
export function cleanupApprovals(kit: Pick<Kit, "db" | "log">, storage: ApprovalStorage, now = new Date()): number {
  const { db } = kit;
  const due = approvals.dueForCleanup(db, now.toISOString());
  for (const id of due) {
    const approval = approvals.getApproval(db, id);
    storage.remove(id);
    approvals.markFilesDeleted(db, id);
    if (approval !== null && approval.revokedAt === null) {
      team.audit(db, { companyId: approval.companyId, actorUserId: null, action: "approval.expire", detail: `Approval link "${approval.title}" expired; its files were deleted`, target: id });
    }
  }
  const pruned = approvals.pruneOld(db, new Date(now.getTime() - KEEP_ROWS_DAYS * 86_400_000).toISOString());
  if (due.length > 0 || pruned > 0) kit.log(`[approvals] cleanup: ${due.length} links closed, ${pruned} old rows removed`);
  return due.length;
}

const languageOf = (value: unknown): approvals.ApprovalLanguage => (value === "en" ? "en" : "ro");

const sendPage = (res: ServerResponse, status: number, page: RenderedPage) => {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": page.csp });
  res.end(page.html);
};

/** `filename*` for any name, plus an ASCII fallback. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\;]/g, "_") || "fisier";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function readForm(req: IncomingMessage, max = 16 * 1024): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, "Request too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

export function registerApprovalRoutes(kit: Kit, storage: ApprovalStorage) {
  const { db, route, config, log } = kit;
  const companyCap = config.approvalCompanyBytes ?? DEFAULT_COMPANY_BYTES;
  const createLimiter = makeLimiter(30, 60 * 60_000, "Too many approval links in an hour. Wait a little.");
  const pageLimiter = makeLimiter(120, 60_000);
  const fileLimiter = makeLimiter(600, 60_000);
  const decideIpLimiter = makeLimiter(20, 10 * 60_000);
  const decideLinkLimiter = makeLimiter(10, 60 * 60_000);

  const timer = setInterval(() => {
    try {
      cleanupApprovals(kit, storage);
    } catch (error) {
      log(`[approvals] cleanup failed: ${String(error)}`);
    }
  }, 60 * 60_000);
  timer.unref();
  cleanupApprovals(kit, storage);

  const canManage = (companyId: string, userId: string) => {
    const access = roles.accessOf(db, companyId, userId);
    return access !== null && rbac.can(access, "chats:administreaza");
  };

  /** What the sender may see: their own links, and every link of a company they administer. */
  const visibleTo = (approval: approvals.Approval, userId: string) =>
    store.roleOf(db, approval.companyId, userId) !== null && (approval.createdBy === userId || canManage(approval.companyId, userId));

  route(
    "POST",
    "/v1/companies/:id/approvals",
    ({ session, params, body }) => {
      const companyId = params.id!;
      kit.requirePermission(companyId, session.user.id, "chats:trimite");
      createLimiter(`user:${session.user.id}`);
      const title = str(body, "title", 160);
      const note = optStr(body, "note", 2000) ?? "";
      const language = languageOf(body.language);
      const days = body.expiresInDays === undefined ? DEFAULT_DAYS : Number(body.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw bad(`expiresInDays must be between 1 and ${MAX_DAYS}.`);
      const client = (body.client ?? {}) as Json;
      if (typeof client !== "object" || Array.isArray(client)) throw bad("client must be an object.");
      const clientName = str(client, "name", 80);
      const color = optStr(client, "color", 7);
      if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw bad("client.color must look like #2F6F5E.");
      const rawFiles = body.files;
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw bad("Send at least one file.");
      if (rawFiles.length > APPROVAL_LIMITS.filesPerLink) throw bad(`At most ${APPROVAL_LIMITS.filesPerLink} files per link.`);
      let checked: Array<{ role: "file" | "logo"; file: CheckedFile }>;
      try {
        checked = rawFiles.map((raw) => ({ role: "file" as const, file: checkFile((raw ?? {}) as { name: unknown; data: unknown }, "file") }));
        const logo = client.logo as { name: unknown; data: unknown } | undefined | null;
        if (logo !== undefined && logo !== null) checked.push({ role: "logo", file: checkFile(logo, "logo") });
      } catch (error) {
        if (error instanceof ApprovalFileError) throw new HttpError(415, error.message, "unsupported_file");
        throw error;
      }
      const total = checked.reduce((sum, item) => sum + item.file.bytes.length, 0);
      if (total > APPROVAL_LIMITS.bytesPerLink) throw new HttpError(413, `One link holds at most ${APPROVAL_LIMITS.bytesPerLink / 1024 / 1024} MB.`, "too_large");
      if (approvals.storedBytesOf(db, companyId) + total > companyCap) {
        throw new HttpError(413, "The company's space for approval links is full. Revoke old links or wait for them to expire.", "storage_full");
      }
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const { approval, token } = approvals.createApproval(db, {
        companyId,
        createdBy: session.user.id,
        title,
        note,
        clientName,
        clientColor: color,
        language,
        expiresAt,
        files: checked.map(({ role, file }) => ({ role, kind: file.kind, name: file.name, mime: file.mime, size: file.bytes.length, sha256: file.sha256, width: file.width, height: file.height })),
      });
      try {
        checked.forEach(({ file }, index) => storage.write(approval.id, index, file.bytes));
      } catch (error) {
        storage.remove(approval.id);
        db.prepare("DELETE FROM client_approvals WHERE id = ?").run(approval.id);
        log(`[approvals] storing files failed: ${String(error)}`);
        throw new HttpError(507, "The hub could not store the files. Try again later.");
      }
      const files = approvals.filesOf(db, approval.id);
      team.audit(db, {
        companyId,
        actorUserId: session.user.id,
        action: "approval.create",
        detail: `Approval link "${title}" for ${clientName}: ${files.filter((file) => file.role === "file").length} files, ${Math.ceil(total / 1024)} KB, expires ${expiresAt.slice(0, 10)}`,
        target: approval.id,
      });
      return { approval: approvalView(approval, files), url: `${config.publicUrl}${APPROVAL_PATH}${token}` };
    },
    "full",
    { maxBody: Math.ceil((APPROVAL_LIMITS.bytesPerLink + APPROVAL_LIMITS.logo) * 1.37) + 64 * 1024 },
  );

  route("GET", "/v1/approvals", ({ session, query }) => {
    const ids = (query.get("ids") ?? "").split(",").map((id) => id.trim()).filter((id) => /^apr_[A-Za-z0-9_-]{4,40}$/.test(id)).slice(0, 100);
    const now = Date.now();
    return {
      approvals: approvals
        .approvalsOfIds(db, ids)
        .filter((approval) => visibleTo(approval, session.user.id))
        .map((approval) => approvalView(approval, approvals.filesOf(db, approval.id), now)),
    };
  });

  route("GET", "/v1/companies/:id/approvals", ({ session, params }) => {
    const companyId = params.id!;
    kit.requirePermission(companyId, session.user.id, "chats:vede");
    const all = canManage(companyId, session.user.id);
    const now = Date.now();
    return {
      approvals: approvals.approvalsOfCompany(db, companyId, all ? null : session.user.id).map((approval) => approvalView(approval, approvals.filesOf(db, approval.id), now)),
      storedBytes: approvals.storedBytesOf(db, companyId),
      capBytes: companyCap,
    };
  });

  route("POST", "/v1/approvals/:id/revoke", ({ session, params }) => {
    const approval = approvals.getApproval(db, params.id!);
    if (approval === null || !visibleTo(approval, session.user.id)) throw notFound("No such approval link.");
    if (approvals.revoke(db, approval.id)) {
      storage.remove(approval.id);
      approvals.markFilesDeleted(db, approval.id);
      team.audit(db, { companyId: approval.companyId, actorUserId: session.user.id, action: "approval.revoke", detail: `Approval link "${approval.title}" for ${approval.clientName} revoked`, target: approval.id });
    }
    const current = approvals.getApproval(db, approval.id)!;
    return { approval: approvalView(current, approvals.filesOf(db, current.id)) };
  });

  // ---- The client's side: no account ------------------------------------------------------------

  const notifySender = (approval: approvals.Approval, kind: "viewed" | "approved" | "changes") => {
    if (approval.createdBy === null) return;
    const sender = store.getUser(db, approval.createdBy);
    if (sender === null) return;
    const prefs = team.preferencesOf(db, sender.id);
    const ro = prefs.language !== "en";
    const title =
      kind === "viewed"
        ? ro
          ? `${approval.clientName} a deschis „${approval.title}”`
          : `${approval.clientName} opened "${approval.title}"`
        : kind === "approved"
          ? ro
            ? `${approval.clientName} a aprobat „${approval.title}”`
            : `${approval.clientName} approved "${approval.title}"`
          : ro
            ? `${approval.clientName} a cerut modificări la „${approval.title}”`
            : `${approval.clientName} asked for changes to "${approval.title}"`;
    const body = kind === "changes" ? (approval.comment ?? "").slice(0, 500) : "";
    team.addNotification(db, { userId: sender.id, kind: `approval.${kind}`, companyId: approval.companyId, shareId: null, actorUserId: null, title, body });
    if (kind === "viewed" || !prefs.notifyEmail) return;
    const mail = approvalDecidedMail(prefs.language, {
      decision: kind,
      title: approval.title,
      clientName: approval.clientName,
      who: approval.decidedByName,
      comment: approval.comment,
      publicUrl: config.publicUrl,
    });
    kit.mailer.send({ to: sender.email, ...mail }).catch((error: unknown) => log(`[mail] approval notice to=${sender.email} failed: ${String(error)}`));
  };

  const limited = (res: ServerResponse, language: approvals.ApprovalLanguage, error: unknown) => {
    if (error instanceof HttpError && error.status === 429) {
      const t = approvalText(language);
      res.setHeader("retry-after", String((error as HttpError & { retryAfter?: number }).retryAfter ?? 60));
      sendPage(res, 429, messagePage(language, t.tooMany, t.tooMany));
      return true;
    }
    return false;
  };

  const serveFile = (req: IncomingMessage, url: URL, res: ServerResponse, approval: approvals.Approval, index: number) => {
    const file = approvals.filesOf(db, approval.id).find((candidate) => candidate.index === index);
    const bytes = file === undefined ? null : storage.read(approval.id, index);
    if (file === undefined || bytes === null) {
      res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("Not found.");
      return;
    }
    const download = url.searchParams.get("download") === "1" || file.kind === "pdf" || file.kind === "text";
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      "content-type": file.mime,
      "content-disposition": disposition(download ? "attachment" : "inline", file.name),
      // Even opened on its own, a file cannot run anything on the hub's origin.
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=300",
      "accept-ranges": "bytes",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range !== null && (range[1] !== "" || range[2] !== "")) {
      const size = bytes.length;
      let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
      res.end(bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(bytes.length) });
    res.end(bytes);
  };

  kit.pagePrefix(APPROVAL_PATH, (req, url, res) => {
    const parts = url.pathname.slice(APPROVAL_PATH.length).split("/");
    const token = parts[0] ?? "";
    const requested = url.searchParams.get("lang");
    const approval = approvals.approvalByToken(db, token);
    const language = requested === "en" || requested === "ro" ? requested : (approval?.language ?? "ro");
    const ip = clientIp(req);
    try {
      if (parts[1] === "f") fileLimiter(`ip:${ip}`);
      else pageLimiter(`ip:${ip}`);
    } catch (error) {
      if (limited(res, language, error)) return;
      throw error;
    }
    if (approval === null || !approvals.isOpen(approval)) return sendPage(res, 404, gonePage(language));
    if (parts[1] === "f" && parts.length === 3 && /^\d{1,2}$/.test(parts[2]!)) return serveFile(req, url, res, approval, Number(parts[2]));
    if (parts.length !== 1) return sendPage(res, 404, gonePage(language));
    const result = url.searchParams.get("r");
    const notice = result === "approved" || result === "changes" || result === "comment-required" || result === "already" ? result : null;
    // A result page after the form, or a link preview, is not the client looking at it.
    if (notice === null && !isPreviewAgent(req.headers["user-agent"])) {
      if (approvals.recordView(db, approval.id)) {
        team.audit(db, { companyId: approval.companyId, actorUserId: null, action: "approval.view", detail: `Approval link "${approval.title}" opened by the client`, target: approval.id });
        notifySender(approval, "viewed");
      }
    }
    const current = approvals.getApproval(db, approval.id)!;
    const files = approvals.filesOf(db, current.id);
    const texts = new Map<number, string>();
    for (const file of files) {
      if (file.kind !== "text" || file.role !== "file") continue;
      const bytes = storage.read(current.id, file.index);
      if (bytes !== null) texts.set(file.index, bytes.toString("utf8"));
    }
    const sender = current.createdBy === null ? null : store.getUser(db, current.createdBy);
    const base = `${APPROVAL_PATH}${token}`;
    sendPage(
      res,
      200,
      approvalPage({
        approval: current,
        files,
        texts,
        senderName: sender?.name ?? "Zen Staff",
        base,
        language,
        notice,
        switchHref: `${base}?lang=${language === "ro" ? "en" : "ro"}`,
      }),
    );
  });

  kit.formPrefix(APPROVAL_PATH, async (req, url, res) => {
    const parts = url.pathname.slice(APPROVAL_PATH.length).split("/");
    const token = parts[0] ?? "";
    const approval = approvals.approvalByToken(db, token);
    const language = approval?.language ?? "ro";
    if (parts.length !== 2 || parts[1] !== "decizie") return sendPage(res, 404, gonePage(language));
    // A form posted from another site is refused (the browser always sends Origin on POST).
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null" && origin !== new URL(config.publicUrl).origin) {
      const t = approvalText(language);
      return sendPage(res, 403, messagePage(language, t.goneTitle, t.goneText));
    }
    try {
      decideIpLimiter(`ip:${clientIp(req)}`);
      decideLinkLimiter(`link:${token.slice(0, 16)}`);
    } catch (error) {
      if (limited(res, language, error)) return;
      throw error;
    }
    if (approval === null || !approvals.isOpen(approval)) return sendPage(res, 404, gonePage(language));
    const form = await readForm(req);
    const decision = form.get("decision") === "approved" ? "approved" : form.get("decision") === "changes" ? "changes" : null;
    const comment = (form.get("comment") ?? "").trim().slice(0, 2000);
    const name = stripControl(form.get("name") ?? "").trim().slice(0, 80);
    const back = (result: string, anchor = "") => {
      const lang = url.searchParams.get("lang");
      res.writeHead(303, { ...SECURITY_HEADERS, location: `${APPROVAL_PATH}${token}?r=${result}${lang === "en" || lang === "ro" ? `&lang=${lang}` : ""}${anchor}` });
      res.end();
    };
    if (decision === null) return back("comment-required", "#raspuns");
    if (decision === "changes" && comment === "") return back("comment-required", "#raspuns");
    if (!approvals.decide(db, approval.id, { decision, comment: comment === "" ? null : comment, name: name === "" ? null : name })) return back("already");
    const decided = approvals.getApproval(db, approval.id)!;
    team.audit(db, {
      companyId: decided.companyId,
      actorUserId: null,
      action: decision === "approved" ? "approval.approve" : "approval.changes",
      detail: `Approval link "${decided.title}": ${decision === "approved" ? "approved" : "changes requested"} by the client${name === "" ? "" : ` (${name})`}`,
      target: decided.id,
    });
    notifySender(decided, decision);
    back(decision);
  });
}
