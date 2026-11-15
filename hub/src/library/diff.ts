// What changed between two versions of a pack, for the reviewer: added, removed and changed files,
// and a unified line diff per changed text file (LCS, capped so a huge file cannot stall the hub).
const TEXT = /\.(md|txt|json|js|mjs|cjs|ts|py|sh|ps1|html|css|csv|yml|yaml|svg|xml|toml)$/i;
const MAX_LINES = 3000;
const CONTEXT = 3;

export interface FileDiff {
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  /** Unified diff lines (" ", "+", "-" prefixed, "@@" hunks), or null for binaries and huge files. */
  readonly lines: ReadonlyArray<string> | null;
}

function lineDiff(before: Array<string>, after: Array<string>): Array<string> | null {
  if (before.length > MAX_LINES || after.length > MAX_LINES) return null;
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: " " | "+" | "-"; text: string; a: number; b: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) ops.push({ kind: " ", text: before[i++]!, a: i, b: ++j });
    else if (j < m && (i >= n || table[i]![j + 1]! >= table[i + 1]![j]!)) ops.push({ kind: "+", text: after[j++]!, a: i, b: j });
    else ops.push({ kind: "-", text: before[i++]!, a: i, b: j });
  }
  const out: Array<string> = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === " ") {
      index += 1;
      continue;
    }
    let start = Math.max(0, index - CONTEXT);
    let end = index;
    while (end < ops.length) {
      let next = end;
      while (next < ops.length && ops[next]!.kind !== " ") next += 1;
      let gap = next;
      while (gap < ops.length && ops[gap]!.kind === " ") gap += 1;
      end = next;
      if (gap >= ops.length || gap - next > CONTEXT * 2) break;
      end = gap;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    out.push(`@@ ${ops[start]!.a} ${ops[start]!.b} @@`);
    for (; start < stop; start += 1) out.push(`${ops[start]!.kind}${ops[start]!.text}`);
    index = stop;
  }
  return out;
}

export function diffPacks(before: ReadonlyMap<string, Buffer> | null, after: ReadonlyMap<string, Buffer>): Array<FileDiff> {
  const old = before ?? new Map<string, Buffer>();
  const paths = [...new Set([...old.keys(), ...after.keys()])].toSorted();
  const result: Array<FileDiff> = [];
  for (const path of paths) {
    const a = old.get(path);
    const b = after.get(path);
    if (a !== undefined && b !== undefined && a.equals(b)) continue;
    const text = TEXT.test(path);
    const split = (bytes: Buffer | undefined) => (bytes === undefined ? [] : bytes.toString("utf8").split("\n"));
    result.push({
      path,
      change: a === undefined ? "added" : b === undefined ? "removed" : "changed",
      lines: text ? lineDiff(split(a), split(b)) : null,
    });
  }
  return result;
}
