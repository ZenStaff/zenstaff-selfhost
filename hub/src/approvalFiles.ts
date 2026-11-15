// Files of client approval links: what may be uploaded (images, a video, a PDF, a post text), how
// the type is decided (by the bytes, never by the name the app sends), the size limits, and the
// folder on the data volume where they are kept. Pure checks first, then the small disk store.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalFileKind = "image" | "video" | "pdf" | "text";

export interface CheckedFile {
  readonly kind: ApprovalFileKind;
  readonly mime: string;
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** Per file, by kind; the whole link and each company have their own caps (routes/approvals.ts). */
export const APPROVAL_LIMITS = {
  image: 15 * 1024 * 1024,
  video: 60 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  text: 512 * 1024,
  logo: 2 * 1024 * 1024,
  filesPerLink: 10,
  bytesPerLink: 80 * 1024 * 1024,
} as const;

export class ApprovalFileError extends Error {}

const startsWith = (bytes: Buffer, signature: ReadonlyArray<number>, offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

/** The type from the first bytes. SVG and HTML are never accepted (they can carry script). */
export function sniff(bytes: Buffer): { kind: ApprovalFileKind; mime: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "image", mime: "image/webp" };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "pdf", mime: "application/pdf" };
  // ISO base media (MP4 / MOV): a box whose type is "ftyp" at offset 4.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    return { kind: "video", mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm" };
  return null;
}

/** Text is accepted when it is valid UTF-8 without NUL bytes and does not look like HTML or SVG. */
export function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<?xml")) return null;
  return text;
}

/** Width and height from PNG, GIF, JPEG and WebP headers (for the page's reserved space). */
export function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mime === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mime === "image/webp" && bytes.length >= 30) {
      const chunk = bytes.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Removes control characters (C0 and DEL). */
export function stripControl(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
}

/** A display name: no folders, no control characters, at most 120 characters. */
export function cleanFileName(raw: unknown, fallback: string): string {
  const base = typeof raw === "string" ? (raw.split(/[\\/]/).pop() ?? "") : "";
  const cleaned = stripControl(base).replace(/["<>]/g, "").trim().replace(/^\.+/, "");
  return (cleaned === "" ? fallback : cleaned).slice(0, 120);
}

/** Decodes and checks one uploaded file. `role` logo: images only, smaller cap. */
export function checkFile(input: { name: unknown; data: unknown }, role: "file" | "logo"): CheckedFile {
  if (typeof input.data !== "string" || input.data === "") throw new ApprovalFileError("A file is empty.");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(input.data)) throw new ApprovalFileError("A file is not valid base64.");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length === 0) throw new ApprovalFileError("A file is empty.");
  const name = cleanFileName(input.name, role === "logo" ? "logo" : "fisier");
  const sniffed = sniff(bytes);
  const text = sniffed === null ? asText(bytes) : null;
  const detected = sniffed ?? (text === null ? null : { kind: "text" as const, mime: "text/plain; charset=utf-8" });
  if (detected === null) throw new ApprovalFileError(`${name}: only images (PNG, JPEG, WebP, GIF), video (MP4, WebM), PDF and text can be sent.`);
  if (role === "logo" && detected.kind !== "image") throw new ApprovalFileError("The logo must be a PNG, JPEG, WebP or GIF image.");
  const cap = role === "logo" ? APPROVAL_LIMITS.logo : APPROVAL_LIMITS[detected.kind];
  if (bytes.length > cap) throw new ApprovalFileError(`${name} is larger than ${Math.round(cap / 1024 / 1024) || 0.5} MB.`);
  const size = detected.kind === "image" ? imageSize(bytes, detected.mime) : null;
  return {
    kind: detected.kind,
    mime: detected.mime,
    name,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: size !== null && size.width > 0 && size.width < 100_000 ? size.width : null,
    height: size !== null && size.height > 0 && size.height < 100_000 ? size.height : null,
  };
}

/** Where the bytes live: `<dir>/<approval id>/<index>`. Ids are generated by the hub, never typed. */
export interface ApprovalStorage {
  write(approvalId: string, index: number, bytes: Buffer): void;
  read(approvalId: string, index: number): Buffer | null;
  remove(approvalId: string): void;
}

const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/;

export function diskStorage(dir: string): ApprovalStorage {
  const folder = (approvalId: string) => {
    if (!SAFE_ID.test(approvalId)) throw new Error("bad approval id");
    return join(dir, approvalId);
  };
  return {
    write(approvalId, index, bytes) {
      const target = folder(approvalId);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      writeFileSync(join(target, String(index)), bytes, { mode: 0o600 });
    },
    read(approvalId, index) {
      try {
        return readFileSync(join(folder(approvalId), String(index)));
      } catch {
        return null;
      }
    },
    remove(approvalId) {
      rmSync(folder(approvalId), { recursive: true, force: true });
    },
  };
}

/** For tests and a hub without a data folder: kept in memory. */
export function memoryStorage(): ApprovalStorage {
  const files = new Map<string, Buffer>();
  return {
    write: (approvalId, index, bytes) => void files.set(`${approvalId}/${index}`, bytes),
    read: (approvalId, index) => files.get(`${approvalId}/${index}`) ?? null,
    remove(approvalId) {
      for (const key of files.keys()) if (key.startsWith(`${approvalId}/`)) files.delete(key);
    },
  };
}
