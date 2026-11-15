// Public pages of the community library: a pack's share page (/p/<slug>) and an author's page
// (/a/<slug>). Plain HTML rendered here, the dashboard's fonts and a small stylesheet from the hub
// (src/assets/web/library.css), no script. The install button opens Zen Staff through the zen://
// link; people without the app get the download link. Romanian or English: ?lang=ro|en, else the
// browser's language, else Romanian; the footer links to the other one.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Kit } from "../app.ts";
import { acceptLanguage, asLanguage } from "../http.ts";
import * as lib from "../storeLibrary.ts";

type Lang = "ro" | "en";

const LANDING = "https://zenstaff.app";

export const LIBRARY_PAGE_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const TEXT = {
  ro: {
    locale: "ro-RO",
    category: { design: "Design", pr: "PR și presă", video: "Video", social: "Social media", sales: "Vânzări", reports: "Rapoarte", admin: "Administrativ" } as Record<string, string>,
    titleSuffix: "Biblioteca Zen Staff",
    crumb: "Biblioteca comunității · gratuit",
    footer: "Pachetele din bibliotecă sunt gratuite, făcute de oameni care folosesc Zen Staff și verificate de noi înainte de publicare. Rulează pe calculatorul tău, cu aprobările și uneltele Zen Staff obișnuite; nu primesc niciodată chei sau acces Enterprise.",
    other: "English",
    notFoundTitle: "Pachet negăsit",
    notFoundDescription: "Pachetul nu există sau nu mai este în bibliotecă.",
    notFoundHeading: "Pachetul nu este în bibliotecă",
    notFoundText: "Poate a fost scos sau linkul e greșit. Restul pachetelor sunt în Zen Staff, la Bibliotecă.",
    download: "Descarcă Zen Staff",
    dashboard: "Panoul Zen Staff",
    install1: "1 instalare",
    installs: (n: string) => `${n} instalări`,
    installWord: (n: number) => (n === 1 ? "instalare" : "instalări"),
    packWord: (n: number) => (n === 1 ? "pachet" : "pachete"),
    workflows: (n: number, list: string) => `${n} fluxuri în pachet: ${list}`,
    community: "Comunitate",
    by: "de",
    version: (v: string) => `versiunea ${v}`,
    verified: "Verificat de Zen",
    featured: "Recomandat",
    free: "Gratuit",
    language: (value: string) => (value === "ro+en" ? "Română și engleză" : value === "en" ? "Engleză" : "Română"),
    installButton: "Instalează în Zen Staff",
    noApp: "Nu ai Zen Staff? Descarcă-l",
    installHint: (title: string) => `Butonul deschide Zen Staff la Bibliotecă, cu acest pachet. Dacă nu se deschide nimic, descarcă Zen Staff, apoi caută „${title}” la Bibliotecă.`,
    whatYouGet: "Ce primești",
    whatsNew: (v: string) => `Ce e nou în ${v}`,
    publishedOn: (date: string) => `Publicat pe ${date}.`,
    authorDescription: (name: string) => `Pachetele lui ${name} din biblioteca Zen Staff.`,
    authorEyebrow: "Autor în bibliotecă",
    packs: "Pachete",
    noPacks: "Încă nu are pachete publicate.",
  },
  en: {
    locale: "en-GB",
    category: { design: "Design", pr: "PR and press", video: "Video", social: "Social media", sales: "Sales", reports: "Reports", admin: "Admin" } as Record<string, string>,
    titleSuffix: "Zen Staff Library",
    crumb: "Community library · free",
    footer: "The packs in the library are free, made by people who use Zen Staff and reviewed by us before they are published. They run on your computer, with the usual Zen Staff approvals and tools; they never get keys or Enterprise access.",
    other: "Română",
    notFoundTitle: "Pack not found",
    notFoundDescription: "The pack does not exist or is no longer in the library.",
    notFoundHeading: "This pack is not in the library",
    notFoundText: "It may have been removed, or the link is wrong. The other packs are in Zen Staff, under Library.",
    download: "Download Zen Staff",
    dashboard: "Zen Staff dashboard",
    install1: "1 install",
    installs: (n: string) => `${n} installs`,
    installWord: (n: number) => (n === 1 ? "install" : "installs"),
    packWord: (n: number) => (n === 1 ? "pack" : "packs"),
    workflows: (n: number, list: string) => `${n} workflows in the pack: ${list}`,
    community: "Community",
    by: "by",
    version: (v: string) => `version ${v}`,
    verified: "Reviewed by Zen",
    featured: "Featured",
    free: "Free",
    language: (value: string) => (value === "ro+en" ? "Romanian and English" : value === "en" ? "English" : "Romanian"),
    installButton: "Install in Zen Staff",
    noApp: "No Zen Staff yet? Download it",
    installHint: (title: string) => `The button opens Zen Staff at the Library, with this pack. If nothing opens, download Zen Staff, then search for "${title}" in the Library.`,
    whatYouGet: "What you get",
    whatsNew: (v: string) => `What's new in ${v}`,
    publishedOn: (date: string) => `Published on ${date}.`,
    authorDescription: (name: string) => `Packs by ${name} in the Zen Staff library.`,
    authorEyebrow: "Library author",
    packs: "Packs",
    noPacks: "No published packs yet.",
  },
};

const pageLang = (req: IncomingMessage, url: URL): Lang => asLanguage(url.searchParams.get("lang")) ?? acceptLanguage(req) ?? "ro";
const fmtNum = (lang: Lang, n: number) => new Intl.NumberFormat(TEXT[lang].locale).format(n);
const fmtDate = (lang: Lang, iso: string | null) => (iso === null ? "" : new Intl.DateTimeFormat(TEXT[lang].locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso)));
const installsText = (lang: Lang, n: number) => (n === 1 ? TEXT[lang].install1 : TEXT[lang].installs(fmtNum(lang, n)));

/** The deep link the app opens: Bibliotecă with this pack (the app uses the hub it is signed in to). */
export const installLink = (slug: string) => `zen://library?install=${encodeURIComponent(slug)}`;

function shell(res: ServerResponse, status: number, lang: Lang, input: { title: string; description: string; url: string; image?: string; body: string }) {
  const t = TEXT[lang];
  const other: Lang = lang === "ro" ? "en" : "ro";
  const otherHref = `${new URL(input.url).pathname}?lang=${other}`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": status === 200 ? "public, max-age=300" : "no-store",
    // The language can come from the browser: caches keep one copy per Accept-Language.
    vary: "accept-language",
    "content-security-policy": LIBRARY_PAGE_CSP,
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
  });
  res.end(`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title)} · ${t.titleSuffix}</title>
<meta name="description" content="${escape(input.description.slice(0, 200))}">
<meta property="og:title" content="${escape(input.title)}"><meta property="og:description" content="${escape(input.description.slice(0, 200))}">
<meta property="og:url" content="${escape(input.url)}">${input.image === undefined ? "" : `<meta property="og:image" content="${escape(input.image)}">`}
<link rel="icon" href="/app/assets/mark.svg"><link rel="stylesheet" href="/app/assets/library.css">
</head><body><header class="top"><a href="${LANDING}" class="brand"><img src="/app/assets/logo.svg" alt="Zen Staff" width="132" height="23"></a><span class="crumb">${t.crumb}</span></header>
<main>${input.body}</main>
<footer>${t.footer}<br><a href="${escape(otherHref)}" hreflang="${other}" lang="${other}">${t.other}</a></footer>
</body></html>`);
}

function notFoundPage(res: ServerResponse, lang: Lang, publicUrl: string, url: string) {
  const t = TEXT[lang];
  shell(res, 404, lang, {
    title: t.notFoundTitle,
    description: t.notFoundDescription,
    url,
    body: `<section class="card"><h1>${t.notFoundHeading}</h1><p>${t.notFoundText}</p><p><a class="btn" href="${LANDING}">${t.download}</a> <a class="btn ghost" href="${escape(publicUrl)}/app">${t.dashboard}</a></p></section>`,
  });
}

export function registerLibraryPages(kit: Kit) {
  const { db, config } = kit;
  const base = config.publicUrl;

  kit.pagePrefix("/p/", (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const lang = pageLang(req, url);
    const t = TEXT[lang];
    const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/$/, "");
    const pack = /^[a-z0-9-]{2,80}$/.test(slug) ? lib.packBySlug(db, slug) : null;
    if (pack === null || pack.state !== "published" || pack.publishedVersionId === null) return notFoundPage(res, lang, base, url.href);
    const version = lib.getVersion(db, pack.publishedVersionId)!;
    const author = lib.authorOf(db, pack.authorUserId);
    const installs = lib.installsOf(db, pack.id);
    const meta = version.meta;
    const shots = version.screenshots
      .map((shot, index) => `<figure><img src="/v1/library/packs/${escape(pack.slug)}/screens/${index}" alt="${escape(shot.name)}" loading="lazy"></figure>`)
      .join("");
    const workflows = version.workflows === null ? "" : `<p class="small">${t.workflows(version.workflows.length, version.workflows.map(escape).join(", "))}</p>`;
    shell(res, 200, lang, {
      title: meta.title,
      description: meta.description,
      url: `${base}/p/${pack.slug}`,
      ...(version.screenshots.length > 0 ? { image: `${base}/v1/library/packs/${pack.slug}/screens/0` } : {}),
      body: `<article class="card pack">
  <p class="eyebrow">${escape(t.category[meta.category] ?? meta.category)} · ${t.community}</p>
  <h1>${escape(meta.title)}</h1>
  <p class="byline">${t.by} <a href="/a/${escape(author?.slug ?? "")}">${escape(author?.displayName ?? t.community)}</a>${author?.company ? ` · ${escape(author.company)}` : ""} · ${installsText(lang, installs)} · ${t.version(escape(version.version))}</p>
  <p class="badges"><span class="stamp">${t.verified}</span>${pack.featured ? `<span class="stamp ink">${t.featured}</span>` : ""}<span class="tag">${t.free}</span><span class="tag">${escape(meta.licence)}</span><span class="tag">${escape(t.language(meta.language))}</span></p>
  <p class="lead">${escape(meta.description)}</p>
  ${workflows}
  <div class="actions"><a class="btn primary" href="${escape(installLink(pack.slug))}">${t.installButton}</a><a class="btn ghost" href="${LANDING}">${t.noApp}</a></div>
  <p class="small">${t.installHint(escape(meta.title))}</p>
</article>
${meta.sampleOutput === "" && shots === "" ? "" : `<section class="card"><h2>${t.whatYouGet}</h2>${meta.sampleOutput === "" ? "" : `<p>${escape(meta.sampleOutput)}</p>`}<div class="shots">${shots}</div></section>`}
${meta.changelog === "" ? "" : `<section class="card"><h2>${t.whatsNew(escape(version.version))}</h2><p class="pre">${escape(meta.changelog)}</p><p class="small">${t.publishedOn(escape(fmtDate(lang, version.decidedAt)))}</p></section>`}`,
    });
  });

  kit.pagePrefix("/a/", (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const lang = pageLang(req, url);
    const t = TEXT[lang];
    const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/$/, "");
    const author = /^[a-z0-9-]{2,80}$/.test(slug) ? lib.authorBySlug(db, slug) : null;
    if (author === null) return notFoundPage(res, lang, base, url.href);
    const packs = lib.publishedPacks(db).filter((pack) => pack.authorUserId === author.userId);
    const total = packs.reduce((sum, pack) => sum + pack.installs, 0);
    const rows = packs
      .map((pack) => {
        const version = lib.getVersion(db, pack.publishedVersionId!)!;
        return `<li><a href="/p/${escape(pack.slug)}"><b>${escape(version.meta.title)}</b></a> <span class="stamp small">${t.verified}</span>${pack.featured ? ` <span class="stamp ink small">${t.featured}</span>` : ""}<br><span class="small">${escape(version.meta.description.slice(0, 160))}</span><br><span class="small">${installsText(lang, pack.installs)} · ${t.version(escape(version.version))}</span></li>`;
      })
      .join("");
    shell(res, 200, lang, {
      title: author.displayName,
      description: t.authorDescription(author.displayName),
      url: `${base}/a/${author.slug}`,
      body: `<article class="card"><p class="eyebrow">${t.authorEyebrow}${author.featured ? ` · ${t.featured}` : ""}</p><h1>${escape(author.displayName)}</h1>${author.company ? `<p class="byline">${escape(author.company)}</p>` : ""}${author.bio ? `<p class="lead">${escape(author.bio)}</p>` : ""}
  <p class="kpis"><span><b>${fmtNum(lang, packs.length)}</b> ${t.packWord(packs.length)}</span><span><b>${fmtNum(lang, total)}</b> ${t.installWord(total)}</span></p></article>
<section class="card"><h2>${t.packs}</h2>${rows === "" ? `<p>${t.noPacks}</p>` : `<ul class="packs">${rows}</ul>`}</section>`,
    });
  });
}
