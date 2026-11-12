#!/bin/bash
# Deploy the wharf (glass.lobstah.dev, api.lobstah.dev) from origin/main.
#
#   services/wharf/scripts/deploy-from-main.sh                        code, and any pending migrations
#   services/wharf/scripts/deploy-from-main.sh --set-var SLACK_CLIENT_ID   also set a Worker var, read from stdin
#
# As a glass run card: lobstah man ask --run services/wharf/scripts/deploy-from-main.sh
#   --interactive --cwd ~ --timeout 20m (add --input SLACK_CLIENT_ID:secret with --set-var).
#
# - It deploys origin/main from its own detached checkout under /tmp, and
#   leaves it there so the rollback command it prints runs from it.
# - Wrangler uses its own stored login (`npx wrangler login`). No token here.
# - Order: read the live version and the pending D1 migrations (read-only; a
#   failed check stops the run), apply pending migrations (wrangler asks to
#   confirm), deploy, then check health. It ends with the rollback command and
#   exits non-zero when a health check fails.
# - A var named by --set-var is read from stdin, never echoed or written to a
#   file, and set with wrangler's --var on this deploy; keep_vars keeps it.
set -euo pipefail
export FORCE_COLOR=0 NO_COLOR=1 CI=1

SET_VAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --set-var)
      SET_VAR="${2:-}"
      shift 2 || true
      ;;
    *)
      echo "Unknown argument: $1. Usage: deploy-from-main.sh [--set-var NAME]"
      exit 2
      ;;
  esac
done
VALUE=""
if [ -n "$SET_VAR" ]; then
  if ! [[ "$SET_VAR" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]]; then
    echo "--set-var takes a variable name such as SLACK_CLIENT_ID. Nothing changed."
    exit 2
  fi
  IFS= read -r VALUE || true
  if [ -z "$VALUE" ]; then
    echo "No value for $SET_VAR on stdin. Nothing changed."
    exit 1
  fi
fi

DB="lobstah-wharf-auth"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
git -C "$REPO" fetch -q origin
SHA=$(git -C "$REPO" rev-parse origin/main)
DIR="/tmp/lobstah-wharf-deploy-${SHA:0:8}"
if [ ! -d "$DIR" ]; then git -C "$REPO" worktree add -q --detach "$DIR" "$SHA"; fi
cd "$DIR"
echo "== Deploying main at ${SHA:0:12} from $DIR"

# A var listed in the config, even empty, overrides the Worker's own on every deploy.
if ! node -e '
  const text = require("fs").readFileSync("services/wharf/wrangler.jsonc", "utf8");
  process.exit(/"SLACK_CLIENT_ID"\s*:/.test(text.split(/"env"\s*:/)[0]) ? 1 : 0);
'; then
  echo "wrangler.jsonc lists SLACK_CLIENT_ID, so this deploy would blank it on the Worker. Nothing changed."
  exit 1
fi

echo "== Installing and building"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter "@lobstah/wharf^..." run build >/dev/null
cd services/wharf

# Every wrangler call names the account the config pins, so none has to choose one non-interactively.
CLOUDFLARE_ACCOUNT_ID=$(node -e '
  const text = require("fs").readFileSync("wrangler.jsonc", "utf8");
  const m = /"account_id"\s*:\s*"([0-9a-f]{32})"/.exec(text);
  process.stdout.write(m ? m[1] : "");
')
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "wrangler.jsonc pins no account_id. Nothing changed."
  exit 1
fi
export CLOUDFLARE_ACCOUNT_ID

echo "== Checking the Cloudflare login"
if npx --no-install wrangler whoami 2>&1 | grep -qi "not authenticated"; then
  echo "Wrangler isn't logged in. Run: cd $DIR/services/wharf && npx wrangler login. Then run this again. Nothing changed."
  exit 1
fi

# The D1 id goes only into the git-ignored local file, never on screen.
if [ ! -f wrangler.local.jsonc ]; then
  if [ -f "$HERE/wrangler.local.jsonc" ]; then
    cp "$HERE/wrangler.local.jsonc" wrangler.local.jsonc
  else
    npx --no-install wrangler d1 list --json 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
        const list = JSON.parse(s.slice(s.indexOf("[")));
        const db = list.find((d) => d.name === process.argv[1]);
        if (!db) { console.error("No D1 database named " + process.argv[1] + " on this account."); process.exit(1); }
        require("fs").writeFileSync("wrangler.local.jsonc", JSON.stringify({ database_id: db.uuid }) + "\n", { mode: 0o600 });
      });
    ' "$DB"
  fi
fi

live_version() {
  pnpm -s run wrangler deployments status --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try {
        const d = JSON.parse(s.slice(s.indexOf("{")));
        const v = (d.versions ?? []).slice().sort((a, b) => b.percentage - a.percentage)[0];
        process.stdout.write(v ? v.version_id : "");
      } catch { /* No version read: the caller says so. */ }
    });
  '
}

echo "== Live now (read-only)"
BEFORE=$(live_version)
if [ -z "$BEFORE" ]; then
  echo "Couldn't read the live Worker version. Nothing changed."
  exit 1
fi
echo "Worker version at 100%: $BEFORE"

echo "== Pending migrations on $DB (read-only)"
if ! PENDING=$(pnpm -s run wrangler d1 migrations list "$DB" --remote 2>&1); then
  echo "$PENDING"
  echo "Couldn't list the pending migrations. Nothing changed."
  exit 1
fi
echo "$PENDING"
NAMES=""
for f in migrations/*.sql; do
  name=$(basename "$f")
  if grep -qF "$name" <<<"$PENDING"; then NAMES="$NAMES $name"; fi
done

if [ -n "$NAMES" ]; then
  echo "== Applying migrations:$NAMES (wrangler asks to confirm: answer y)"
  env -u CI pnpm -s run wrangler d1 migrations apply "$DB" --remote
else
  echo "No migrations to apply."
fi

echo "== Deploying"
pnpm -s run build >/dev/null
if [ -n "$SET_VAR" ]; then
  node scripts/wrangler-local.mjs deploy --message "main ${SHA:0:12}" --var "$SET_VAR:$VALUE"
else
  node scripts/wrangler-local.mjs deploy --message "main ${SHA:0:12}"
fi
VALUE=""

echo "== Health"
AFTER=$(live_version)
GLASS=$(curl -s -o /dev/null -w '%{http_code}' https://glass.lobstah.dev/)
API=$(curl -s -o /dev/null -w '%{http_code}' https://api.lobstah.dev/v1/auth/session)
echo "Worker version at 100%: ${AFTER:-unknown} (was $BEFORE)"
echo "glass.lobstah.dev: $GLASS (want 200)"
echo "api.lobstah.dev with no token: $API (want 401)"

echo "== Rollback, if needed"
echo "cd $DIR/services/wharf && pnpm run wrangler rollback $BEFORE --yes"
echo "When you no longer need it: git -C $REPO worktree remove --force $DIR"

if [ "$GLASS" = 200 ] && [ "$API" = 401 ] && [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
  echo "Deployed and healthy."
else
  echo "Deployed, but a health check failed: look above, and roll back if the glass is down."
  exit 1
fi
