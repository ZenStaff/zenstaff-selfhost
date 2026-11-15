// Automatic checks on a community pack upload. Pure functions: the route hands them the decoded
// files and the metadata, they answer one result per check (pass, warn or fail). A failed check
// refuses the upload with the reasons; warnings go to the reviewer with the submission.
//
// The pack format is the registry's (app/apps/server/src/zen/workflows in the public repository): either one
// workflow at the root (workflow.json + prompt.md) whose id is the pack id, or one sub-folder per
// workflow. Community packs never get Enterprise access, unattended runs or secrets.
import { readFileSync } from "node:fs";

export type CheckLevel = "pass" | "warn" | "fail";

export interface CheckResult {
  readonly id: CheckId;
  readonly level: CheckLevel;
  /** Plain-language findings, each naming the file when there is one. */
  readonly findings: ReadonlyArray<string>;
}

export const CHECK_IDS = ["schema", "forbidden-keys", "secrets", "dependencies", "size", "scripts"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CATEGORIES = ["design", "pr", "video", "social", "sales", "reports", "admin"] as const;
export const LICENCES = ["MIT", "CC-BY-4.0", "Apache-2.0", "CC0-1.0"] as const;
export const LANGUAGES = ["ro", "en", "ro+en"] as const;

export const LIMITS = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 5 * 1024 * 1024,
  screenshots: 4,
  screenshotBytes: 600 * 1024,
  pathLength: 200,
} as const;

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ICON = /^[a-z0-9-]{1,40}$/;
const TEXT_EXT = /\.(md|txt|json|js|mjs|cjs|ts|py|sh|ps1|html|css|csv|yml|yaml|svg|xml|toml)$/i;
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh|ps1|bat|cmd)$/i;
const ALLOWED_EXT = /\.(md|txt|json|js|mjs|cjs|ts|py|sh|ps1|html|css|csv|yml|yaml|svg|xml|toml|png|jpg|jpeg|webp|gif|woff2|ttf|otf|wav|mp3|ogg)$/i;

interface Catalog {
  readonly tools: ReadonlyArray<string>;
  readonly reservedIds: ReadonlyArray<string>;
}

export const CATALOG: Catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as Catalog;

export interface PackMeta {
  readonly title: string;
  readonly description: string;
  readonly category: (typeof CATEGORIES)[number];
  readonly icon: string;
  readonly licence: (typeof LICENCES)[number];
  readonly language: (typeof LANGUAGES)[number];
  readonly changelog: string;
  /** What a run produces, in words (shown on the share page next to the sample images). */
  readonly sampleOutput: string;
}

export interface Screenshot {
  readonly name: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Buffer;
}

/** Blocked versions per tool, from the published advisories file (toolchains.ts). */
export type Advisories = Record<string, { minSafeVersion?: string; blockedVersions: ReadonlyArray<{ version: string; reason: string }> }>;

export interface CheckInput {
  readonly packId: string;
  readonly version: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly screenshots: ReadonlyArray<Screenshot>;
  /** The files of the version published before this one, if any (to spot changed `requires`). */
  readonly previous: ReadonlyMap<string, Buffer> | null;
  readonly advisories: Advisories;
}

// ---- Path and manifest helpers ----------------------------------------------------------------

/** A relative path inside the pack, or null: no absolute paths, no `..`, no backslashes, no hidden control files. */
export function safePackPath(path: string): string | null {
  if (path.length === 0 || path.length > LIMITS.pathLength) return null;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  // The app writes these itself on install or customization; a pack may not bring them.
  if (parts.some((part) => part === ".zen-pack.json" || part === ".zen-custom.json" || part === ".zen-custom" || part === ".git")) return null;
  return path;
}

/** The workflow folders of the pack: "" for a root workflow, else the sub-folder names. */
export function workflowFolders(files: ReadonlyMap<string, Buffer>): Array<string> {
  if (files.has("workflow.json")) return [""];
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const match = /^([^/]+)\/workflow\.json$/.exec(path);
    if (match !== null) folders.add(match[1]!);
  }
  return [...folders].toSorted();
}

const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

function parseJson(bytes: Buffer | undefined): Record<string, unknown> | null {
  if (bytes === undefined) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function manifests(files: ReadonlyMap<string, Buffer>): Array<{ folder: string; manifest: Record<string, unknown> | null }> {
  return workflowFolders(files).map((folder) => ({ folder, manifest: parseJson(files.get(join(folder, "workflow.json"))) }));
}

/** Workflow ids of a multi-workflow pack (registry `workflows`), or null for a root workflow. */
export function workflowIds(files: ReadonlyMap<string, Buffer>): Array<string> | null {
  const folders = workflowFolders(files);
  if (folders.length === 1 && folders[0] === "") return null;
  return folders;
}

// ---- The checks -------------------------------------------------------------------------------

export function checkSchema(input: CheckInput): CheckResult {
  const findings: Array<string> = [];
  if (!PACK_ID.test(input.packId)) findings.push("The pack id uses 2 to 64 lowercase letters, digits or dashes.");
  if (CATALOG.reservedIds.includes(input.packId)) findings.push(`The id ${input.packId} belongs to a Zen Staff pack; pick another one.`);
  if (!VERSION.test(input.version)) findings.push("The version looks like 1.0.0.");
  const found = manifests(input.files);
  if (found.length === 0) findings.push("No workflow.json at the root of the pack or in a sub-folder.");
  if (found.length > 12) findings.push("A pack holds at most 12 workflows.");
  for (const { folder, manifest } of found) {
    const where = join(folder, "workflow.json");
    if (manifest === null) {
      findings.push(`${where}: not valid JSON.`);
      continue;
    }
    const id = manifest.id;
    if (typeof id !== "string" || !PACK_ID.test(id)) findings.push(`${where}: the id uses 2 to 64 lowercase letters, digits or dashes.`);
    else if (folder === "" && id !== input.packId) findings.push(`${where}: the id must be the pack id (${input.packId}).`);
    else if (folder !== "" && id !== folder) findings.push(`${where}: the id must be the folder name (${folder}).`);
    else if (folder !== "" && CATALOG.reservedIds.includes(id)) findings.push(`${where}: ${id} belongs to a Zen Staff workflow; rename it.`);
    if (typeof manifest.name !== "string" || manifest.name.trim() === "" || manifest.name.length > 80) findings.push(`${where}: give it a name under 80 characters.`);
    if (typeof manifest.description !== "string" || manifest.description.length > 400) findings.push(`${where}: the description is text under 400 characters.`);
    if (typeof manifest.category !== "string" || !(CATEGORIES as ReadonlyArray<string>).includes(manifest.category)) findings.push(`${where}: unknown category.`);
    if (typeof manifest.icon !== "string" || !ICON.test(manifest.icon)) findings.push(`${where}: the icon is a lucide icon name.`);
    if (typeof manifest.output !== "string") findings.push(`${where}: say in "output" what a run produces.`);
    if (typeof manifest.version !== "string" || typeof manifest.author !== "string") findings.push(`${where}: "version" and "author" are required.`);
    if (!Array.isArray(manifest.inputs) || manifest.inputs.length > 20) findings.push(`${where}: inputs is a list of at most 20.`);
    else {
      for (const raw of manifest.inputs as Array<unknown>) {
        const item = raw as { id?: unknown; label?: unknown; type?: unknown };
        if (typeof item?.id !== "string" || typeof item.label !== "string" || !["text", "longtext", "select", "file", "url"].includes(String(item.type))) {
          findings.push(`${where}: every input needs an id, a label and a type (text, longtext, select, file or url).`);
          break;
        }
      }
    }
    if (!input.files.has(join(folder, "prompt.md"))) findings.push(`${join(folder, "prompt.md")} is missing.`);
  }
  return { id: "schema", level: findings.length === 0 ? "pass" : "fail", findings };
}

/** Keys that give a workflow powers the community library never hands out. */
const FORBIDDEN_MANIFEST_KEYS = ["access", "unattended", "enterprise", "secrets", "env", "grants"] as const;

const requiresOf = (files: ReadonlyMap<string, Buffer>) =>
  new Map(manifests(files).map(({ folder, manifest }) => [folder, JSON.stringify(manifest?.requires ?? null)]));

export function checkForbiddenKeys(input: CheckInput): CheckResult {
  const fail: Array<string> = [];
  const warn: Array<string> = [];
  for (const { folder, manifest } of manifests(input.files)) {
    if (manifest === null) continue;
    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      if (key in manifest) fail.push(`${join(folder, "workflow.json")}: "${key}" is not allowed in community packs (no Enterprise access, unattended runs or secrets).`);
    }
  }
  if (input.previous !== null) {
    const before = requiresOf(input.previous);
    for (const [folder, now] of requiresOf(input.files)) {
      const was = before.get(folder);
      if (was !== undefined && was !== now) warn.push(`${join(folder, "workflow.json")}: "requires" changed since the published version (tools, hardware or network); the reviewer checks it.`);
    }
  }
  return { id: "forbidden-keys", level: fail.length > 0 ? "fail" : warn.length > 0 ? "warn" : "pass", findings: [...fail, ...warn] };
}

/** Patterns in the spirit of gitleaks' default rules: real keys only, not words like "token". */
const SECRET_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Slack webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/ },
  { name: "Stripe key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Resend key", pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/ },
  { name: "SendGrid key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: "Telegram bot token", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "password in a URL", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s/]+/i },
  {
    name: "hard-coded key",
    pattern: /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i,
  },
];

export function scanSecrets(text: string): Array<string> {
  const hits: Array<string> = [];
  for (const rule of SECRET_RULES) if (rule.pattern.test(text)) hits.push(rule.name);
  return hits;
}

export function checkSecrets(input: CheckInput): CheckResult {
  const findings: Array<string> = [];
  for (const [path, bytes] of input.files) {
    if (!TEXT_EXT.test(path)) continue;
    for (const name of scanSecrets(bytes.toString("utf8"))) findings.push(`${path}: looks like a ${name}. Remove it; community packs never carry secrets.`);
  }
  return { id: "secrets", level: findings.length === 0 ? "pass" : "fail", findings };
}

const plainVersion = (value: string) => value.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((part) => Number(part) || 0);
function compareVersions(left: string, right: string): number {
  const a = plainVersion(left);
  const b = plainVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function checkDependencies(input: CheckInput): CheckResult {
  const fail: Array<string> = [];
  const warn: Array<string> = [];
  for (const { folder, manifest } of manifests(input.files)) {
    const requires = manifest?.requires as { tools?: unknown } | undefined;
    if (requires === undefined || requires === null) continue;
    const where = join(folder, "workflow.json");
    if (requires.tools !== undefined && !Array.isArray(requires.tools)) {
      fail.push(`${where}: requires.tools must be a list.`);
      continue;
    }
    for (const raw of (requires.tools ?? []) as Array<unknown>) {
      const tool = raw as { id?: unknown; version?: unknown };
      if (typeof tool?.id !== "string") {
        fail.push(`${where}: every tool needs an id.`);
        continue;
      }
      if (!CATALOG.tools.includes(tool.id)) {
        fail.push(`${where}: ${tool.id} is not in the Zen Staff toolchain catalog. Packs only use tools Zen Staff installs and checks.`);
        continue;
      }
      const advisory = input.advisories[tool.id];
      if (advisory === undefined) continue;
      const wanted = typeof tool.version === "string" ? tool.version.trim() : "";
      const exact = /^v?\d+(\.\d+)*$/.test(wanted) ? wanted : null;
      if (exact !== null && advisory.blockedVersions.some((blocked) => blocked.version === exact)) {
        fail.push(`${where}: ${tool.id} ${exact} has a known security problem; ask for ${advisory.minSafeVersion ?? "a newer version"} or later.`);
      } else if (exact !== null && advisory.minSafeVersion !== undefined && compareVersions(exact, advisory.minSafeVersion) < 0) {
        fail.push(`${where}: ${tool.id} ${exact} is older than the safe version ${advisory.minSafeVersion}.`);
      } else if (advisory.blockedVersions.length > 0) {
        warn.push(`${where}: ${tool.id} has advisories; Zen Staff refuses the blocked versions on install.`);
      }
    }
  }
  return { id: "dependencies", level: fail.length > 0 ? "fail" : warn.length > 0 ? "warn" : "pass", findings: [...fail, ...warn] };
}

const MAGIC: Record<Screenshot["mime"], (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

export function checkSize(input: CheckInput): CheckResult {
  const findings: Array<string> = [];
  let total = 0;
  if (input.files.size > LIMITS.files) findings.push(`At most ${LIMITS.files} files per pack (this one has ${input.files.size}).`);
  for (const [path, bytes] of input.files) {
    total += bytes.length;
    if (bytes.length > LIMITS.fileBytes) findings.push(`${path}: larger than 2 MB.`);
    if (!ALLOWED_EXT.test(path)) findings.push(`${path}: this kind of file is not allowed in a pack (no programs or archives).`);
  }
  if (total > LIMITS.totalBytes) findings.push("The pack is larger than 5 MB.");
  if (input.screenshots.length > LIMITS.screenshots) findings.push(`At most ${LIMITS.screenshots} images of the result.`);
  for (const shot of input.screenshots) {
    if (shot.bytes.length > LIMITS.screenshotBytes) findings.push(`Image ${shot.name}: larger than 600 KB.`);
    if (!(MAGIC[shot.mime]?.(shot.bytes) ?? false)) findings.push(`Image ${shot.name}: not a PNG, JPEG or WebP file.`);
  }
  return { id: "size", level: findings.length === 0 ? "pass" : "fail", findings };
}

/** Network use in a script. Packs that declare `requires.network: true` may use it (the reviewer still sees it). */
const NETWORK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "fetch()", pattern: /\bfetch\s*\(/ },
  { name: "an HTTP request", pattern: /\b(?:https?|http2)\.(?:request|get)\s*\(|require\(\s*["'](?:node:)?(?:https?|net|tls|dgram|http2)["']\s*\)|from\s+["'](?:node:)?(?:https?|net|tls|dgram|http2)["']/ },
  { name: "a socket", pattern: /\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|\bsocket\.socket\s*\(|\bnet\.connect\s*\(/ },
  { name: "an HTTP library", pattern: /\b(?:axios|got|node-fetch|undici)\b|^\s*(?:import|from)\s+(?:requests|urllib3?|httpx|aiohttp|socket)\b|\burllib\.request\b|\brequests\.(?:get|post|put|delete)\s*\(/m },
  { name: "a download command", pattern: /(?:^|[\s;|&`(])(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|scp|ssh|ftp)\s/m },
];

/** Writes or deletes outside the pack's own folder (and the working folder the agent gives it). */
const OUTSIDE_WRITE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "the home folder", pattern: /\bos\.homedir\s*\(|process\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)|os\.path\.expanduser|Path\.home\s*\(|\$HOME\b|%USERPROFILE%|%APPDATA%|(?:^|["'\s])~\// },
  {
    name: "an absolute path",
    pattern: /(?:writeFile|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|copyFile|open)(?:Sync)?\s*\(\s*["'`](?:\/|[A-Za-z]:[\\/])|\bopen\s*\(\s*["'](?:\/|[A-Za-z]:[\\/])[^"']*["']\s*,\s*["'][wa]|(?:>|>>|\btee\s+(?:-a\s+)?)\s*["']?\/(?!dev\/null)[a-z]/,
  },
  { name: "a parent folder", pattern: /["'`][^"'`\n]*(?:\.\.\/|\.\.\\)[^"'`\n]*["'`]/ },
  { name: "deleting a folder tree", pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME|\*)|shutil\.rmtree\s*\(\s*["'](?:\/|~)|Remove-Item\s+[^\n]*-Recurse[^\n]*(?:C:\\|\$env:)/i },
  { name: "system settings", pattern: /\b(?:reg\s+add|Set-ItemProperty\s+-Path\s+HK|crontab\s+-|launchctl\s+load|schtasks\s+\/create|systemctl\s+enable|chmod\s+[0-7]*7[0-7]*\s+\/)/i },
];

/** Running other programs or code from text: allowed only through declared tools, so the reviewer looks. */
const EXEC_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "eval", pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*compile\b/ },
  { name: "a child process", pattern: /child_process|\bsubprocess\.|\bos\.system\s*\(|\bStart-Process\b/ },
];

export function checkScripts(input: CheckInput): CheckResult {
  const fail: Array<string> = [];
  const warn: Array<string> = [];
  const declaresNetwork = manifests(input.files).some(({ manifest }) => (manifest?.requires as { network?: unknown } | undefined)?.network === true);
  for (const [path, bytes] of input.files) {
    if (!SCRIPT_EXT.test(path)) continue;
    const text = bytes.toString("utf8");
    for (const { name, pattern } of NETWORK_PATTERNS) {
      if (!pattern.test(text)) continue;
      if (declaresNetwork) warn.push(`${path}: uses ${name}; the pack declares network use, the reviewer checks where it goes.`);
      else fail.push(`${path}: uses ${name}, but the pack does not declare network use (requires.network). Scripts only reach the network through declared tools.`);
    }
    for (const { name, pattern } of OUTSIDE_WRITE_PATTERNS) {
      if (pattern.test(text)) fail.push(`${path}: writes to ${name}. Scripts only write inside the pack folder and the working folder they are given.`);
    }
    for (const { name, pattern } of EXEC_PATTERNS) {
      if (pattern.test(text)) warn.push(`${path}: uses ${name}; the reviewer checks what it runs.`);
    }
  }
  return { id: "scripts", level: fail.length > 0 ? "fail" : warn.length > 0 ? "warn" : "pass", findings: [...fail, ...warn] };
}

export function runChecks(input: CheckInput): Array<CheckResult> {
  return [checkSchema(input), checkForbiddenKeys(input), checkSecrets(input), checkDependencies(input), checkSize(input), checkScripts(input)];
}

export const blocking = (results: ReadonlyArray<CheckResult>) => results.some((result) => result.level === "fail");

/** Reads and validates the author's metadata; throws a plain message on the first problem. */
export function parseMeta(raw: unknown): PackMeta {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number, required = true) => {
    const item = value[key];
    if (item === undefined || item === null || item === "") {
      if (required) throw new Error(`${key} is required.`);
      return "";
    }
    if (typeof item !== "string") throw new Error(`${key} must be text.`);
    if (item.length > max) throw new Error(`${key} is too long.`);
    return item.trim();
  };
  const oneOf = <T extends string>(key: string, options: ReadonlyArray<T>, fallback?: T): T => {
    const item = value[key] ?? fallback;
    if (typeof item !== "string" || !(options as ReadonlyArray<string>).includes(item)) throw new Error(`${key} must be one of ${options.join(", ")}.`);
    return item as T;
  };
  const icon = text("icon", 40, false) || "sparkles";
  if (!ICON.test(icon)) throw new Error("icon is a lucide icon name.");
  return {
    title: text("title", 80),
    description: text("description", 600),
    category: oneOf("category", CATEGORIES),
    icon,
    licence: oneOf("licence", LICENCES, "MIT"),
    language: oneOf("language", LANGUAGES, "ro"),
    changelog: text("changelog", 2000, false),
    sampleOutput: text("sampleOutput", 1000, false),
  };
}

/** The test-run steps the reviewer follows, for one version (shown on the review page, in Romanian). */
export function testRunSteps(input: { previewIndexUrl: string | null; packId: string; version: string; workflows: ReadonlyArray<string> | null }): Array<string> {
  const first = input.workflows?.[0] ?? input.packId;
  const link = input.previewIndexUrl ?? "linkul de test (butonul de mai jos)";
  return [
    "Deschide un Zen Staff separat, izolat: pe Linux sau macOS `ZEN_HOME=$(mktemp -d) zen-staff`; pe Windows, în PowerShell, `$env:ZEN_HOME = New-Item -ItemType Directory (Join-Path $env:TEMP (New-Guid))`, apoi pornește Zen Staff din aceeași fereastră. Nu te conecta la niciun hub și nu lega niciun cont.",
    "Lasă aprobările pornite (Setări > Aprobări: Întreabă de fiecare dată) și izolarea uneltelor pornită (implicit). Nu da niciodată Enterprise și nu adăuga chei pentru un pachet din comunitate.",
    `Bibliotecă > „De unde vin sarcinile”: lipește ${link} și salvează. Linkul merge 2 ore și arată doar ${input.packId} ${input.version}.`,
    `Instalează ${input.packId}, deschide ${first} pe Birou, completează exemplele și rulează-l într-un folder gol. Urmărește fiecare aprobare cerută: unelte nedeclarate, rețea nedeclarată sau fișiere în afara folderului lui înseamnă „Cere modificări”.`,
    "Compară rezultatul cu imaginile și descrierea autorului, apoi șterge adresa de test și folderul temporar.",
  ];
}
