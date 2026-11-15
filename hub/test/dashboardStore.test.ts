// The dashboard's series (storeDashboard.trend): 30 days of counts, oldest first, built only from
// what the hub keeps (runner request counts, memberships, device approval alerts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDb } from "../src/db.ts";
import * as dashboard from "../src/storeDashboard.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

function seeded() {
  const db = openDb(":memory:");
  const at = (n: number) => new Date(NOW - n * DAY).toISOString();
  for (const [id, n] of [["u1", 40], ["u2", 10], ["u3", 0]] as const) db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(id, `${id}@acme.test`, id, at(n));
  db.prepare("INSERT INTO companies (id, name, created_by, created_at) VALUES ('c1', 'Acme', 'u1', ?)").run(at(40));
  for (const [id, n, role] of [["u1", 40, "owner"], ["u2", 10, "member"], ["u3", 0, "member"]] as const) db.prepare("INSERT INTO memberships (company_id, user_id, role, created_at) VALUES ('c1', ?, ?, ?)").run(id, role, at(n));
  const call = (n: number, op: string, count: number) => db.prepare("INSERT INTO company_runner_calls (company_id, day, op, count) VALUES ('c1', ?, ?, ?)").run(day(n), op, count);
  call(0, "staff.task", 3);
  call(5, "staff.task", 7);
  call(5, "staff.list", 9);
  call(29, "staff.run", 2);
  call(30, "staff.task", 100);
  db.prepare("INSERT INTO environments (id, owner_user_id, name, credential_hash, created_at) VALUES ('e1', 'u1', 'Birou', 'x', ?)").run(at(40));
  const alert = (key: string, user: string, n: number) => db.prepare("INSERT INTO device_approval_alerts (environment_id, key_id, user_id, company_id, created_at) VALUES ('e1', ?, ?, 'c1', ?)").run(key, user, NOW - n * DAY);
  alert("k1", "u2", 2);
  alert("k2", "u3", 2);
  alert("k3", "u3", 31);
  return db;
}

describe("dashboard trend", () => {
  it("counts 30 days of AI staff requests per day, without staff.list and without older days", () => {
    const trend = dashboard.trend(seeded(), "c1", null, NOW);
    const days = trend.activity.days;
    assert.equal(days.length, 30);
    assert.equal(days[0]!.day, day(29));
    assert.equal(days.at(-1)!.day, day(0));
    assert.equal(days.at(-1)!.tasks, 3);
    assert.equal(days.find((entry) => entry.day === day(5))!.tasks, 7, "staff.list is not a task");
    assert.equal(days[0]!.tasks, 2, "staff.run counts");
    assert.equal(trend.activity.staffTasks, 12, "the day 30 days ago is outside the range");
    assert.equal(trend.activity.staffLists, 9);
  });

  it("members are a running total by the day they joined", () => {
    const { members } = dashboard.trend(seeded(), "c1", null, NOW);
    assert.equal(members[0]!.total, 1);
    assert.equal(members.find((entry) => entry.day === day(10))!.total, 2);
    assert.equal(members.at(-1)!.total, 3);
  });

  it("approval alerts per day, all of the company for managers, only their own for others", () => {
    const db = seeded();
    const all = dashboard.trend(db, "c1", null, NOW).approvals;
    assert.equal(all.find((entry) => entry.day === day(2))!.n, 2);
    assert.equal(all.reduce((sum, entry) => sum + entry.n, 0), 2, "the alert from 31 days ago is outside");
    const mine = dashboard.trend(db, "c1", "u2", NOW).approvals;
    assert.equal(mine.reduce((sum, entry) => sum + entry.n, 0), 1);
  });

  it("the week is the same computation over 7 days", () => {
    const week = dashboard.weekActivity(seeded(), "c1", NOW);
    assert.equal(week.days.length, 7);
    assert.equal(week.staffTasks, 10);
  });
});
