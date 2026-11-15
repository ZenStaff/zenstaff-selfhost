// The web dashboard's texts (src/assets/web/app.js): Romanian and English have the same keys and the
// same {placeholders}, the English has no Romanian left in it, and every t("key") the script asks
// for exists. The dictionaries are plain object literals; they are evaluated on their own, without
// the rest of the script (which needs a browser).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/assets/web/app.js", import.meta.url), "utf8");

function dictionaries(): { ro: Record<string, string>; en: Record<string, string> } {
  const start = source.indexOf("const DICT = {");
  const end = source.indexOf("\n};\n", start);
  assert.ok(start >= 0 && end > start, "the DICT literal");
  const parts = [source.slice(start, end + 3)];
  for (const match of source.matchAll(/^Object\.assign\(DICT\.(?:ro|en), \{\n[\s\S]*?^\}\);$/gm)) parts.push(match[0]);
  return vm.runInNewContext(`${parts.join("\n")}\nDICT`) as { ro: Record<string, string>; en: Record<string, string> };
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("dashboard texts", () => {
  const { ro, en } = dictionaries();

  it("English and Romanian have the same keys", () => {
    assert.ok(Object.keys(ro).length > 700, "the Romanian dictionary is there");
    assert.deepEqual(Object.keys(en).filter((key) => !(key in ro)), [], "English keys missing in Romanian");
    assert.deepEqual(Object.keys(ro).filter((key) => !(key in en)), [], "Romanian keys missing in English");
  });

  it("every text keeps the same placeholders and is not empty", () => {
    for (const key of Object.keys(ro)) {
      assert.deepEqual(placeholders(en[key] ?? ""), placeholders(ro[key]!), `placeholders of ${key}`);
      assert.notEqual((en[key] ?? "").trim(), "", `English ${key} is empty`);
    }
  });

  it("the English has no Romanian letters or quotes left", () => {
    const left = Object.entries(en).filter(([, text]) => /[ăâîșțşţĂÂÎȘȚ„”]/.test(text));
    assert.deepEqual(left, []);
  });

  it("every literal key the script asks for exists", () => {
    const used = new Set([...source.matchAll(/\bt\("([\w.:-]+)"/g)].map((match) => match[1]!));
    assert.deepEqual([...used].filter((key) => !(key in ro)), []);
  });
});
