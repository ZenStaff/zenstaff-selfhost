// The sign-in and invitation e-mails, in Romanian by default and in English when the account's
// language is en. Each has a plain-text part and a plain HTML part in the dashboard's style: the
// logo, one vermilion button, paper and ink, no tracking, no remote fonts. Names and company names
// are typed by people, so every value is escaped before it goes into the HTML.
import { ZEN_DOWNLOADS, inviterLabel } from "./downloads.ts";
import type { Language } from "./storeTeam.ts";

export interface MailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const INK = "#121A2B";
const MUTED = "#646B7A";
const PAPER = "#F7F6F2";
const LOUD = "#E2401E";
const LINE = "#ECE9E3";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The logo as a PNG on the hub (mail clients do not show SVG); see routes/web.ts for its headers. */
export const mailLogoUrl = (publicUrl: string) => `${publicUrl}/app/assets/mail/logo.png`;

interface Layout {
  readonly lang: Language;
  readonly publicUrl: string;
  readonly preheader: string;
  readonly title: string;
  /** Paragraphs, already escaped HTML. */
  readonly body: ReadonlyArray<string>;
  readonly button: { readonly label: string; readonly href: string };
  /** Small print under the button, already escaped HTML. */
  readonly foot: ReadonlyArray<string>;
}

function layout(input: Layout): string {
  const p = (html: string, color = INK, size = 16) =>
    `<p style="margin:0 0 14px;font:400 ${size}px/1.55 'Hanken Grotesk',Helvetica,Arial,sans-serif;color:${color}">${html}</p>`;
  return (
    `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${escapeHtml(input.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER}">` +
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">` +
    `<tr><td style="padding:0 4px 20px"><img src="${escapeHtml(mailLogoUrl(input.publicUrl))}" width="180" height="31" alt="Zen Staff" style="display:block;border:0"></td></tr>` +
    `<tr><td style="background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;padding:30px 28px">` +
    `<h1 style="margin:0 0 16px;font:400 26px/1.2 'Young Serif',Georgia,serif;color:${INK}">${escapeHtml(input.title)}</h1>` +
    input.body.map((html) => p(html)).join("") +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="border-radius:999px;background:${LOUD}">` +
    `<a href="${escapeHtml(input.button.href)}" style="display:inline-block;padding:13px 24px;font:600 16px/1 'Hanken Grotesk',Helvetica,Arial,sans-serif;color:#FFFFFF;text-decoration:none;border-radius:999px">${escapeHtml(input.button.label)}</a>` +
    `</td></tr></table>` +
    input.foot.map((html) => p(html, MUTED, 13)).join("") +
    `</td></tr>` +
    `<tr><td style="padding:16px 4px 0;font:400 12px/1.5 Helvetica,Arial,sans-serif;color:${MUTED}">Zen Staff · ${escapeHtml(input.publicUrl.replace(/^https?:\/\//, ""))}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

const codeBlock = (code: string) =>
  `<span style="display:inline-block;font:500 28px/1 'IBM Plex Mono',Menlo,Consolas,monospace;letter-spacing:.18em;color:${INK};background:${PAPER};border:1px solid ${LINE};border-radius:10px;padding:12px 16px">${escapeHtml(code)}</span>`;

/** The sign-in e-mail: the 6-digit code, and a link that approves the sign-in from any device. */
export function signInMail(lang: Language | null, input: { code: string; link: string; publicUrl: string }): MailContent {
  if (lang === "en") {
    return {
      subject: `Your Zen Staff sign-in code: ${input.code}`,
      text: `Your sign-in code is ${input.code}.\n\nOr open this link on any device to approve the sign-in:\n${input.link}\n\nThe code and the link work once, for 15 minutes. If you did not ask to sign in, ignore this e-mail.`,
      html: layout({
        lang: "en",
        publicUrl: input.publicUrl,
        preheader: `Your code is ${input.code}. It works once, for 15 minutes.`,
        title: "Your sign-in code",
        body: ["Type this code where you started signing in:", codeBlock(input.code), "Or approve the sign-in with one click, from any device:"],
        button: { label: "Approve the sign-in", href: input.link },
        foot: ["The code and the link work once, for 15 minutes. If you did not ask to sign in, ignore this e-mail; nobody gets in without it."],
      }),
    };
  }
  return {
    subject: `Codul tău de intrare în Zen Staff: ${input.code}`,
    text: `Codul tău de intrare este ${input.code}.\n\nSau deschide linkul acesta pe orice dispozitiv ca să aprobi intrarea:\n${input.link}\n\nCodul și linkul merg o singură dată, 15 minute. Dacă nu ai cerut tu să intri, ignoră e-mailul.`,
    html: layout({
      lang: "ro",
      publicUrl: input.publicUrl,
      preheader: `Codul tău este ${input.code}. Merge o singură dată, 15 minute.`,
      title: "Codul tău de intrare",
      body: ["Scrie codul acesta acolo unde ai început să intri:", codeBlock(input.code), "Sau aprobă intrarea dintr-un clic, de pe orice dispozitiv:"],
      button: { label: "Aprobă intrarea", href: input.link },
      foot: ["Codul și linkul merg o singură dată, 15 minute. Dacă nu ai cerut tu să intri, ignoră e-mailul: nimeni nu intră fără el."],
    }),
  };
}

export const ROLE_NAMES: Record<Language, Record<string, string>> = {
  ro: { owner: "Proprietar", admin: "Administrator", member: "Membru", guest: "Invitat" },
  en: { owner: "Owner", admin: "Administrator", member: "Member", guest: "Guest" },
};

const mailLink = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:${INK};font-weight:600">${escapeHtml(label)}</a>`;

/**
 * The invitation e-mail: who invites (name, or the address when the account has no name), to which
 * company, with which role, and the three steps for someone who does not have the app yet: download
 * it, choose "I was invited" on the first start, sign in with this address. The button opens the
 * invitation page, which repeats the steps and also accepts in the browser.
 */
export function inviteMail(
  lang: Language | null,
  input: {
    inviterName: string;
    inviterEmail?: string | null;
    companyName: string;
    role: string;
    email: string;
    link: string;
    publicUrl: string;
  },
): MailContent {
  const inviter = inviterLabel(input.inviterName, input.inviterEmail);
  const who = escapeHtml(inviter);
  const company = escapeHtml(input.companyName);
  const address = escapeHtml(input.email);
  const downloads = (windows: string, page: string) =>
    `${mailLink(ZEN_DOWNLOADS.windows, windows)} · ${mailLink(ZEN_DOWNLOADS.linuxAppImage, "Linux (AppImage)")} · ${mailLink(ZEN_DOWNLOADS.linuxDeb, "Linux (.deb)")} · ${mailLink(ZEN_DOWNLOADS.page, page)}`;
  if (lang === "en") {
    const role = ROLE_NAMES.en[input.role] ?? input.role;
    return {
      subject: `${inviter} invited you to ${input.companyName} on Zen Staff`,
      text:
        `${inviter} invited you to ${input.companyName} as ${role}.\n\n` +
        `1. Download Zen Staff:\n   Windows: ${ZEN_DOWNLOADS.windows}\n   Linux (AppImage): ${ZEN_DOWNLOADS.linuxAppImage}\n   Linux (.deb): ${ZEN_DOWNLOADS.linuxDeb}\n   Other systems: ${ZEN_DOWNLOADS.page}\n` +
        `2. Open it and, on the first start, choose "I was invited".\n` +
        `3. Sign in with ${input.email} and paste this invitation link:\n   ${input.link}\n\n` +
        `You can also open the link and accept the invitation in the browser.\n\nThe invitation is valid for 14 days. If you do not know this company, ignore this e-mail.`,
      html: layout({
        lang: "en",
        publicUrl: input.publicUrl,
        preheader: `${inviter} invited you to ${input.companyName} as ${role}.`,
        title: `Join ${input.companyName}`,
        body: [
          `<b>${who}</b> invited you to <b>${company}</b> on Zen Staff, as <b>${escapeHtml(role)}</b>. You will work there with your colleagues and the company's AI staff.`,
          `<b>1.</b> Download Zen Staff: ${downloads("Windows", "other systems")}`,
          `<b>2.</b> Open it and, on the first start, choose <b>I was invited</b>.`,
          `<b>3.</b> Sign in with <b>${address}</b> and paste the invitation link (the button below opens it).`,
        ],
        button: { label: "Open the invitation", href: input.link },
        foot: [
          "Not installing yet? Open the invitation and accept it in the browser.",
          "The invitation is valid for 14 days. If you do not know this company, ignore this e-mail.",
        ],
      }),
    };
  }
  const role = ROLE_NAMES.ro[input.role] ?? input.role;
  return {
    subject: `${inviter} te-a invitat în ${input.companyName} pe Zen Staff`,
    text:
      `${inviter} te-a invitat în ${input.companyName}, ca ${role}.\n\n` +
      `1. Descarcă Zen Staff:\n   Windows: ${ZEN_DOWNLOADS.windows}\n   Linux (AppImage): ${ZEN_DOWNLOADS.linuxAppImage}\n   Linux (.deb): ${ZEN_DOWNLOADS.linuxDeb}\n   Alte sisteme: ${ZEN_DOWNLOADS.page}\n` +
      `2. Deschide aplicația și, la prima pornire, alege „Am primit o invitație”.\n` +
      `3. Intră cu ${input.email} și lipește linkul invitației:\n   ${input.link}\n\n` +
      `Poți și să deschizi linkul și să accepți invitația din browser.\n\nInvitația e valabilă 14 zile. Dacă nu cunoști firma, ignoră e-mailul.`,
    html: layout({
      lang: "ro",
      publicUrl: input.publicUrl,
      preheader: `${inviter} te-a invitat în ${input.companyName}, ca ${role}.`,
      title: `Intră în ${input.companyName}`,
      body: [
        `<b>${who}</b> te-a invitat în <b>${company}</b> pe Zen Staff, ca <b>${escapeHtml(role)}</b>. Acolo lucrezi cu colegii și cu angajații AI ai firmei.`,
        `<b>1.</b> Descarcă Zen Staff: ${downloads("Windows", "alte sisteme")}`,
        `<b>2.</b> Deschide aplicația și, la prima pornire, alege <b>Am primit o invitație</b>.`,
        `<b>3.</b> Intră cu <b>${address}</b> și lipește linkul invitației (butonul de mai jos îl deschide).`,
      ],
      button: { label: "Deschide invitația", href: input.link },
      foot: [
        "Nu instalezi acum? Deschide invitația și accept-o din browser.",
        "Invitația e valabilă 14 zile. Dacă nu cunoști firma, ignoră e-mailul.",
      ],
    }),
  };
}

/**
 * The client answered an approval link: approved, or changes requested (with the client's comment).
 * Goes to the freelancer who sent it, in their language. The button opens the hub's dashboard; the
 * app shows the same answer on the chat's card.
 */
export function approvalDecidedMail(
  lang: Language | null,
  input: { decision: "approved" | "changes"; title: string; clientName: string; who: string | null; comment: string | null; publicUrl: string },
): MailContent {
  const title = escapeHtml(input.title);
  const client = escapeHtml(input.clientName);
  const quote = (text: string) =>
    `<span style="display:block;border-left:3px solid ${LOUD};padding:4px 0 4px 12px;color:${INK};white-space:pre-wrap">${escapeHtml(text)}</span>`;
  const comment = input.comment !== null && input.comment.trim() !== "" ? input.comment.trim() : null;
  if (lang === "en") {
    const approved = input.decision === "approved";
    const subject = approved ? `${input.clientName} approved "${input.title}"` : `${input.clientName} asked for changes to "${input.title}"`;
    return {
      subject,
      text: `${subject}${input.who === null ? "" : ` (${input.who})`}.${comment === null ? "" : `\n\nTheir comment:\n${comment}`}\n\nOpen the chat in Zen Staff: the card above the message box has the answer${approved ? "" : " and sends the comment to the agent with one click"}.`,
      html: layout({
        lang: "en",
        publicUrl: input.publicUrl,
        preheader: subject,
        title: approved ? "Approved" : "Changes requested",
        body: [
          approved ? `<b>${client}</b> approved <b>${title}</b>${input.who === null ? "" : ` (${escapeHtml(input.who)})`}.` : `<b>${client}</b> asked for changes to <b>${title}</b>${input.who === null ? "" : ` (${escapeHtml(input.who)})`}:`,
          ...(comment === null ? [] : [quote(comment)]),
          approved ? "Nothing else to do on this link." : "In Zen Staff, the chat's card sends this comment to the agent as the next message, with one click.",
        ],
        button: { label: "Open the hub", href: `${input.publicUrl}/app` },
        foot: ["You get this because you sent the approval link from Zen Staff. You can turn these e-mails off in Zen Staff, Team, Account."],
      }),
    };
  }
  const approved = input.decision === "approved";
  const subject = approved ? `${input.clientName} a aprobat „${input.title}”` : `${input.clientName} a cerut modificări la „${input.title}”`;
  return {
    subject,
    text: `${subject}${input.who === null ? "" : ` (${input.who})`}.${comment === null ? "" : `\n\nCe a scris:\n${comment}`}\n\nDeschide chatul în Zen Staff: cardul de deasupra casetei de mesaj are răspunsul${approved ? "" : " și trimite comentariul agentului dintr-un clic"}.`,
    html: layout({
      lang: "ro",
      publicUrl: input.publicUrl,
      preheader: subject,
      title: approved ? "Aprobat" : "Modificări cerute",
      body: [
        approved ? `<b>${client}</b> a aprobat <b>${title}</b>${input.who === null ? "" : ` (${escapeHtml(input.who)})`}.` : `<b>${client}</b> a cerut modificări la <b>${title}</b>${input.who === null ? "" : ` (${escapeHtml(input.who)})`}:`,
        ...(comment === null ? [] : [quote(comment)]),
        approved ? "Nu mai ai nimic de făcut pe acest link." : "În Zen Staff, cardul din chat trimite comentariul agentului ca mesaj următor, dintr-un clic.",
      ],
      button: { label: "Deschide hubul", href: `${input.publicUrl}/app` },
      foot: ["Primești e-mailul pentru că ai trimis linkul de aprobare din Zen Staff. Îl poți opri în Zen Staff, Echipă, Cont."],
    }),
  };
}

/**
 * The platform admin reset someone's two-factor authentication (support, after a typed
 * confirmation). The person learns it happened, why, and what to do; if they did not ask, they
 * write back. Every session was ended too.
 */
export function twoFactorResetMail(lang: Language | null, input: { name: string; reason: string; publicUrl: string }): MailContent {
  const link = `${input.publicUrl}/app/securitate`;
  if (lang === "en") {
    return {
      subject: "Two-factor authentication was reset on your Zen Staff account",
      text: `Hello ${input.name},\n\nThe Zen Staff team reset the two-factor authentication of your account and signed out every session. Reason: ${input.reason}\n\nSign in again and set up two-factor at once: ${link}\n\nIf you did not ask for this, reply to this e-mail right away.`,
      html: layout({
        lang: "en",
        publicUrl: input.publicUrl,
        preheader: "Your two-factor authentication was reset. Set it up again.",
        title: "Two-factor was reset",
        body: [
          `Hello ${escapeHtml(input.name)}, the Zen Staff team reset the two-factor authentication of your account and signed out every session.`,
          `Reason: <b>${escapeHtml(input.reason)}</b>`,
          "Sign in again and set up two-factor at once:",
        ],
        button: { label: "Set up two-factor", href: link },
        foot: ["Your passkeys were kept. If you did not ask for this, reply to this e-mail right away."],
      }),
    };
  }
  return {
    subject: "Autentificarea în doi pași a contului tău Zen Staff a fost resetată",
    text: `Bună, ${input.name},\n\nEchipa Zen Staff a resetat autentificarea în doi pași a contului tău și a închis toate sesiunile. Motivul: ${input.reason}\n\nIntră din nou și pornește imediat autentificarea în doi pași: ${link}\n\nDacă nu ai cerut tu asta, răspunde imediat la acest e-mail.`,
    html: layout({
      lang: "ro",
      publicUrl: input.publicUrl,
      preheader: "Autentificarea în doi pași a fost resetată. Pornește-o din nou.",
      title: "Doi pași, resetat",
      body: [
        `Bună, ${escapeHtml(input.name)}. Echipa Zen Staff a resetat autentificarea în doi pași a contului tău și a închis toate sesiunile.`,
        `Motivul: <b>${escapeHtml(input.reason)}</b>`,
        "Intră din nou și pornește imediat autentificarea în doi pași:",
      ],
      button: { label: "Pornește doi pași", href: link },
      foot: ["Cheile de acces (passkeys) au rămas. Dacă nu ai cerut tu asta, răspunde imediat la acest e-mail."],
    }),
  };
}
