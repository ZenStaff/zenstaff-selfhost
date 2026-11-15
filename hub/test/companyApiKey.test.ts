// Invitations do not need a company API key: colleagues work on their own computers with their own
// AI account. The key matters only for the company server (the app's server refuses colleagues'
// work without it); the hub keeps recording a server's AI account label and mode.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type Hub, makeClient, startHub } from "./harness.ts";

let hub: Hub;
let client: ReturnType<typeof makeClient>;

before(async () => {
  hub = await startHub();
  client = makeClient(hub);
});
after(() => hub.close());

describe("invitations without a company API key", () => {
  it("invites colleagues with no server and with a server on a personal subscription", async () => {
    const alex = await client.signIn("alex@key.test");
    const company = (await client.call(alex.token, "POST", "/v1/companies", { name: "Cheie SRL" })).json.id as string;
    await client.enableTotp(alex);
    const invite = () => client.call(alex.token, "POST", `/v1/companies/${company}/invites`, { role: "member" });

    // No server at all: colleagues still come in and work with their own AI account.
    const none = await invite();
    assert.equal(none.status, 200);
    const maria = await client.signIn("maria@key.test");
    assert.equal((await client.call(maria.token, "POST", "/v1/invites/accept", { token: none.json.link })).status, 200);

    // A server on the owner's own subscription does not block invitations either.
    const envId = (await client.call(alex.token, "POST", "/v1/environments", { name: "server" })).json.environmentId as string;
    assert.equal((await client.call(alex.token, "PUT", `/v1/environments/${envId}/runner`, { companyIds: [company] })).status, 200);
    const setAccount = (mode: "seat" | "api-key") =>
      client.call(alex.token, "PUT", `/v1/environments/${envId}/ai-account`, {
        companyId: company,
        account: { provider: "claude", mode, label: mode === "seat" ? "Claude Max (alex)" : "Cheia firmei" },
      });
    assert.equal((await setAccount("seat")).status, 200);
    assert.equal((await invite()).status, 200);

    // The company key is still recorded (label and mode only) for the company server.
    assert.equal((await setAccount("api-key")).status, 200);
    assert.equal((await invite()).status, 200);
    const members = (await client.call(alex.token, "GET", `/v1/companies/${company}`)).json.members as Array<{ userId: string }>;
    assert.ok(members.some((member) => member.userId === maria.userId));
  });
});
