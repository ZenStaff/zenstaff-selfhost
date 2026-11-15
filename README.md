# Zen Staff self-host

The team side of [Zen Staff](https://zenstaff.app) on your own server, free for your own company:
the **hub** (accounts, companies and members, invitations, shared chats, approvals, AI staff, the
relay between your people and your company's runner) and **company memory** (what your team
decided, promised and learned, searchable by every colleague's agents).

The Zen Staff desktop app is separate and open source (MIT): download it from
[zenstaff.app/descarca](https://zenstaff.app/descarca) or build it from
[ZenStaff/zenstaff](https://github.com/ZenStaff/zenstaff).

Agents never run on this server, and no AI account or chat transcript is stored here: agents run in
the Zen Staff app on your people's computers (or on an always-on runner of yours) with your own AI
accounts. Memory receives one short summary per finished conversation.

## What runs

| Service  | What it is                                         | Listens on (default)          |
| -------- | -------------------------------------------------- | ----------------------------- |
| `hub`    | Node.js, one SQLite file                           | 127.0.0.1:8787                |
| `memory` | Python API (FastAPI + Graphiti), SQLite for its own records | 127.0.0.1:8740       |
| `neo4j`  | Neo4j 5 Community, the memory graph               | internal only                 |
| `embedder` (profile `local-embedder`) | Local embedding model (TEI + Qwen3-Embedding-0.6B) | internal only |
| `caddy` (profile `https`) | HTTPS with automatic certificates          | 80, 443                       |

## Requirements

- A Linux server (x86-64 or arm64) with Docker Engine 24+ and the Docker Compose plugin.
- RAM: about 3 GB in use with remote embeddings, about 6.5 GB with the local embedder (so 4 GB or
  8 GB servers). 10 GB of free disk to start.
- Two host names (for example `hub.yourcompany.com` and `memory.yourcompany.com`) pointing at the
  server, if people connect from outside your network.
- An Anthropic API key for company memory (about $0.005 per conversation summary with the default
  model). The hub itself needs no AI key.

## Self-host in 15 minutes

```sh
git clone https://github.com/ZenStaff/zenstaff-selfhost.git
cd zenstaff-selfhost
cp .env.example .env
scripts/gen-secrets.sh          # fills HUB_SECRET_KEY, MEMORY_ADMIN_TOKEN, NEO4J_PASSWORD, ZM_MASTER_KEYS
nano .env                       # HUB_PUBLIC_URL, MEMORY_PUBLIC_URL, HUB_ADMIN_EMAILS, ANTHROPIC_API_KEY, e-mail
docker compose up -d --build
docker compose ps               # wait until hub, memory and neo4j are "healthy" (1-3 minutes)
```

HTTPS: either set `COMPOSE_PROFILES=https,local-embedder`, `HUB_DOMAIN`, `MEMORY_DOMAIN`
and `HUB_CLIENT_IP_HEADER=x-real-ip` in `.env` (the bundled Caddy gets the
certificates), or keep your own reverse proxy and point it at `127.0.0.1:8787` (hub) and
`127.0.0.1:8740` (memory; expose only `/v1/*`). The app refuses plain `http` hubs except on
localhost.

Every variable is documented in [`.env.example`](.env.example).

## First admin and first company

1. Open `HUB_PUBLIC_URL` in a browser and sign in with the e-mail you put in `HUB_ADMIN_EMAILS`.
   Without e-mail settings (`RESEND_API_KEY` or `HUB_SMTP_HOST`) the code is not sent; read it
   from the log: `docker compose logs hub | grep -i code`.
2. Create your company, turn on two-factor sign-in (required for owners and admins), and invite
   your colleagues.
3. In the Zen Staff app: **Team > Account > hub address** = your `HUB_PUBLIC_URL`, sign in, and
   link the company. Under the company's **Memory**, an owner presses **Activate**: the hub creates
   the company's memory space, and each colleague's app asks for its own key automatically.

## Backups

```sh
scripts/backup.sh               # writes backups/<date-time>/ (hub, memory records, Neo4j dump, SHA256SUMS)
```

Run it nightly from cron (`15 3 * * * cd /opt/zenstaff-selfhost && scripts/backup.sh`) and copy
`backups/` off the server. Neo4j stops for the dump (usually under a minute). The secrets are not
in the backup on purpose: keep `HUB_SECRET_KEY` and `ZM_MASTER_KEYS` in your password manager.
Restore: stop the stack, put the SQLite files back into the volumes (`docker compose cp`), load the
dump with `neo4j-admin database load`, start the stack with the same `.env`.

## Upgrades

```sh
scripts/backup.sh
git pull
docker compose up -d --build
```

Database migrations run by themselves when the services start. Read the release notes before a
major version. Each release of this repository names the hub and memory versions it contains.

## Security

- Only Caddy (if you use it) listens on public ports; the hub and memory bind to 127.0.0.1 and
  Neo4j and the embedder are reachable only on the internal Docker network.
- Memory encrypts the conversation text at rest with a key per company (`ENCRYPTION=required`);
  deleting a company destroys its key first.
- Both services keep a tamper-evident (hash-chained) audit log.
- Report vulnerabilities to security@zenstaff.app (see [SECURITY.md](SECURITY.md)).

## License

[Sustainable Use License 1.0](LICENSE.md) (the n8n model), licensor FORTITUDO VINCIT S.R.L.:
free to use and modify for your own company's internal business or for personal use; you may not
resell it or offer it to others as a hosted service. Hosting by us, with updates, backups and
support, is the paid Zen Staff Team plan. Third-party components keep their own licenses.

## Support

Community help: GitHub issues on this repository. Commercial support and setup ("done for you"):
support@zenstaff.app.
