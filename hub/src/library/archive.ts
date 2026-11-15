// The archive a published community pack is served as: a gzipped ustar file with the pack files at
// its root, the format the app's remote registry reads (`readTarGz` in remoteRegistry.ts). Built
// deterministically (fixed times and modes, sorted paths), so the same files give the same sha256.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(512, 0);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`Path too long for the archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const write = (text: string, offset: number, length: number) => block.write(text, offset, length, "utf8");
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";
  write(name, 0, 100);
  write(octal(0o644, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(0, 12), 136, 12);
  block.fill(0x20, 148, 156);
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return block;
}

export function tarGz(files: ReadonlyMap<string, Buffer>): Buffer {
  const parts: Array<Buffer> = [];
  for (const path of [...files.keys()].toSorted()) {
    const bytes = files.get(path)!;
    parts.push(header(path, bytes.length), bytes);
    const pad = (512 - (bytes.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 } as never);
}

export const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
