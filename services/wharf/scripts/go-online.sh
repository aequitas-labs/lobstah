#!/usr/bin/env bash
# Puts the lobstah wharf online at glass.lobstah.dev and api.lobstah.dev.
#
# Run once, at a terminal, by a maintainer who can log in to the Cloudflare
# account that owns lobstah.dev. Every step checks before it acts, so a rerun
# after a failure picks up where it stopped. It never prints a secret:
# AUTH_SECRET and TOKEN_SECRET are generated and piped straight to wrangler,
# and the GitHub client secret is read without echo and piped the same way.
# Neither existing secret is replaced, because rotating one ends every session.
#
#   services/wharf/scripts/go-online.sh
set -euo pipefail

# The Cloudflare account in wrangler.jsonc, and the resources it binds.
readonly ACCOUNT_ID="cdde311c7a0f2943ec259f0548460a85"
readonly BUCKET="lobstah-wharf-files"
readonly DATABASE="lobstah-wharf-auth"
readonly WORKER="lobstah-wharf"
readonly ZERO_ID="00000000-0000-0000-0000-000000000000"
readonly OAUTH_APPS_URL="https://github.com/organizations/aequitas-labs/settings/applications"

cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

wrangler() { npx --no-install wrangler "$@"; }
step() { printf '\n== %s\n' "$1"; }

step "1/7 Cloudflare login on account $ACCOUNT_ID"
if ! wrangler whoami 2>/dev/null | grep -q "$ACCOUNT_ID"; then
  echo "This login can't reach $ACCOUNT_ID. Log in as a user on that account."
  wrangler login
  wrangler whoami 2>/dev/null | grep -q "$ACCOUNT_ID" || { echo "Still not on $ACCOUNT_ID; stopping." >&2; exit 1; }
fi

step "2/7 R2 bucket $BUCKET"
if wrangler r2 bucket list 2>/dev/null | grep -q "name:[[:space:]]*$BUCKET\$"; then
  echo "exists"
else
  wrangler r2 bucket create "$BUCKET"
fi

step "3/7 D1 database $DATABASE"
# The database's uuid from `d1 list --json`, empty when it doesn't exist yet.
database_id() {
  wrangler d1 list --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(m?m.uuid:"")})' "$DATABASE"
}
id="$(database_id)"
if [ -z "$id" ]; then
  wrangler d1 create "$DATABASE" >/dev/null
  id="$(database_id)"
fi
[ -n "$id" ] || { echo "Could not read the $DATABASE id; stopping." >&2; exit 1; }
# Only the deployed (first) binding takes the id; env.local keeps the zero id.
node -e '
  const fs = require("fs"); const [file, zero, id] = process.argv.slice(1);
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(id)) fs.writeFileSync(file, text.replace(zero, id));
' wrangler.jsonc "$ZERO_ID" "$id"
echo "database_id $id is in wrangler.jsonc (not a secret; commit it)"

step "4/7 GitHub OAuth app client ID"
if grep -q '"GITHUB_CLIENT_ID": ""' wrangler.jsonc; then
  echo "Open $OAUTH_APPS_URL, open the \"lobstah glass\" app, and copy its Client ID."
  read -r -p "Client ID: " client_id
  [ -n "$client_id" ] || { echo "No client ID; stopping." >&2; exit 1; }
  node -e '
    const fs = require("fs"); const [file, id] = process.argv.slice(1);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\"GITHUB_CLIENT_ID\": \"\"", JSON.stringify("GITHUB_CLIENT_ID") + ": " + JSON.stringify(id)));
  ' wrangler.jsonc "$client_id"
fi
echo "client ID set"

step "5/7 Sign-in schema"
wrangler d1 migrations apply "$DATABASE" --remote

step "6/7 Secrets (values never shown)"
# The names already set on the Worker, one per line; none before it exists.
secret_names() {
  wrangler secret list --name "$WORKER" --format json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const x of JSON.parse(s))console.log(x.name)}catch{}})' || true
}
have="$(secret_names)"
for name in AUTH_SECRET TOKEN_SECRET; do
  if grep -qx "$name" <<<"$have"; then
    echo "$name: set, kept"
  else
    openssl rand -base64 48 | tr -d '\n' | wrangler secret put "$name" --name "$WORKER"
  fi
done
if grep -qx GITHUB_CLIENT_SECRET <<<"$have"; then
  echo "GITHUB_CLIENT_SECRET: set, kept"
else
  echo "On $OAUTH_APPS_URL/3952720 (\"lobstah glass\"), choose Generate a new client secret and copy it."
  read -r -s -p "Client secret (not shown): " client_secret; echo
  [ -n "$client_secret" ] || { echo "No client secret; stopping." >&2; exit 1; }
  printf '%s' "$client_secret" | wrangler secret put GITHUB_CLIENT_SECRET --name "$WORKER"
  unset client_secret
fi

step "7/7 Build and deploy"
pnpm build
wrangler deploy --dry-run >/dev/null
wrangler deploy

echo
echo "Deployed. Checking the hosts (DNS can take a minute):"
for url in https://glass.lobstah.dev/ https://api.lobstah.dev/v1/accounts/check/glass; do
  printf '%s -> %s\n' "$url" "$(curl -s -o /dev/null -w '%{http_code}' "$url" || echo unreachable)"
done
echo "Expect 200 for the glass and 401 for the API. Then sign in at https://glass.lobstah.dev"
echo "and commit wrangler.jsonc (database_id and client ID are public)."
