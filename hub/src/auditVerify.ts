// `npm run audit:verify [-- --db <hub.sqlite>] [--audit <audit.sqlite>] [--chain <companyId>]`
// Walks every chain of the audit log and checks it against the daily anchors kept in the hub's
// database. Exit code 0 = intact, 1 = broken (the first broken row is printed), 2 = cannot open.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { anchorsOf, defaultAuditPath, verifyChain } from "./auditChain.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const hubPath = option("db") ?? process.env.HUB_DB_PATH ?? "./data/hub.sqlite";
const auditPath = option("audit") ?? process.env.HUB_AUDIT_DB_PATH ?? defaultAuditPath(hubPath);
const only = option("chain");

if (!existsSync(auditPath)) {
  console.error(`No audit log at ${auditPath}.`);
  process.exit(2);
}
const audit = new DatabaseSync(auditPath, { readOnly: true });
const hub = existsSync(hubPath) ? new DatabaseSync(hubPath, { readOnly: true }) : null;
if (hub === null) console.warn(`warning: no hub database at ${hubPath}; checking the chains without their anchors.`);
const anchors = hub === null ? [] : anchorsOf(hub);
const chains =
  only !== undefined
    ? [only]
    : (audit.prepare("SELECT DISTINCT chain FROM audit_events ORDER BY chain").all() as Array<{ chain: string }>).map((row) => row.chain);

let broken = 0;
for (const chain of chains) {
  const result = verifyChain(audit, chain, anchors);
  if (result.ok) {
    console.log(`ok      ${chain}: ${result.checked} events, head ${result.head ?? "-"}`);
  } else {
    broken += 1;
    console.log(`BROKEN  ${chain}: at event ${result.brokenAt} (${result.reason}); ${result.checked} events before it are intact`);
  }
}
// An anchored chain that has no rows at all was emptied.
for (const chain of new Set(anchors.map((anchor) => anchor.chain))) {
  if (!chains.includes(chain) && (only === undefined || only === chain)) {
    broken += 1;
    console.log(`BROKEN  ${chain}: anchored but has no events`);
  }
}
console.log(broken === 0 ? `audit log intact (${chains.length} chains, ${anchors.length} anchors)` : `${broken} chain(s) broken`);
process.exit(broken === 0 ? 0 : 1);
