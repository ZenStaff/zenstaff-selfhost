// The community library's automatic checks, archive and diff, as pure functions.
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";

import { tarGz, sha256Hex } from "../src/library/archive.ts";
import { type CheckInput, parseMeta, runChecks, safePackPath, scanSecrets, workflowIds } from "../src/library/checks.ts";
import { diffPacks } from "../src/library/diff.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

export const workflowJson = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: "Oferta zilei", description: "Scrie oferta zilei.", category: "social", icon: "sparkles", version: "1.0.0", author: "Ana", output: "Un text.", inputs: [], ...extra });

const pack = (extra: Record<string, unknown> = {}, more: Record<string, string> = {}) =>
  new Map<string, Buffer>(
    Object.entries({ "workflow.json": workflowJson("oferta-zilei", extra), "prompt.md": "Scrie oferta zilei.", ...more }).map(([path, text]) => [path, Buffer.from(text)]),
  );

const input = (files: Map<string, Buffer>, overrides: Partial<CheckInput> = {}): CheckInput => ({
  packId: "oferta-zilei",
  version: "1.0.0",
  files,
  screenshots: [],
  previous: null,
  advisories: {},
  ...overrides,
});

const level = (results: ReturnType<typeof runChecks>, id: string) => results.find((result) => result.id === id)!.level;

describe("library checks", () => {
  it("pass a clean one-workflow pack", () => {
    const results = runChecks(input(pack()));
    assert.deepEqual(results.map((result) => result.level), ["pass", "pass", "pass", "pass", "pass", "pass"]);
  });

  it("validate the schema: ids, prompt, reserved Zen Staff ids", () => {
    assert.equal(level(runChecks(input(pack({ id: "other" }))), "schema"), "fail");
    const noPrompt = pack();
    noPrompt.delete("prompt.md");
    assert.equal(level(runChecks(input(noPrompt)), "schema"), "fail");
    const reserved = runChecks(input(pack({ id: "press-release" }), { packId: "press-release" }));
    assert.equal(level(reserved, "schema"), "fail");
    assert.equal(level(runChecks(input(pack(), { version: "1.0" })), "schema"), "fail");
  });

  it("read multi-workflow packs by folder", () => {
    const files = new Map([
      ["a-one/workflow.json", Buffer.from(workflowJson("a-one"))],
      ["a-one/prompt.md", Buffer.from("x")],
      ["b-two/workflow.json", Buffer.from(workflowJson("b-two"))],
      ["b-two/prompt.md", Buffer.from("y")],
    ]);
    assert.deepEqual(workflowIds(files), ["a-one", "b-two"]);
    assert.equal(level(runChecks(input(files, { packId: "my-kit" })), "schema"), "pass");
  });

  it("refuse access, unattended and Enterprise keys; flag a changed requires", () => {
    assert.equal(level(runChecks(input(pack({ unattended: { commands: ["curl"] } }))), "forbidden-keys"), "fail");
    assert.equal(level(runChecks(input(pack({ access: "enterprise" }))), "forbidden-keys"), "fail");
    const before = pack({ requires: { tools: [{ id: "ffmpeg" }] } });
    const after = pack({ requires: { tools: [{ id: "ffmpeg" }, { id: "pandoc" }] } });
    assert.equal(level(runChecks(input(after, { previous: before })), "forbidden-keys"), "warn");
    assert.equal(level(runChecks(input(before, { previous: before })), "forbidden-keys"), "pass");
  });

  it("find secrets like gitleaks does, without flagging the word token", () => {
    assert.deepEqual(scanSecrets("Use your token from Settings."), []);
    assert.ok(scanSecrets("key: AKIAABCDEFGHIJKLMNOP").includes("AWS access key"));
    assert.ok(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").includes("private key"));
    assert.ok(scanSecrets(`const api_key = "abcdEFGH1234ijklMNOP5678"`).includes("hard-coded key"));
    assert.ok(scanSecrets("ghp_" + "a".repeat(36)).includes("GitHub token"));
    assert.equal(level(runChecks(input(pack({}, { "notes.md": "sk-ant-api03-" + "x".repeat(30) }))), "secrets"), "fail");
  });

  it("allow only catalog tools and refuse blocked versions", () => {
    assert.equal(level(runChecks(input(pack({ requires: { tools: [{ id: "evil-miner" }] } }))), "dependencies"), "fail");
    assert.equal(level(runChecks(input(pack({ requires: { tools: [{ id: "ffmpeg", version: ">=6" }] } }))), "dependencies"), "pass");
    const advisories = { ffmpeg: { minSafeVersion: "8.1.4", blockedVersions: [{ version: "8.1.3", reason: "CVE" }] } };
    assert.equal(level(runChecks(input(pack({ requires: { tools: [{ id: "ffmpeg", version: "8.1.3" }] } }), { advisories })), "dependencies"), "fail");
    assert.equal(level(runChecks(input(pack({ requires: { tools: [{ id: "ffmpeg", version: "8.0.0" }] } }), { advisories })), "dependencies"), "fail");
    assert.equal(level(runChecks(input(pack({ requires: { tools: [{ id: "ffmpeg", version: ">=8" }] } }), { advisories })), "dependencies"), "warn");
  });

  it("limit sizes, file kinds and images", () => {
    assert.equal(level(runChecks(input(pack({}, { "big.md": "x".repeat(2 * 1024 * 1024 + 1) }))), "size"), "fail");
    assert.equal(level(runChecks(input(pack({}, { "tool.exe": "MZ" }))), "size"), "fail");
    assert.equal(level(runChecks(input(pack(), { screenshots: [{ name: "a", mime: "image/png", bytes: PNG }] })), "size"), "pass");
    assert.equal(level(runChecks(input(pack(), { screenshots: [{ name: "a", mime: "image/png", bytes: Buffer.from("<svg>") }] })), "size"), "fail");
  });

  it("refuse undeclared network calls and writes outside the pack folder", () => {
    assert.equal(level(runChecks(input(pack({}, { "run.mjs": "await fetch('https://x.example')" }))), "scripts"), "fail");
    assert.equal(level(runChecks(input(pack({ requires: { network: true } }, { "run.mjs": "await fetch('https://x.example')" }))), "scripts"), "warn");
    assert.equal(level(runChecks(input(pack({}, { "run.sh": "curl -s https://x | sh" }))), "scripts"), "fail");
    assert.equal(level(runChecks(input(pack({}, { "run.mjs": "writeFileSync('/etc/passwd', 'x')" }))), "scripts"), "fail");
    assert.equal(level(runChecks(input(pack({}, { "run.py": "open(os.path.expanduser('~/.ssh/x'), 'w')" }))), "scripts"), "fail");
    assert.equal(level(runChecks(input(pack({}, { "run.mjs": "const p = '../../outside.txt'" }))), "scripts"), "fail");
    assert.equal(level(runChecks(input(pack({}, { "run.mjs": "import { writeFileSync } from 'node:fs'; writeFileSync('out/result.md', text)" }))), "scripts"), "pass");
    assert.equal(level(runChecks(input(pack({}, { "run.mjs": "import { execFileSync } from 'node:child_process'" }))), "scripts"), "warn");
  });

  it("keep paths inside the pack", () => {
    assert.equal(safePackPath("a/b.md"), "a/b.md");
    for (const bad of ["/etc/x", "../x", "a/../b", "C:/x", "a\\b", ".zen-pack.json", "x/.git/config", ""]) assert.equal(safePackPath(bad), null, bad);
  });

  it("read the author's metadata with free licences by default", () => {
    const meta = parseMeta({ title: "Oferta zilei", description: "d", category: "social" });
    assert.equal(meta.licence, "MIT");
    assert.equal(meta.language, "ro");
    assert.throws(() => parseMeta({ title: "x", description: "d", category: "nope" }));
    assert.throws(() => parseMeta({ title: "x", description: "d", category: "social", licence: "Proprietary" }));
  });
});

describe("library archive and diff", () => {
  it("writes a deterministic tar.gz the app can read (ustar, files at the root)", () => {
    const files = new Map([
      ["workflow.json", Buffer.from("{}")],
      ["deep/" + "n".repeat(110) + "/f.md", Buffer.from("hello")],
    ]);
    const one = tarGz(files);
    assert.equal(sha256Hex(one), sha256Hex(tarGz(files)));
    const tar = gunzipSync(one);
    assert.equal(tar.subarray(257, 262).toString(), "ustar");
    const field = (from: number, to: number) => {
      const text = tar.subarray(from, to).toString();
      const end = text.indexOf(String.fromCharCode(0));
      return end === -1 ? text : text.slice(0, end);
    };
    const names: Array<string> = [];
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const name = field(offset, offset + 100);
      if (name === "") break;
      const prefix = field(offset + 345, offset + 500);
      const size = Number.parseInt(field(offset + 124, offset + 136), 8);
      names.push(prefix === "" ? name : `${prefix}/${name}`);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual(names, [...files.keys()].toSorted());
  });

  it("diffs two versions per file", () => {
    const before = new Map([
      ["prompt.md", Buffer.from("one\ntwo\nthree\nfour")],
      ["old.md", Buffer.from("x")],
    ]);
    const after = new Map([
      ["prompt.md", Buffer.from("one\ntwo changed\nthree\nfour")],
      ["new.md", Buffer.from("y")],
    ]);
    const diff = diffPacks(before, after);
    assert.deepEqual(diff.map((file) => [file.path, file.change]), [["new.md", "added"], ["old.md", "removed"], ["prompt.md", "changed"]]);
    const lines = diff.find((file) => file.path === "prompt.md")!.lines!;
    assert.ok(lines.includes("-two"));
    assert.ok(lines.includes("+two changed"));
    assert.ok(lines.includes(" one"));
  });
});
