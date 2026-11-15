// Where an invited person downloads Zen Staff: the release bucket's fixed links (they always point
// at the newest beta build) and the product page for everything else. Used by the invitation
// e-mail and the invitation page.
export const ZEN_DOWNLOADS = {
  windows: "https://releases.zed-zen.com/beta/win/Zen-Staff-Setup-x64.exe",
  linuxAppImage: "https://releases.zed-zen.com/beta/linux/Zen-Staff-x86_64.AppImage",
  linuxDeb: "https://releases.zed-zen.com/beta/linux/Zen-Staff-amd64.deb",
  page: "https://zenstaff.app",
} as const;

/**
 * The name shown for whoever invites. An account without a chosen name carries the part of the
 * address before "@" ("ion.popa"), which tells the invited person little: show the full address.
 */
export function inviterLabel(name: string | null | undefined, email: string | null | undefined): string {
  const cleanName = (name ?? "").trim();
  const cleanEmail = (email ?? "").trim();
  if (cleanName === "") return cleanEmail === "" ? "Zen Staff" : cleanEmail;
  if (cleanEmail !== "" && cleanName.toLowerCase() === cleanEmail.split("@")[0]!.toLowerCase()) return cleanEmail;
  return cleanName;
}
