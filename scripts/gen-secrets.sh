#!/usr/bin/env bash
# Fills the empty secrets in .env with new random values (never overwrites one that is set):
# HUB_SECRET_KEY, MEMORY_ADMIN_TOKEN, NEO4J_PASSWORD, ZM_MASTER_KEYS (+ ZM_MASTER_KEY_ID).
# Copy HUB_SECRET_KEY and ZM_MASTER_KEYS to your password manager: without them the encrypted
# two-factor secrets and the encrypted memory text in a backup cannot be read.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
chmod 600 .env
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
fill() {
  local name="$1" value="$2"
  if grep -qE "^${name}=.+" .env; then echo "  ${name}: already set, kept"; return; fi
  if grep -qE "^${name}=" .env; then
    local tmp; tmp="$(mktemp)"; chmod 600 "$tmp"
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n && done!=1 {print n "=" v; done=1; next} {print}' .env > "$tmp"
    cat "$tmp" > .env; rm -f "$tmp"
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
  echo "  ${name}: generated"
}
key_id="k$(openssl rand -hex 3)"
fill HUB_SECRET_KEY "$(openssl rand -base64 32)"
fill MEMORY_ADMIN_TOKEN "$(openssl rand -hex 32)"
fill NEO4J_PASSWORD "$(openssl rand -hex 24)"
if ! grep -qE "^ZM_MASTER_KEYS=.+" .env; then
  fill ZM_MASTER_KEYS "${key_id}:$(openssl rand -base64 32)"
  fill ZM_MASTER_KEY_ID "$key_id"
else
  echo "  ZM_MASTER_KEYS: already set, kept"
fi
echo "Done. Now set HUB_PUBLIC_URL, MEMORY_PUBLIC_URL, HUB_ADMIN_EMAILS and ANTHROPIC_API_KEY in .env."
echo "Save HUB_SECRET_KEY and ZM_MASTER_KEYS in your password manager (not next to the backups)."
