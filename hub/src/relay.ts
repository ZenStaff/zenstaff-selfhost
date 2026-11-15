// The relay: runners dial OUT to the hub over one WebSocket and keep it open. The hub never dials
// a runner, so a runner needs no inbound port, no public address and no VPN. Clients (a phone, a
// browser, a colleague's app) call the hub over HTTPS; the hub checks the rules in policy.ts and
// forwards one request frame to the runner, which answers on the same socket.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { Db } from "./db.ts";
import type { RequestSignature } from "./signing.ts";
import { environmentForCredential, touchEnvironment } from "./store.ts";
import { isCompanySuspended, isUserSuspended } from "./storeAdmin.ts";

/** v2: requests carry the asking device's signature and key (and may be end-to-end encrypted). */
export const RELAY_PROTOCOL_VERSION = 2;
const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Hub -> runner. `actor` is who asked, as the hub authenticated them. */
export interface RelayRequest {
  readonly op: string;
  readonly shareId: string;
  readonly threadId: string;
  readonly shareKind: string;
  readonly companyId: string;
  readonly actor: { readonly userId: string; readonly email: string; readonly name: string };
  /**
   * v9: what the actor may do in this company, as the hub (source of truth for roles) computed it.
   * The runner applies it to everything the request starts: AI staff run with the permissions of
   * the person who gave them the task, never more.
   */
  readonly actorAccess?: import("./rbac.ts").Access | null;
  readonly input: unknown;
  /** The asking device's signature over op, share and input (see signing.ts). */
  readonly sig?: RequestSignature;
  readonly device?: {
    readonly userId: string;
    readonly keyId: string;
    readonly signPublicKey: string;
    readonly boxPublicKey: string;
    readonly certs: ReadonlyArray<{ signerKeyId: string; signerPublicKey: string; signature: string }>;
  };
  /** `thread.meta`: the share's comments as stored (ciphertext + author signature, or legacy text). */
  readonly comments?: ReadonlyArray<RelayComment>;
  /** `thread.meta`: the title the owner's runner sealed to itself when it shared the chat. */
  readonly titleSealed?: string | null;
}

/** A comment handed to the runner to open: the hub cannot read or forge `sealed`. */
export interface RelayComment {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly createdAt: string;
  /** Rows from before v4: plaintext the hub saw. */
  readonly legacy?: { readonly body: string; readonly messageId: string | null };
  readonly sealed?: string;
  readonly sig?: RequestSignature;
  readonly device?: NonNullable<RelayRequest["device"]>;
}

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RunnerConnection {
  readonly environmentId: string;
  readonly socket: WebSocket;
  readonly pending: Map<string, Pending>;
  alive: boolean;
}

export class Relay {
  readonly #db: Db;
  readonly #log: (line: string) => void;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  readonly #runners = new Map<string, RunnerConnection>();
  #nextId = 0;
  readonly #pingTimer: NodeJS.Timeout;

  constructor(db: Db, log: (line: string) => void) {
    this.#db = db;
    this.#log = log;
    this.#pingTimer = setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
    this.#pingTimer.unref();
  }

  isOnline(environmentId: string): boolean {
    return this.#runners.has(environmentId);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws));
  }

  #accept(ws: WebSocket) {
    // The credential comes in the first frame, not the URL, so it never lands in access logs.
    const helloTimer = setTimeout(() => ws.close(4001, "hello timeout"), HELLO_TIMEOUT_MS);
    let connection: RunnerConnection | null = null;
    ws.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        ws.close(4002, "bad frame");
        return;
      }
      if (connection === null) {
        clearTimeout(helloTimer);
        if (frame.t !== "hello" || typeof frame.credential !== "string") {
          ws.close(4003, "expected hello");
          return;
        }
        const environment = environmentForCredential(this.#db, frame.credential);
        // A machine whose owner the platform admin suspended is refused like an unknown one.
        if (environment !== null && isUserSuspended(this.#db, environment.ownerUserId)) {
          ws.send(JSON.stringify({ t: "error", error: "account suspended" }));
          ws.close(4004, "unauthorized");
          return;
        }
        if (environment === null) {
          ws.send(JSON.stringify({ t: "error", error: "unknown runner credential" }));
          ws.close(4004, "unauthorized");
          return;
        }
        const previous = this.#runners.get(environment.id);
        if (previous !== undefined) previous.socket.close(4005, "replaced by a newer connection");
        connection = { environmentId: environment.id, socket: ws, pending: new Map(), alive: true };
        this.#runners.set(environment.id, connection);
        touchEnvironment(this.#db, environment.id);
        ws.send(
          JSON.stringify({
            t: "welcome",
            environmentId: environment.id,
            protocol: RELAY_PROTOCOL_VERSION,
          }),
        );
        this.#log(`[relay] runner ${environment.id} connected`);
        return;
      }
      if (frame.t === "res" && typeof frame.id === "string") {
        const pending = connection.pending.get(frame.id);
        if (pending === undefined) return;
        connection.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(frame.result);
        else
          pending.reject(
            new RelayError(
              typeof frame.status === "number" ? frame.status : 502,
              typeof frame.error === "string" ? frame.error : "The runner refused the request.",
            ),
          );
      }
    });
    ws.on("pong", () => {
      if (connection !== null) connection.alive = true;
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (connection === null) return;
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new RelayError(503, "The runner disconnected."));
      }
      if (this.#runners.get(connection.environmentId) === connection) {
        this.#runners.delete(connection.environmentId);
        touchEnvironment(this.#db, connection.environmentId);
        this.#log(`[relay] runner ${connection.environmentId} disconnected`);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  #pingAll() {
    for (const connection of this.#runners.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  call(environmentId: string, request: RelayRequest, timeoutMs: number): Promise<unknown> {
    // A suspended company (platform admin) gets nothing from its runners.
    if (isCompanySuspended(this.#db, request.companyId)) {
      return Promise.reject(new RelayError(423, "This company is suspended. Write to the Zen Staff team."));
    }
    const connection = this.#runners.get(environmentId);
    if (connection === undefined) {
      return Promise.reject(
        new RelayError(503, "The machine that runs this chat is offline right now."),
      );
    }
    const id = `r${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new RelayError(504, "The runner did not answer in time."));
      }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      connection.socket.send(JSON.stringify({ t: "req", id, ...request }));
    });
  }

  /** Tells every connected runner that these device keys were signed out (they unpin them). */
  broadcastDeviceRevoked(userId: string, keyIds: ReadonlyArray<string>): void {
    if (keyIds.length === 0) return;
    const frame = JSON.stringify({ t: "notice", kind: "device.revoked", userId, keyIds });
    for (const connection of this.#runners.values()) connection.socket.send(frame);
  }

  /** Closes a runner's socket (its machine was removed). */
  disconnect(environmentId: string): void {
    this.#runners.get(environmentId)?.socket.close(4004, "unauthorized");
  }

  /** Fire-and-forget notice to a runner (for example: a hand-over completed). */
  notify(environmentId: string, request: RelayRequest): void {
    this.call(environmentId, request, 30_000).catch(() => undefined);
  }

  close() {
    clearInterval(this.#pingTimer);
    for (const connection of this.#runners.values()) connection.socket.close(1001, "hub stopping");
    this.#wss.close();
  }
}
