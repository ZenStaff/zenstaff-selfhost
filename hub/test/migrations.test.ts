// Schema migrations: a fresh database gets every version in order, and a database left at v3
// (before end-to-end comments, passkeys and company objects) upgrades to the latest without losing rows.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { MIGRATIONS, openDb } from "../src/db.ts";

/** Every non-empty migration slot is recorded (an empty slot would be skipped). */
const APPLIED = MIGRATIONS.flatMap((sql, index) => (sql === null ? [] : [index + 1]));
const dir = mkdtempSync(join(tmpdir(), "zen-hub-migrations-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const versions = (db: DatabaseSync) =>
  (db.prepare("SELECT version FROM hub_migrations ORDER BY version").all() as Array<{ version: number }>).map(
    (row) => row.version,
  );
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );

describe("migrations", () => {
  it("are numbered 1..18 with hosted memory at v13, client approval links at v14, the platform admin at v15, personal memory at v17 and growth at v18 (v10-v12, v16 reserved)", () => {
    assert.equal(MIGRATIONS.length, 18);
    assert.match(MIGRATIONS[17] ?? "", /CREATE TABLE growth_optouts/);
    assert.equal(MIGRATIONS[15], null);
    assert.match(MIGRATIONS[16] ?? "", /CREATE TABLE user_memory_keys/);
    assert.deepEqual([MIGRATIONS[9], MIGRATIONS[10]], [null, null]);
    assert.match(MIGRATIONS[11] ?? "", /CREATE TABLE billing_accounts/);
    assert.match(MIGRATIONS[12] ?? "", /CREATE TABLE company_memory_keys/);
    assert.match(MIGRATIONS[13] ?? "", /CREATE TABLE client_approvals/);
    assert.match(MIGRATIONS[14] ?? "", /CREATE TABLE platform_subscriptions/);
    assert.match(MIGRATIONS[7] ?? "", /CREATE TABLE library_versions/);
    assert.match(MIGRATIONS[8] ?? "", /CREATE TABLE company_roles/);
    assert.match(MIGRATIONS[8] ?? "", /CREATE TABLE environment_runners/);
    assert.match(MIGRATIONS[6] ?? "", /CREATE TABLE company_runner_calls/);
    assert.match(MIGRATIONS[5] ?? "", /CREATE TABLE company_staff/);
    assert.match(MIGRATIONS[3] ?? "", /device_approval_alerts/);
    assert.match(MIGRATIONS[4] ?? "", /CREATE TABLE passkeys/);
  });

  it("apply every version on a fresh database", () => {
    const db = openDb(join(dir, "fresh.db"));
    assert.deepEqual(versions(db), APPLIED);
    assert.ok(columns(db, "comments").includes("sealed"));
    assert.ok(tables(db).includes("passkeys"));
    assert.ok(columns(db, "companies").includes("details"));
    db.close();
  });

  it("upgrade a database at v3 to v8, keeping its rows, and reopen without changes", () => {
    const path = join(dir, "v3.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON;");
    old.exec("CREATE TABLE IF NOT EXISTS hub_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    MIGRATIONS.slice(0, 3).forEach((sql, index) => {
      old.exec(sql!);
      old.prepare("INSERT INTO hub_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, "2026-10-01T00:00:00Z");
    });
    assert.ok(!tables(old).includes("passkeys"));
    assert.ok(!columns(old, "comments").includes("sealed"));
    old.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
      "u1",
      "ana@example.com",
      "Ana",
      "2026-10-01T00:00:00Z",
    );
    old.close();

    const db = openDb(path);
    assert.deepEqual(versions(db), APPLIED);
    for (const column of ["sealed", "sig", "device_key_id"]) assert.ok(columns(db, "comments").includes(column));
    assert.ok(columns(db, "shares").includes("title_sealed"));
    assert.ok(columns(db, "notifications").includes("actor_user_id"));
    for (const table of ["device_approval_alerts", "passkeys", "passkey_users", "passkey_ceremonies", "company_staff", "company_packs", "company_pack_status"]) {
      assert.ok(tables(db).includes(table), table);
    }
    assert.deepEqual(
      { ...(db.prepare("SELECT email FROM users WHERE id = 'u1'").get() as object) },
      { email: "ana@example.com" },
    );
    db.close();

    const again = openDb(path);
    assert.deepEqual(versions(again), APPLIED);
    again.close();
  });

  it("v9 moves each machine's runner company and AI account to environment_runners", () => {
    const path = join(dir, "v7.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON;");
    old.exec("CREATE TABLE IF NOT EXISTS hub_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    MIGRATIONS.slice(0, 7).forEach((sql, index) => {
      old.exec(sql!);
      old.prepare("INSERT INTO hub_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, "2026-11-01T00:00:00Z");
    });
    old.exec(`
      INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'alex@example.com', 'Alex', '2026-11-01');
      INSERT INTO companies (id, name, created_by, created_at) VALUES ('c1', 'Bistro Ana', 'u1', '2026-11-01');
      INSERT INTO memberships (company_id, user_id, role, created_at) VALUES ('c1', 'u1', 'owner', '2026-11-01');
      INSERT INTO environments (id, owner_user_id, name, credential_hash, runner_company_id, created_at, ai_account)
        VALUES ('e1', 'u1', 'srv-birou', 'h1', 'c1', '2026-11-01', '{"provider":"claude","mode":"seat","label":"Team seat"}');
      INSERT INTO environments (id, owner_user_id, name, credential_hash, created_at) VALUES ('e2', 'u1', 'laptop', 'h2', '2026-11-01');
    `);
    old.close();
    const db = openDb(path);
    assert.deepEqual(
      (db.prepare("SELECT environment_id, company_id, ai_account FROM environment_runners").all() as Array<object>).map((row) => ({ ...row })),
      [{ environment_id: "e1", company_id: "c1", ai_account: '{"provider":"claude","mode":"seat","label":"Team seat"}' }],
    );
    assert.deepEqual({ ...(db.prepare("SELECT runner_company_id, ai_account FROM environments WHERE id = 'e1'").get() as object) }, { runner_company_id: null, ai_account: null });
    assert.ok(columns(db, "memberships").includes("custom_role_id"));
    for (const table of ["company_roles", "company_teams", "company_projects", "member_scoped_roles", "audit_anchors", "company_siem"]) assert.ok(tables(db).includes(table), table);
    db.close();
  });
  it("v15 keeps the library reviewers of v8 and lets hub staff be operators and support", () => {
    const path = join(dir, "v9.db");
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON;");
    old.exec("CREATE TABLE IF NOT EXISTS hub_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    MIGRATIONS.slice(0, 9).forEach((sql, index) => {
      old.exec(sql!);
      old.prepare("INSERT INTO hub_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, "2026-11-08T00:00:00Z");
    });
    old.exec(`
      INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'ana@example.com', 'Ana', '2026-11-01');
      INSERT INTO users (id, email, name, created_at) VALUES ('u2', 'ion@example.com', 'Ion', '2026-11-01');
      INSERT INTO hub_staff (user_id, role, granted_by, created_at) VALUES ('u1', 'reviewer', NULL, '2026-11-02');
    `);
    assert.throws(() => old.exec("INSERT INTO hub_staff (user_id, role, created_at) VALUES ('u2', 'operator', '2026-11-02')"));
    old.close();
    const db = openDb(path);
    assert.deepEqual({ ...(db.prepare("SELECT user_id, role, created_at FROM hub_staff").get() as object) }, { user_id: "u1", role: "reviewer", created_at: "2026-11-02" });
    db.exec("INSERT INTO hub_staff (user_id, role, created_at) VALUES ('u2', 'support', '2026-11-08')");
    assert.throws(() => db.exec("UPDATE hub_staff SET role = 'owner' WHERE user_id = 'u2'"));
    for (const column of ["suspended_at", "suspended_reason", "last_signin_at"]) assert.ok(columns(db, "users").includes(column), column);
    assert.ok(columns(db, "companies").includes("suspended_at"));
    for (const table of ["platform_subscriptions", "platform_subscription_history"]) assert.ok(tables(db).includes(table), table);
    assert.ok(!versions(db).some((version) => version >= 10 && version <= 11));
    db.close();
  });
});
