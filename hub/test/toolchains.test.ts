// The advisories file: published by the night job with a token, read by anyone.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Hub, startHub } from "./harness.ts";

let hub: Hub;
before(async () => {
  hub = await startHub({ config: { advisoriesToken: "night-token-123" } });
});
after(() => hub.close());

const file = (generatedAt: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  generatedAt,
  source: "osv.dev+nvd",
  tools: {
    ffmpeg: {
      minSafeVersion: "8.1.4",
      blockedVersions: [{ version: "8.1.3", reason: "Known security problem: CVE-2026-9", advisories: ["CVE-2026-9"] }],
    },
  },
  ...extra,
});

const put = (body: unknown, token?: string) =>
  fetch(`${hub.base}/v1/toolchains/advisories`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

describe("toolchain advisories", () => {
  it("answers 404 before anything is published", async () => {
    const response = await fetch(`${hub.base}/v1/toolchains/advisories`);
    assert.equal(response.status, 404);
  });

  it("refuses publishing without the token or with a wrong one", async () => {
    assert.equal((await put(file("2026-11-08T01:00:00.000Z"))).status, 401);
    assert.equal((await put(file("2026-11-08T01:00:00.000Z"), "wrong")).status, 401);
  });

  it("validates the shape and keeps only known fields", async () => {
    assert.equal((await put({ ...file("2026-11-08T01:00:00.000Z"), version: 2 }, "night-token-123")).status, 400);
    const badTool = { ...file("2026-11-08T01:00:00.000Z"), tools: { "../x": { blockedVersions: [] } } };
    assert.equal((await put(badTool, "night-token-123")).status, 400);
    const ok = await put(file("2026-11-08T01:00:00.000Z", { injected: "<script>" }), "night-token-123");
    assert.equal(ok.status, 200);
    const result = (await ok.json()) as { sha256: string; tools: number };
    assert.equal(result.tools, 1);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });

  it("serves the file publicly, without a session", async () => {
    const response = await fetch(`${hub.base}/v1/toolchains/advisories`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.generatedAt, "2026-11-08T01:00:00.000Z");
    assert.equal(body.injected, undefined);
    assert.equal((body.tools as Record<string, { minSafeVersion: string }>).ffmpeg?.minSafeVersion, "8.1.4");
  });

  it("never replaces a file with an older one", async () => {
    assert.equal((await put(file("2026-11-07T01:00:00.000Z"), "night-token-123")).status, 409);
    assert.equal((await put(file("2026-11-09T01:00:00.000Z"), "night-token-123")).status, 200);
    const body = (await (await fetch(`${hub.base}/v1/toolchains/advisories`)).json()) as { generatedAt: string };
    assert.equal(body.generatedAt, "2026-11-09T01:00:00.000Z");
  });
});

describe("toolchain advisories without a token configured", () => {
  it("refuses every publish", async () => {
    const plain = await startHub();
    try {
      const response = await fetch(`${plain.base}/v1/toolchains/advisories`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer " },
        body: JSON.stringify(file("2026-11-08T01:00:00.000Z")),
      });
      assert.equal(response.status, 401);
    } finally {
      await plain.close();
    }
  });
});
