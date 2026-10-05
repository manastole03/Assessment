#!/usr/bin/env bash
# Make sure the local env files exist and hold every secret the stack needs.
#
#   ./.env          read by docker compose (and the engine). Missing keys are APPENDED with random
#                   values; existing lines are never changed, and no value is ever printed.
#   backend/.env    the backend outside Docker (`npm run start:dev`). Created once from
#                   backend/.env.example, wired to the same secrets and the compose Postgres.
#
# Safe to run repeatedly. Both files are git-ignored.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_ENV=.env
BACKEND_ENV=backend/.env

random_secret() { openssl rand -base64 "${1:-48}" | tr '+/' '-_' | tr -d '=\n'; }
has_key() { [ -f "$2" ] && grep -qE "^$1=" "$2"; }
get_key() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2-; }

[ -f "$ROOT_ENV" ] || cp .env.example "$ROOT_ENV"

added=()
ensure() { # key value
  if ! has_key "$1" "$ROOT_ENV"; then
    [ -n "$(tail -c1 "$ROOT_ENV")" ] && echo >> "$ROOT_ENV"
    printf '%s=%s\n' "$1" "$2" >> "$ROOT_ENV"
    added+=("$1")
  fi
}

ensure POSTGRES_PASSWORD "$(random_secret 24)"
ensure JWT_SECRET "$(random_secret 48)"
ensure ENGINE_TOKEN "$(random_secret 32)"
ensure SEED_ADMIN_PASSWORD "$(random_secret 18)"
ensure SEED_DEMO_PASSWORD "$(random_secret 18)"

if [ ${#added[@]} -gt 0 ]; then
  echo "Added to $ROOT_ENV: ${added[*]}"
else
  echo "$ROOT_ENV already has every required secret."
fi

if [ ! -f "$BACKEND_ENV" ]; then
  pg_port=$(get_key POSTGRES_HOST_PORT "$ROOT_ENV" 2>/dev/null || true)
  pg_user=$(get_key POSTGRES_USER "$ROOT_ENV" 2>/dev/null || true)
  pg_db=$(get_key POSTGRES_DB "$ROOT_ENV" 2>/dev/null || true)
  db_url="postgresql://${pg_user:-rote}:$(get_key POSTGRES_PASSWORD "$ROOT_ENV")@localhost:${pg_port:-5433}/${pg_db:-rote}?schema=public"
  # Every value the template leaves blank is filled from ./.env, so both setups share one set of secrets.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      DATABASE_URL=) echo "DATABASE_URL=$db_url" ;;
      JWT_SECRET=) echo "JWT_SECRET=$(get_key JWT_SECRET "$ROOT_ENV")" ;;
      ENGINE_TOKEN=) echo "ENGINE_TOKEN=$(get_key ENGINE_TOKEN "$ROOT_ENV")" ;;
      SEED_ADMIN_PASSWORD=) echo "SEED_ADMIN_PASSWORD=$(get_key SEED_ADMIN_PASSWORD "$ROOT_ENV")" ;;
      SEED_DEMO_PASSWORD=) echo "SEED_DEMO_PASSWORD=$(get_key SEED_DEMO_PASSWORD "$ROOT_ENV")" ;;
      *) echo "$line" ;;
    esac
  done < backend/.env.example > "$BACKEND_ENV"
  echo "Created $BACKEND_ENV (shares the secrets in $ROOT_ENV)."
fi

echo "Sign in as \$SEED_ADMIN_EMAIL (default admin@rote.local) with the SEED_ADMIN_PASSWORD from $ROOT_ENV."
