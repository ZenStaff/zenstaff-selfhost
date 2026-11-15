// Test helpers: a hub on a random port, sign-in with a device key, signed relay calls, TOTP codes
// and a fake runner.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

import { createHub, type HubConfig } from "../src/app.ts";
import type { AuditLog } from "../src/auditChain.ts";
import { type Db, openDb } from "../src/db.ts";
import { makeMailer, type Mailer } from "../src/mail.ts";
import type { OauthProvider } from "../src/oauth.ts";
import { makeSecretBox } from "../src/secretBox.ts";
import { deviceCertMessage, keyIdOf, requestMessage, statementMessage } from "../src/signing.ts";
import { currentStep, totpAt } from "../src/totp.ts";

export interface Hub {
  readonly base: string;
  readonly mailer: Mailer;
  /** The hub's database, for tests that check what the hub keeps (never chat content). */
  readonly db: Db;
  /** The tamper-evident audit log (its own in-memory database here). */
  readonly auditLog: AuditLog;
  /** Resolves once queued SIEM deliveries are done. */
  siemIdle(): Promise<void>;
  close(): Promise<void>;
}

export async function startHub(
  options: { config?: Partial<HubConfig>; oauth?: Array<OauthProvider>; billing?: Parameters<typeof createHub>[0]["billing"] } = {},
): Promise<Hub & { billing: ReturnType<typeof createHub>["billing"] }> {
  const db = openDb(":memory:");
  const mailer = makeMailer({ HUB_DEV_OUTBOX: "1" }, () => undefined);
  const { server, auditLog, siem, billing } = createHub({
    db,
    mailer,
    ...(options.billing === undefined ? {} : { billing: options.billing }),
    box: makeSecretBox(Buffer.alloc(32, 3).toString("base64")),
    oauth: options.oauth ?? [],
    config: {
      publicUrl: "http://hub.test",
      devOutbox: true,
      writeLimitPerMinute: 10_000,
      loginLimitPer10Minutes: 1000,
      ...options.config,
    },
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    mailer,
    db,
    auditLog,
    siemIdle: () => siem.idle(),
    billing,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Device {
  readonly keyId: string;
  readonly signPublicKey: string;
  readonly boxPublicKey: string;
  readonly privateKey: KeyObject;
}

export function newDevice(): Device {
  const signing = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  const signPublicKey = signing.publicKey.export({ format: "jwk" }).x!;
  return {
    keyId: keyIdOf(signPublicKey),
    signPublicKey,
    boxPublicKey: box.publicKey.export({ format: "jwk" }).x!,
    privateKey: signing.privateKey,
  };
}

export interface Person {
  token: string;
  readonly email: string;
  readonly device: Device;
  userId: string;
  totpSecret: string | null;
  lastStep: number;
}

export function makeClient(hub: Hub) {
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: (text === "" ? null : JSON.parse(text)) as any, headers: response.headers };
  };

  const lastMail = (email: string) => hub.mailer.outbox!.get(email)?.at(-1);

  const signIn = async (email: string, device = newDevice()): Promise<Person> => {
    assert.equal((await call(null, "POST", "/v1/auth/start", { email })).status, 200);
    const code = /: (\d{6})$/.exec(lastMail(email)!.subject)![1];
    const verified = await call(null, "POST", "/v1/auth/verify", { email, code, label: `test ${email}` });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    const registered = await call(verified.json.token, "POST", "/v1/me/device", {
      signPublicKey: device.signPublicKey,
      boxPublicKey: device.boxPublicKey,
      label: `device of ${email}`,
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.json));
    return { token: verified.json.token, email, device, userId: verified.json.user.id, totpSecret: null, lastStep: 0 };
  };

  /** A fresh code for this person, never reusing a step (the hub refuses replays). */
  const totpCode = (person: Person) => {
    const step = Math.max(currentStep(), person.lastStep + 1);
    person.lastStep = step;
    return totpAt(person.totpSecret!, step);
  };

  const enableTotp = async (person: Person) => {
    const setup = await call(person.token, "POST", "/v1/auth/totp/setup");
    assert.equal(setup.status, 200, JSON.stringify(setup.json));
    person.totpSecret = setup.json.secret;
    const enabled = await call(person.token, "POST", "/v1/auth/totp/enable", { code: totpCode(person) });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    return enabled.json.recoveryCodes as Array<string>;
  };

  const signRequest = (person: Person, op: string, shareId: string, input: unknown, overrides: { ts?: number; nonce?: string } = {}) => {
    const ts = overrides.ts ?? Date.now();
    const nonce = overrides.nonce ?? randomBytes(16).toString("base64url");
    const message = requestMessage({ op, shareId, userId: person.userId, keyId: person.device.keyId, ts, nonce, payload: input });
    return { keyId: person.device.keyId, ts, nonce, signature: sign(null, Buffer.from(message), person.device.privateKey).toString("base64url") };
  };

  /** POST a relay route with a signed body. */
  const relay = (person: Person, path: string, op: string, shareId: string, input: Record<string, unknown> = {}) =>
    call(person.token, "POST", path, { input, sig: signRequest(person, op, shareId, input) });

  const signStatement = (person: Person, statement: Record<string, unknown>) =>
    sign(null, Buffer.from(statementMessage(statement)), person.device.privateKey).toString("base64url");

  const certify = (signer: Person, target: { userId: string; device: Device }) =>
    sign(
      null,
      Buffer.from(
        deviceCertMessage({
          userId: target.userId,
          keyId: target.device.keyId,
          signPublicKey: target.device.signPublicKey,
          boxPublicKey: target.device.boxPublicKey,
        }),
      ),
      signer.device.privateKey,
    ).toString("base64url");

  return { call, lastMail, signIn, totpCode, enableTotp, signRequest, relay, signStatement, certify };
}

/** A fake runner: answers every request and records the frames and notices it got. */
export async function connectRunner(hub: Hub, credential: string) {
  const asked: Array<any> = [];
  const notices: Array<any> = [];
  const socket = new WebSocket(`${hub.base.replace("http", "ws")}/v1/runner`);
  await new Promise((resolve) => socket.on("open", resolve));
  socket.send(JSON.stringify({ t: "hello", credential }));
  await new Promise<void>((resolve) =>
    socket.once("message", (data) => {
      assert.equal(JSON.parse(String(data)).t, "welcome");
      resolve();
    }),
  );
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.t === "notice") notices.push(frame);
    if (frame.t !== "req") return;
    asked.push(frame);
    socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, result: { op: frame.op, threadId: frame.threadId } }));
  });
  return { asked, notices, close: () => socket.close() };
}

export const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
