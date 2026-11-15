#!/usr/bin/env bash
# Backs up the hub and the company memory into backups/<date-time>/ (run it from cron, e.g. nightly):
#   - hub.sqlite + audit.sqlite      online copies (SQLite .backup), the hub keeps running
#   - memory *.sqlite3               online copies (companies, keys wrapped by ZM_MASTER_KEYS, audit)
#   - neo4j.dump                     offline dump: Neo4j stops for the dump (usually under a minute)
# Secrets are NOT in the backup: keep .env (or at least HUB_SECRET_KEY and ZM_MASTER_KEYS) elsewhere.
# Copy the folder off this server (another disk, S3, a NAS); KEEP_DAYS old folders are removed.
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP_DAYS="${KEEP_DAYS:-14}"
dest="backups/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$dest"; chmod 700 backups "$dest"
dc() { docker compose "$@"; }
sqlite_copy() { # service, file in the container, name in the backup
  dc exec -T "$1" sh -c "command -v sqlite3 >/dev/null" 2>/dev/null && {
    dc exec -T "$1" sqlite3 "$2" ".backup /tmp/zs-backup" && dc cp "$1:/tmp/zs-backup" "$dest/$3" && dc exec -T "$1" rm -f /tmp/zs-backup
    return; }
  # No sqlite3 in the image: use the language runtime's own online-backup API.
  case "$1" in
    hub) dc exec -T hub node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"VACUUM INTO '/tmp/zs-backup'\")" "$2" ;;
    memory) dc exec -T memory python -c "import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect('/tmp/zs-backup');s.backup(d);d.close()" "$2" ;;
  esac
  dc cp "$1:/tmp/zs-backup" "$dest/$3"; dc exec -T "$1" rm -f /tmp/zs-backup
}
sqlite_copy hub /data/hub.sqlite hub.sqlite
sqlite_copy hub /data/audit.sqlite hub-audit.sqlite
for f in zen-memory.sqlite3 keys.sqlite3 audit.sqlite3; do
  if dc exec -T memory test -f "/data/$f"; then sqlite_copy memory "/data/$f" "memory-$f"; fi
done
# Neo4j community edition dumps only a stopped database.
project="$(dc config --format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')"
dc stop memory neo4j >/dev/null
trap 'dc start neo4j memory >/dev/null' EXIT
# The image dumps as its own neo4j user, so it gets a folder it may write to.
dumpdir="$PWD/$dest/.neo4j-dump"; mkdir -m 777 "$dumpdir"
docker run --rm -v "${project}_neo4j-data:/data" -v "$dumpdir:/backup" "$(dc config --images neo4j | head -1)" \
  neo4j-admin database dump neo4j --to-path=/backup >/dev/null
mv "$dumpdir/neo4j.dump" "$dest/neo4j.dump"; rmdir "$dumpdir"
dc start neo4j memory >/dev/null; trap - EXIT
chmod 600 "$dest"/*
( cd "$dest" && sha256sum * > SHA256SUMS )
find backups -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +
echo "Backup written to $dest"
