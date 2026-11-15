// The page a client opens from an approval link: the deliverable (images, video, PDF, post text),
// the freelancer's note, the client's name and logo, and two answers, "Aprobă" and "Cere
// modificări". Plain HTML, no script (CSP without script-src), a stylesheet and fonts from the hub
// (src/assets/web/approval.css), Romanian or English by the client's language. Mobile first: it is
// opened on a phone, from WhatsApp or e-mail.
import { randomBytes } from "node:crypto";

import type { ApprovalFileRow, Approval, ApprovalLanguage } from "./storeApprovals.ts";

/** No script at all. A nonce lets one tiny style element set the client's brand color. */
export const approvalPageCsp = (styleNonce: string | null) =>
  `default-src 'none'; style-src 'self'${styleNonce === null ? "" : ` 'nonce-${styleNonce}'`}; font-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const TEXT = {
  ro: {
    htmlTitle: (title: string) => `${title} · spre aprobare`,
    forClient: (name: string) => `Pentru ${name}`,
    sentBy: (who: string, date: string) => `Trimis de ${who} pe ${date}`,
    expires: (date: string) => `Linkul e valabil până pe ${date}.`,
    noteFrom: (who: string) => `Mesaj de la ${who}`,
    fileOf: (index: number, total: number) => `${index} din ${total}`,
    download: "Descarcă",
    openPdf: "Deschide PDF-ul",
    pdfHint: "PDF-ul se deschide în aplicația telefonului sau a calculatorului.",
    postText: "Textul postării",
    decideTitle: "Ce zici?",
    decideHint: "Răspunsul ajunge direct la cel care ți-a trimis materialul. Nu ai nevoie de cont.",
    yourName: "Numele tău (opțional)",
    approve: "Aprobă",
    requestChanges: "Cere modificări",
    changesLabel: "Ce ar trebui schimbat?",
    changesPlaceholder: "De exemplu: logo-ul mai mare, data evenimentului e 14, nu 15.",
    sendChanges: "Trimite modificările",
    approvedStamp: "Aprobat",
    changesStamp: "Modificări cerute",
    approvedText: (date: string, who: string | null) => `Aprobat pe ${date}${who === null ? "" : ` de ${who}`}. Mulțumim!`,
    changesText: (date: string, who: string | null) => `Modificări cerute pe ${date}${who === null ? "" : ` de ${who}`}. Primești o versiune nouă pe un link nou.`,
    yourComment: "Ce ai scris",
    thanksApproved: "Gata, materialul e aprobat. Am anunțat-o pe persoana care ți l-a trimis.",
    thanksChanges: "Am trimis modificările. Primești o versiune nouă pe un link nou.",
    goneTitle: "Linkul nu mai e activ",
    goneText: "A expirat sau a fost retras de cel care l-a trimis. Cere-i un link nou dacă mai ai nevoie de material.",
    tooMany: "Prea multe încercări. Mai încearcă peste câteva minute.",
    commentRequired: "Scrie pe scurt ce ar trebui schimbat.",
    already: "Pentru acest link s-a răspuns deja.",
    language: "English",
    footer: "Trimis cu Zen Staff. Linkul arată doar acest material; nu e public și nu apare în motoarele de căutare.",
  },
  en: {
    htmlTitle: (title: string) => `${title} · for approval`,
    forClient: (name: string) => `For ${name}`,
    sentBy: (who: string, date: string) => `Sent by ${who} on ${date}`,
    expires: (date: string) => `This link works until ${date}.`,
    noteFrom: (who: string) => `A note from ${who}`,
    fileOf: (index: number, total: number) => `${index} of ${total}`,
    download: "Download",
    openPdf: "Open the PDF",
    pdfHint: "The PDF opens in your phone's or computer's viewer.",
    postText: "Post text",
    decideTitle: "What do you think?",
    decideHint: "Your answer goes straight to the person who sent this. No account needed.",
    yourName: "Your name (optional)",
    approve: "Approve",
    requestChanges: "Request changes",
    changesLabel: "What should change?",
    changesPlaceholder: "For example: a bigger logo, the event is on the 14th, not the 15th.",
    sendChanges: "Send the changes",
    approvedStamp: "Approved",
    changesStamp: "Changes requested",
    approvedText: (date: string, who: string | null) => `Approved on ${date}${who === null ? "" : ` by ${who}`}. Thank you!`,
    changesText: (date: string, who: string | null) => `Changes requested on ${date}${who === null ? "" : ` by ${who}`}. A new version will come on a new link.`,
    yourComment: "What you wrote",
    thanksApproved: "Done, it is approved. We let the person who sent it know.",
    thanksChanges: "Your changes were sent. A new version will come on a new link.",
    goneTitle: "This link is no longer active",
    goneText: "It expired or the sender withdrew it. Ask them for a new link if you still need it.",
    tooMany: "Too many attempts. Try again in a few minutes.",
    commentRequired: "Write briefly what should change.",
    already: "This link has already been answered.",
    language: "Română",
    footer: "Sent with Zen Staff. The link shows only this deliverable; it is not public and search engines do not list it.",
  },
} as const;

export type ApprovalPageText = (typeof TEXT)["ro"];
export const approvalText = (language: ApprovalLanguage): ApprovalPageText => TEXT[language] as ApprovalPageText;

const fmtDate = (iso: string, language: ApprovalLanguage) =>
  new Intl.DateTimeFormat(language === "ro" ? "ro-RO" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Bucharest" }).format(new Date(iso));

const fmtSize = (bytes: number, language: ApprovalLanguage) => {
  const mb = bytes / 1024 / 1024;
  const value = mb >= 1 ? mb.toFixed(1) : (bytes / 1024).toFixed(0);
  return `${language === "ro" ? value.replace(".", ",") : value} ${mb >= 1 ? "MB" : "KB"}`;
};

export const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cache-control": "no-store",
} as const;

export interface RenderedPage {
  readonly html: string;
  readonly csp: string;
}

function shell(input: { language: ApprovalLanguage; title: string; body: string; accent: string | null; switchHref: string | null }): RenderedPage {
  const t = approvalText(input.language);
  // The client's brand color only tints the top rule; text and buttons keep the page's contrast.
  const accent = input.accent !== null && /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : null;
  const nonce = accent === null ? null : randomBytes(16).toString("base64url");
  const html = `<!doctype html>
<html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#F7F6F2">
<title>${escape(input.title)}</title>
<link rel="icon" href="/app/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app/assets/approval.css">${accent === null ? "" : `<style nonce="${nonce}">:root{--accent:${accent}}</style>`}
</head><body>
<div class="rule"></div>
${input.body}
<footer class="foot"><p>${escape(t.footer)}</p>${input.switchHref === null ? "" : `<p><a href="${escape(input.switchHref)}" hreflang="${input.language === "ro" ? "en" : "ro"}">${escape(t.language)}</a></p>`}</footer>
</body></html>`;
  return { html, csp: approvalPageCsp(nonce) };
}

/** The closed page: unknown, expired and revoked links all look the same (no oracle). */
export function gonePage(language: ApprovalLanguage): RenderedPage {
  const t = approvalText(language);
  return shell({
    language,
    title: t.goneTitle,
    accent: null,
    switchHref: null,
    body: `<main class="wrap"><section class="sheet gone"><h1>${escape(t.goneTitle)}</h1><p class="lead">${escape(t.goneText)}</p></section></main>`,
  });
}

export function messagePage(language: ApprovalLanguage, title: string, text: string): RenderedPage {
  return shell({ language, title, accent: null, switchHref: null, body: `<main class="wrap"><section class="sheet gone"><h1>${escape(title)}</h1><p class="lead">${escape(text)}</p></section></main>` });
}

const PDF_ICON =
  '<svg class="doc-icon" viewBox="0 0 48 60" width="48" height="60" aria-hidden="true"><path d="M4 2h28l12 12v42a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#fff" stroke="#121A2B" stroke-width="2"/><path d="M32 2v12h12" fill="none" stroke="#121A2B" stroke-width="2"/><rect x="8" y="34" width="32" height="14" rx="2" fill="#E2401E"/><text x="24" y="44.5" text-anchor="middle" font-family="Hanken Grotesk, sans-serif" font-size="10" font-weight="700" fill="#fff">PDF</text></svg>';

function fileFigure(input: {
  file: ApprovalFileRow;
  base: string;
  position: number;
  total: number;
  text: string | null;
  language: ApprovalLanguage;
}): string {
  const { file, base, position, total, language } = input;
  const t = approvalText(language);
  const src = `${base}/f/${file.index}`;
  const caption = `<figcaption><span class="count">${escape(t.fileOf(position, total))}</span><span class="name">${escape(file.name)}</span><a class="dl" href="${escape(src)}?download=1">${escape(t.download)}</a></figcaption>`;
  if (file.kind === "image") {
    const ratio = file.width !== null && file.height !== null ? ` width="${file.width}" height="${file.height}"` : "";
    return `<figure class="slide" id="f${position}"><div class="frame skeleton"><img src="${escape(src)}" alt="${escape(file.name)}"${ratio} decoding="async"${position > 1 ? ' loading="lazy"' : ""}></div>${caption}</figure>`;
  }
  if (file.kind === "video") {
    return `<figure class="slide" id="f${position}"><div class="frame skeleton video"><video src="${escape(src)}" controls playsinline preload="metadata"></video></div>${caption}</figure>`;
  }
  if (file.kind === "pdf") {
    return `<figure class="slide" id="f${position}"><div class="frame doc"><a class="doc-card" href="${escape(src)}">${PDF_ICON}<span><b>${escape(file.name)}</b><br><span class="small">${escape(fmtSize(file.size, language))}</span></span></a><a class="btn ghost" href="${escape(src)}">${escape(t.openPdf)}</a><p class="small">${escape(t.pdfHint)}</p></div>${caption}</figure>`;
  }
  return `<figure class="slide" id="f${position}"><div class="frame post"><p class="post-label">${escape(t.postText)}</p><div class="post-text">${escape(input.text ?? "")}</div></div>${caption}</figure>`;
}

export function approvalPage(input: {
  approval: Approval;
  files: ReadonlyArray<ApprovalFileRow>;
  /** Text of `text` files by index (already decoded on the server). */
  texts: ReadonlyMap<number, string>;
  senderName: string;
  base: string;
  language: ApprovalLanguage;
  notice: "approved" | "changes" | "comment-required" | "already" | null;
  switchHref: string;
}): RenderedPage {
  const { approval, base, language } = input;
  const t = approvalText(language);
  const files = input.files.filter((file) => file.role === "file");
  const logo = input.files.find((file) => file.role === "logo");
  const sender = input.senderName;
  const brand = `<header class="client">${
    logo === undefined
      ? `<span class="monogram" aria-hidden="true">${escape(approval.clientName.trim().slice(0, 1).toUpperCase())}</span>`
      : `<span class="logo"><img src="${escape(`${base}/f/${logo.index}`)}" alt="${escape(approval.clientName)}"${logo.width !== null && logo.height !== null ? ` width="${logo.width}" height="${logo.height}"` : ""}></span>`
  }<span class="client-name">${escape(t.forClient(approval.clientName))}</span></header>`;
  const slides = files
    .map((file, index) => fileFigure({ file, base, position: index + 1, total: files.length, text: input.texts.get(file.index) ?? null, language }))
    .join("");
  const dots =
    files.length > 1
      ? `<nav class="dots" aria-label="${escape(t.fileOf(1, files.length))}">${files.map((file, index) => `<a href="#f${index + 1}" aria-label="${escape(`${t.fileOf(index + 1, files.length)}: ${file.name}`)}">${index + 1}</a>`).join("")}</nav>`
      : "";
  const note =
    approval.note.trim() === ""
      ? ""
      : `<section class="note"><h2>${escape(t.noteFrom(sender))}</h2><p>${escape(approval.note)}</p></section>`;
  const decided = approval.decidedAt !== null;
  const noticeLine =
    input.notice === "approved"
      ? t.thanksApproved
      : input.notice === "changes"
        ? t.thanksChanges
        : input.notice === "comment-required"
          ? t.commentRequired
          : input.notice === "already"
            ? t.already
            : null;
  const noticeHtml = noticeLine === null ? "" : `<p class="notice${input.notice === "comment-required" ? " warn" : ""}" role="status">${escape(noticeLine)}</p>`;
  const answer = decided
    ? `<section class="sheet result">
  <p class="stamp${approval.status === "approved" ? "" : " ink"}">${escape(approval.status === "approved" ? t.approvedStamp : t.changesStamp)}</p>
  <p class="lead">${escape(approval.status === "approved" ? t.approvedText(fmtDate(approval.decidedAt!, language), approval.decidedByName) : t.changesText(fmtDate(approval.decidedAt!, language), approval.decidedByName))}</p>
  ${approval.comment === null || approval.comment === "" ? "" : `<div class="said"><h2>${escape(t.yourComment)}</h2><p>${escape(approval.comment)}</p></div>`}
</section>`
    : `<section class="sheet decide" id="raspuns">
  <h2>${escape(t.decideTitle)}</h2>
  <p class="small">${escape(t.decideHint)}</p>
  <form method="post" action="${escape(`${base}/decizie`)}" class="approve">
    <input type="hidden" name="decision" value="approved">
    <label class="field"><span>${escape(t.yourName)}</span><input name="name" maxlength="80" autocomplete="name"></label>
    <button class="btn primary big" type="submit">${escape(t.approve)}</button>
  </form>
  <details class="changes"${input.notice === "comment-required" ? " open" : ""}>
    <summary class="btn ghost big">${escape(t.requestChanges)}</summary>
    <form method="post" action="${escape(`${base}/decizie`)}">
      <input type="hidden" name="decision" value="changes">
      <label class="field"><span>${escape(t.changesLabel)}</span><textarea name="comment" rows="5" maxlength="2000" required placeholder="${escape(t.changesPlaceholder)}"></textarea></label>
      <label class="field"><span>${escape(t.yourName)}</span><input name="name" maxlength="80" autocomplete="name"></label>
      <button class="btn dark big" type="submit">${escape(t.sendChanges)}</button>
    </form>
  </details>
</section>`;
  return shell({
    language,
    title: t.htmlTitle(approval.title),
    accent: approval.clientColor,
    switchHref: input.switchHref,
    body: `<main class="wrap">
${brand}
<section class="sheet head">
  <h1>${escape(approval.title)}</h1>
  <p class="byline">${escape(t.sentBy(sender, fmtDate(approval.createdAt, language)))}</p>
  <p class="small">${escape(t.expires(fmtDate(approval.expiresAt, language)))}</p>
</section>
${noticeHtml}
${note}
<section class="deck${files.length > 1 ? " many" : ""}">${slides}</section>
${dots}
${answer}
</main>`,
  });
}
