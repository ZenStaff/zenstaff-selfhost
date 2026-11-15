// The community library ("Bibliotecă"): free packs anyone can publish, reviewed by us first.
//
// Authors (any signed-in person with a device key) send a submission: the pack files in the
// registry format, their metadata and images, signed by their device. The automatic checks
// (library/checks.ts) run on upload; a failing check refuses it with the reasons, warnings go to the
// reviewer. Hub reviewers (hub_staff, or HUB_LIBRARY_REVIEWERS; two-factor required) see the queue,
// the diff against the published version, the checks and a sandboxed test-run link, and approve,
// ask for changes or reject, with notes. Every decision, unpublish, feature and report is in the
// audit log. Published versions are served publicly as a registry index (`/v1/library/catalog`)
// the app merges with its built-in registry, with author credit, install counts and the verified
// badge. Community packs are never Enterprise and never carry secrets; nothing here costs money.
import type { Kit } from "../app.ts";
import { PLATFORM_CHAIN } from "../auditChain.ts";
import { newSecret } from "../crypto.ts";
import { bad, clientIp, forbidden, HttpError, notFound, optStr, RawBody, str } from "../http.ts";
import { tarGz, sha256Hex } from "../library/archive.ts";
import { blocking, LIMITS, parseMeta, runChecks, type Advisories, type Screenshot, testRunSteps, workflowIds, safePackPath } from "../library/checks.ts";
import { diffPacks } from "../library/diff.ts";
import { canonicalJson, sha256b64, SIGNATURE_MAX_SKEW_MS, statementMessage, verifyEd25519 } from "../signing.ts";
import * as security from "../storeSecurity.ts";
import * as lib from "../storeLibrary.ts";
import { staffBootstrap } from "../storeAdmin.ts";
import * as team from "../storeTeam.ts";

/** Submissions carry files as base64 in JSON: 5 MB of pack + 4 images of 600 KB, plus a third for base64. */
export const SUBMISSION_MAX_BODY = 10 * 1024 * 1024;
const MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

/** What the author's device signs for a submission (the app builds the same bytes, libraryPublish.ts). */
export function submissionStatement(input: { packId: string; version: string; digest: string; by: string; ts: number }) {
  return { kind: "zen-library-submission-v1", packId: input.packId, version: input.version, digest: input.digest, by: input.by, ts: input.ts };
}

/** SHA-256 (base64url) over the canonical JSON of everything submitted. */
export function submissionDigest(input: { packId: string; version: string; meta: unknown; files: Record<string, string>; screenshots: ReadonlyArray<unknown> }) {
  return sha256b64(canonicalJson({ packId: input.packId, version: input.version, meta: input.meta, files: input.files, screenshots: input.screenshots }));
}

const compareVersions = (left: string, right: string) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
};

export function registerLibraryRoutes(kit: Kit) {
  const { db, route, config, log } = kit;
  // Reviewers: HUB_LIBRARY_REVIEWERS, plus the operators (they may do everything in the admin).
  const boot = staffBootstrap({ adminEmails: config.adminEmails, statsEmails: config.stats?.emails, libraryReviewers: config.libraryReviewers });
  const reviewers = [...boot.reviewerEmails, ...boot.operatorEmails];
  const shareUrl = (slug: string) => `${config.publicUrl}/p/${slug}`;

  const advisories = (): Advisories => {
    const row = db.prepare("SELECT body FROM toolchain_advisories WHERE id = 1").get() as { body: string } | undefined;
    return row === undefined ? {} : ((JSON.parse(row.body) as { tools: Advisories }).tools ?? {});
  };

  // What reviewers decide is staff work, so it goes to the platform audit chain (Jurnal admin);
  // what authors and readers do stays in the hub chain.
  const STAFF_ACTION = /^(review|pack)\.|^author\.(un)?feature$|^report\.resolve$/;
  const audit = (actorUserId: string | null, action: string, detail: string) =>
    team.audit(db, { companyId: null, actorUserId, action: `library.${action}`, detail, ...(STAFF_ACTION.test(action) ? { chain: PLATFORM_CHAIN } : {}) });

  const notifyAuthor = (userId: string, title: string, body: string, actorUserId: string | null) =>
    team.addNotification(db, { userId, kind: "library", companyId: null, shareId: null, actorUserId, title, body });

  /** Reviewer routes: on the staff list, and with two-factor on and used for this session. */
  const requireReviewer = (session: security.SessionInfo) => {
    if (!lib.isReviewer(db, session.user, reviewers)) throw forbidden("Only Zen Staff reviewers see the review queue.");
    if (!security.totpState(db, session.user.id).enabled) throw new HttpError(403, "Reviewers must set up two-factor authentication first.", "two_factor_setup_required");
    if (session.mfaAt === null) throw new HttpError(403, "Enter the code from your authenticator app.", "two_factor_required");
  };

  const publishedOf = (pack: lib.LibraryPack) => (pack.publishedVersionId === null ? null : lib.getVersion(db, pack.publishedVersionId));

  const authorView = (author: lib.Author | null) =>
    author === null ? null : { slug: author.slug, name: author.displayName, company: author.company, bio: author.bio, featured: author.featured, url: `${config.publicUrl}/a/${author.slug}` };

  /** One published pack as a registry entry (the app's ZenRegistryEntry) with its community credit. */
  const catalogEntry = (pack: lib.LibraryPack & { installs: number }) => {
    const version = publishedOf(pack)!;
    const author = lib.authorOf(db, pack.authorUserId);
    return {
      id: pack.packId,
      name: version.meta.title,
      description: version.meta.description,
      category: version.meta.category,
      icon: version.meta.icon,
      version: version.version,
      author: author?.displayName ?? "Comunitate",
      kind: "pack",
      tags: ["community"],
      download: { url: `packs/${pack.slug}/${version.version}.tar.gz`, sha256: version.sha256, format: "tar.gz", size: version.size },
      ...(version.workflows === null ? {} : { workflows: version.workflows }),
      community: {
        slug: pack.slug,
        origin: "community",
        verified: true,
        featured: pack.featured,
        installs: pack.installs,
        licence: version.meta.licence,
        language: version.meta.language,
        changelog: version.meta.changelog,
        sampleOutput: version.meta.sampleOutput,
        publishedAt: version.decidedAt,
        shareUrl: shareUrl(pack.slug),
        screenshots: version.screenshots.map((_, index) => `packs/${pack.slug}/screens/${index}`),
        author: authorView(author),
      },
    };
  };

  // ---- Public: catalog, archives, images, pack and author pages' data -----------------------

  route(
    "GET",
    "/v1/library/catalog",
    () => ({
      version: 1,
      source: "zen-hub-library",
      entries: lib.publishedPacks(db).map(catalogEntry),
      // Packs we took down: installed copies show a warning.
      withdrawn: lib.unpublishedPacks(db).map((pack) => ({ id: pack.packId, slug: pack.slug, reason: pack.unpublishedReason })),
    }),
    "public",
  );

  const publicPack = (slug: string) => {
    const pack = lib.packBySlug(db, slug);
    if (pack === null || pack.state !== "published" || pack.publishedVersionId === null) throw notFound("No such pack in the library.");
    return pack;
  };

  route(
    "GET",
    "/v1/library/packs/:slug/:file",
    ({ params }) => {
      const pack = publicPack(params.slug!);
      const match = /^(\d+\.\d+\.\d+)\.tar\.gz$/.exec(params.file!);
      if (match === null) throw notFound();
      const version = lib.versionByNumber(db, pack.id, match[1]!);
      // Only published (or superseded, so an app that just read the catalog still gets its file).
      if (version === null || (version.status !== "published" && version.status !== "superseded")) throw notFound("No such version.");
      return new RawBody(lib.archiveOf(db, version.id)!, "application/gzip", {
        "cache-control": "public, max-age=3600, immutable",
        "content-disposition": `attachment; filename="${pack.packId}-${version.version}.tar.gz"`,
      });
    },
    "public",
  );

  route(
    "GET",
    "/v1/library/packs/:slug/screens/:index",
    ({ params }) => {
      const version = publishedOf(publicPack(params.slug!))!;
      const shot = version.screenshots[Number(params.index)];
      if (shot === undefined) throw notFound();
      return new RawBody(Buffer.from(shot.data, "base64"), shot.mime, {
        "cache-control": "public, max-age=3600",
        "content-security-policy": "default-src 'none'",
        "cross-origin-resource-policy": "cross-origin",
      });
    },
    "public",
  );

  route(
    "GET",
    "/v1/library/packs/:slug",
    ({ params }) => {
      const pack = publicPack(params.slug!);
      const entry = catalogEntry({ ...pack, installs: lib.installsOf(db, pack.id) });
      const history = lib
        .versionsOf(db, pack.id)
        .filter((version) => version.status === "published" || version.status === "superseded")
        .map((version) => ({ version: version.version, changelog: version.meta.changelog, publishedAt: version.decidedAt }));
      return { ...entry, history };
    },
    "public",
  );

  route(
    "GET",
    "/v1/library/authors/:slug",
    ({ params }) => {
      const author = lib.authorBySlug(db, params.slug!);
      if (author === null) throw notFound("No such author.");
      const packs = lib.publishedPacks(db).filter((pack) => pack.authorUserId === author.userId).map(catalogEntry);
      return { author: authorView(author), packs, totalInstalls: packs.reduce((sum, pack) => sum + pack.community.installs, 0) };
    },
    "public",
  );

  /** Counts an install: once per signed-in person, else once per address. */
  route(
    "POST",
    "/v1/library/packs/:slug/install",
    ({ req, params }) => {
      const pack = publicPack(params.slug!);
      const header = req.headers.authorization ?? "";
      const session = header.startsWith("Bearer ") ? security.sessionForToken(db, header.slice(7).trim()) : null;
      lib.countInstall(db, pack.id, session === null ? `ip:${clientIp(req)}` : `user:${session.user.id}`);
      return { installs: lib.installsOf(db, pack.id) };
    },
    "public",
  );

  // ---- Authors --------------------------------------------------------------------------------

  route("GET", "/v1/library/me", ({ session }) => {
    const author = lib.authorOf(db, session.user.id);
    const packs = lib.packsOfAuthor(db, session.user.id).map((pack) => ({
      slug: pack.slug,
      packId: pack.packId,
      state: pack.state,
      featured: pack.featured,
      unpublishedReason: pack.unpublishedReason,
      installs: lib.installsOf(db, pack.id),
      shareUrl: pack.state === "published" ? shareUrl(pack.slug) : null,
      versions: lib.versionsOf(db, pack.id).map((version) => ({
        id: version.id,
        version: version.version,
        title: version.meta.title,
        status: version.status,
        reviewNote: version.reviewNote,
        submittedAt: version.submittedAt,
        decidedAt: version.decidedAt,
        checks: version.checks,
      })),
    }));
    return { reviewer: lib.isReviewer(db, session.user, reviewers), author: authorView(author), packs };
  });

  route("PUT", "/v1/library/me/author", ({ session, body }) => {
    lib.ensureAuthor(db, session.user);
    lib.updateAuthor(db, session.user.id, { displayName: str(body, "displayName", 80), company: optStr(body, "company", 80), bio: optStr(body, "bio", 500) });
    audit(session.user.id, "author.update", `Author profile of ${session.user.email} updated`);
    return { author: authorView(lib.authorOf(db, session.user.id)) };
  });

  route(
    "POST",
    "/v1/library/submissions",
    ({ session, body }) => {
      const user = session.user;
      const signer = security.deviceKeyOfSession(db, session.hash);
      if (signer === null) throw bad("This session has no device key; publish from Zen Staff.");
      const packId = str(body, "packId", 64);
      const version = str(body, "version", 20);
      let meta;
      try {
        meta = parseMeta(body.meta);
      } catch (error) {
        throw bad((error as Error).message);
      }
      // Files: { path: base64 }. Paths are checked before anything is decoded.
      const rawFiles = body.files;
      if (rawFiles === null || typeof rawFiles !== "object" || Array.isArray(rawFiles)) throw bad("files must be an object of path to base64.");
      const files = new Map<string, Buffer>();
      for (const [path, data] of Object.entries(rawFiles as Record<string, unknown>)) {
        if (safePackPath(path) === null) throw bad(`Not allowed in a pack: ${path.slice(0, 120)}`);
        if (typeof data !== "string") throw bad(`${path}: send the file as base64.`);
        files.set(path, Buffer.from(data, "base64"));
      }
      const rawShots = body.screenshots ?? [];
      if (!Array.isArray(rawShots) || rawShots.length > LIMITS.screenshots * 2) throw bad("screenshots must be a short list.");
      const screenshots: Array<Screenshot> = rawShots.map((raw, index) => {
        const shot = raw as { name?: unknown; mime?: unknown; data?: unknown };
        if (typeof shot?.data !== "string" || typeof shot.mime !== "string" || !(MIMES as ReadonlyArray<string>).includes(shot.mime)) throw bad("Images are PNG, JPEG or WebP, as base64.");
        const name = typeof shot.name === "string" ? shot.name.slice(0, 80) : `image-${index + 1}`;
        return { name, mime: shot.mime as Screenshot["mime"], bytes: Buffer.from(shot.data, "base64") };
      });

      // The author's device signed exactly this submission.
      const ts = body.ts;
      if (typeof ts !== "number" || Math.abs(Date.now() - ts) > SIGNATURE_MAX_SKEW_MS) throw bad("The submission is too old; try again.");
      const digest = submissionDigest({ packId, version, meta: body.meta, files: rawFiles as Record<string, string>, screenshots: rawShots });
      const statement = submissionStatement({ packId, version, digest, by: user.id, ts });
      const signature = str(body, "signature", 200);
      if (!verifyEd25519(signer.signPublicKey, statementMessage(statement), signature)) throw bad("The submission is not signed by this device.");

      // Who owns the id, and is the version new?
      const existing = lib.packByPackId(db, packId);
      if (existing !== null && existing.authorUserId !== user.id) throw new HttpError(409, "This pack id belongs to another author. Pick another one.", "pack_id_taken");
      const published = existing === null ? null : publishedOf(existing);
      if (published !== null && compareVersions(version, published.version) <= 0) {
        throw new HttpError(409, `Version ${published.version} is already published; send a higher version.`, "version_not_newer");
      }

      const checks = runChecks({ packId, version, files, screenshots, previous: published?.files ?? null, advisories: advisories() });
      if (blocking(checks)) {
        audit(user.id, "submission.refused", `${packId} ${version} refused by the automatic checks`);
        throw Object.assign(new HttpError(422, "The pack did not pass the automatic checks.", "checks_failed"), { extra: { checks } });
      }

      const author = lib.ensureAuthor(db, user);
      const pack = existing ?? lib.createPack(db, { packId, title: meta.title, authorUserId: user.id });
      const archive = tarGz(files);
      const stored = lib.addVersion(db, {
        packRef: pack.id,
        version,
        meta,
        files,
        screenshots: screenshots.map((shot) => ({ name: shot.name, mime: shot.mime, data: shot.bytes.toString("base64") })),
        workflows: workflowIds(files),
        archive,
        sha256: sha256Hex(archive),
        checks,
        statement: canonicalJson(statement),
        signerKeyId: signer.keyId,
        signature,
        submittedBy: user.id,
      });
      audit(user.id, "submission.create", `${packId} ${version} sent for review by ${author.displayName}`);
      log(`[library] submission ${packId} ${version} (${stored.id})`);
      return { id: stored.id, slug: pack.slug, packId, version, status: stored.status, checks, shareUrl: shareUrl(pack.slug) };
    },
    "full",
    { maxBody: SUBMISSION_MAX_BODY },
  );

  route("POST", "/v1/library/packs/:slug/report", ({ session, params, body }) => {
    const pack = lib.packBySlug(db, params.slug!);
    if (pack === null || pack.state === "new") throw notFound("No such pack in the library.");
    const reason = str(body, "reason", 40);
    if (!["unsafe", "broken", "secrets", "spam", "copyright", "other"].includes(reason)) throw bad("reason must be unsafe, broken, secrets, spam, copyright or other.");
    const detail = optStr(body, "detail", 2000) ?? "";
    const id = lib.addReport(db, { packRef: pack.id, reporterUserId: session.user.id, reason, detail });
    audit(session.user.id, "report.create", `${pack.packId} reported (${reason})`);
    return { id };
  });

  // ---- Reviewers ------------------------------------------------------------------------------

  const queueItem = (version: lib.LibraryVersion) => {
    const pack = lib.packByRef(db, version.packRef)!;
    const author = lib.authorOf(db, pack.authorUserId);
    return {
      id: version.id,
      packId: pack.packId,
      slug: pack.slug,
      title: version.meta.title,
      version: version.version,
      status: version.status,
      author: authorView(author),
      submittedAt: version.submittedAt,
      previousVersion: publishedOf(pack)?.version ?? null,
      checks: version.checks.map((check) => ({ id: check.id, level: check.level, count: check.findings.length })),
      openReports: lib.openReportCount(db, pack.id),
    };
  };

  route("GET", "/v1/library/review/queue", ({ session }) => {
    requireReviewer(session);
    return { items: lib.queue(db).map(queueItem), openReports: lib.reportsOf(db, "open").length };
  });

  const reviewVersion = (session: security.SessionInfo, id: string) => {
    requireReviewer(session);
    const version = lib.getVersion(db, id);
    if (version === null) throw notFound("No such submission.");
    return version;
  };

  route("GET", "/v1/library/review/versions/:id", ({ session, params }) => {
    const version = reviewVersion(session, params.id!);
    const pack = lib.packByRef(db, version.packRef)!;
    const published = publishedOf(pack);
    const base = published !== null && published.id !== version.id ? published : null;
    return {
      ...queueItem(version),
      meta: version.meta,
      sha256: version.sha256,
      size: version.size,
      signerKeyId: version.signerKeyId,
      files: [...version.files].map(([path, bytes]) => ({ path, size: bytes.length })),
      checks: version.checks,
      diffAgainst: base?.version ?? null,
      diff: diffPacks(base?.files ?? null, version.files),
      screenshots: version.screenshots.map((shot) => ({ name: shot.name, src: `data:${shot.mime};base64,${shot.data}` })),
      reviews: lib.reviewsOf(db, version.id),
      reviewNote: version.reviewNote,
      testRun: testRunSteps({ previewIndexUrl: null, packId: pack.packId, version: version.version, workflows: version.workflows }),
    };
  });

  /** A 2-hour link to a registry index with only this version, to paste in a sandboxed Zen Staff. */
  route("POST", "/v1/library/review/versions/:id/preview", ({ session, params }) => {
    const version = reviewVersion(session, params.id!);
    const pack = lib.packByRef(db, version.packRef)!;
    const token = newSecret("lpv").replace(/^lpv_/, "");
    lib.createPreview(db, version.id, session.user.id, token);
    const url = `${config.publicUrl}/v1/library/preview/${token}/catalog.json`;
    audit(session.user.id, "review.preview", `Test link made for ${pack.packId} ${version.version}`);
    return { url, expiresInMinutes: lib.PREVIEW_TTL_MS / 60_000, steps: testRunSteps({ previewIndexUrl: url, packId: pack.packId, version: version.version, workflows: version.workflows }) };
  });

  route(
    "GET",
    "/v1/library/preview/:token/:file",
    ({ params }) => {
      const versionId = lib.previewVersion(db, params.token!);
      if (versionId === null) throw notFound("This test link has expired.");
      const version = lib.getVersion(db, versionId)!;
      const pack = lib.packByRef(db, version.packRef)!;
      if (params.file === "pack.tar.gz") return new RawBody(lib.archiveOf(db, version.id)!, "application/gzip");
      if (params.file !== "catalog.json") throw notFound();
      return {
        version: 1,
        source: "zen-hub-library-preview",
        entries: [
          {
            id: pack.packId,
            name: `${version.meta.title} (verificare)`,
            description: version.meta.description,
            category: version.meta.category,
            icon: version.meta.icon,
            version: version.version,
            author: lib.authorOf(db, pack.authorUserId)?.displayName ?? "Comunitate",
            kind: "pack",
            tags: ["community", "review"],
            download: { url: "pack.tar.gz", sha256: version.sha256, format: "tar.gz", size: version.size },
            ...(version.workflows === null ? {} : { workflows: version.workflows }),
            community: { slug: pack.slug, origin: "community", verified: false, featured: false, installs: 0 },
          },
        ],
      };
    },
    "public",
  );

  route("POST", "/v1/library/review/versions/:id/decision", ({ session, params, body }) => {
    const version = reviewVersion(session, params.id!);
    if (version.status !== "pending") throw new HttpError(409, "This submission was already decided.");
    const pack = lib.packByRef(db, version.packRef)!;
    if (pack.authorUserId === session.user.id) throw forbidden("Another reviewer decides on your own packs.");
    const decision = body.decision;
    if (decision !== "approve" && decision !== "changes" && decision !== "reject") throw bad("decision must be approve, changes or reject.");
    const note = optStr(body, "note", 4000) ?? "";
    if (decision !== "approve" && note === "") throw bad("Write the author a note: what to change, or why it is refused.");
    const decided = lib.decide(db, { versionId: version.id, decision, note, reviewerUserId: session.user.id });
    const words = { approve: "published", changes: "sent back for changes", reject: "rejected" }[decision];
    audit(session.user.id, `review.${decision}`, `${pack.packId} ${version.version} ${words}${note === "" ? "" : `: ${note.slice(0, 300)}`}`);
    const titles = { approve: "Pachetul tău e publicat în bibliotecă", changes: "Pachetul tău are nevoie de modificări", reject: "Pachetul tău nu a fost publicat" };
    notifyAuthor(pack.authorUserId, titles[decision], `${version.meta.title} ${version.version}${note === "" ? "" : `: ${note}`}`, session.user.id);
    return { id: decided.id, status: decided.status };
  });

  route("GET", "/v1/library/review/packs", ({ session }) => {
    requireReviewer(session);
    const packs = db.prepare("SELECT slug FROM library_packs WHERE state != 'new' ORDER BY updated_at DESC LIMIT 500").all() as Array<{ slug: string }>;
    return {
      packs: packs.map(({ slug }) => {
        const pack = lib.packBySlug(db, slug)!;
        const version = publishedOf(pack);
        const author = lib.authorOf(db, pack.authorUserId);
        return {
          slug,
          packId: pack.packId,
          title: version?.meta.title ?? pack.packId,
          version: version?.version ?? null,
          state: pack.state,
          featured: pack.featured,
          unpublishedReason: pack.unpublishedReason,
          installs: lib.installsOf(db, pack.id),
          openReports: lib.openReportCount(db, pack.id),
          author: authorView(author),
        };
      }),
    };
  });

  const reviewPack = (session: security.SessionInfo, slug: string) => {
    requireReviewer(session);
    const pack = lib.packBySlug(db, slug);
    if (pack === null) throw notFound("No such pack.");
    return pack;
  };

  route("POST", "/v1/library/review/packs/:slug/unpublish", ({ session, params, body }) => {
    const pack = reviewPack(session, params.slug!);
    const reason = str(body, "reason", 500);
    lib.setPackState(db, pack.id, "unpublished", reason);
    audit(session.user.id, "pack.unpublish", `${pack.packId} unpublished: ${reason}`);
    notifyAuthor(pack.authorUserId, "Pachetul tău a fost scos din bibliotecă", `${pack.packId}: ${reason}`, session.user.id);
    return { state: "unpublished" };
  });

  route("POST", "/v1/library/review/packs/:slug/republish", ({ session, params }) => {
    const pack = reviewPack(session, params.slug!);
    if (pack.publishedVersionId === null) throw bad("This pack has no approved version.");
    lib.setPackState(db, pack.id, "published", null);
    audit(session.user.id, "pack.republish", `${pack.packId} published again`);
    return { state: "published" };
  });

  route("POST", "/v1/library/review/packs/:slug/featured", ({ session, params, body }) => {
    const pack = reviewPack(session, params.slug!);
    const featured = body.featured === true;
    lib.setPackFeatured(db, pack.id, featured);
    audit(session.user.id, featured ? "pack.feature" : "pack.unfeature", `${pack.packId} ${featured ? "featured" : "no longer featured"}`);
    return { featured };
  });

  route("POST", "/v1/library/review/authors/:slug/featured", ({ session, params, body }) => {
    requireReviewer(session);
    const featured = body.featured === true;
    if (!lib.setAuthorFeatured(db, params.slug!, featured)) throw notFound("No such author.");
    audit(session.user.id, featured ? "author.feature" : "author.unfeature", `Author ${params.slug!} ${featured ? "featured" : "no longer featured"}`);
    return { featured };
  });

  route("GET", "/v1/library/review/reports", ({ session, query }) => {
    requireReviewer(session);
    const status = query.get("status");
    return { reports: lib.reportsOf(db, status === "open" || status === "resolved" ? status : null) };
  });

  route("POST", "/v1/library/review/reports/:id/resolve", ({ session, params, body }) => {
    requireReviewer(session);
    const resolution = str(body, "resolution", 1000);
    if (!lib.resolveReport(db, params.id!, resolution, session.user.id)) throw notFound("No such open report.");
    audit(session.user.id, "report.resolve", `Report ${params.id!} resolved: ${resolution.slice(0, 300)}`);
    return { ok: true };
  });

  route("GET", "/v1/library/review/audit", ({ session }) => {
    requireReviewer(session);
    return { entries: lib.libraryAudit(db) };
  });

}
