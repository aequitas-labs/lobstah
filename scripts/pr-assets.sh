#!/usr/bin/env bash
# Publish evidence without switching or staging anything in the caller's checkout.
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# -ge 2 && $1 =~ ^[1-9][0-9]*$ ]] || die 'Usage: scripts/pr-assets.sh <pr-number> <files...>'
pr=$1
shift
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)
# Keep the declared GitHub name for links; Git still applies insteadOf on clone/push.
remote=$(git -C "$root" config --get remote.origin.url)
case "$remote" in
  https://github.com/*) repo=${remote#https://github.com/} ;;
  git@github.com:*) repo=${remote#git@github.com:} ;;
  ssh://git@github.com/*) repo=${remote#ssh://git@github.com/} ;;
  *) die 'origin must be a GitHub repository URL.' ;;
esac
repo=${repo%.git}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'Cannot read owner/repo from origin.'

names=()
for file in "$@"; do
  [[ -f $file && ! -L $file ]] || die "Not a regular file: $file"
  name=$(basename "$file")
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "Use a URL-safe filename (letters, numbers, dot, dash, underscore): $name"
  for prior in "${names[@]+${names[@]}}"; do
    [[ $prior != "$name" ]] || die "Duplicate filename: $name"
  done
  names+=("$name")
done

scratch=$(mktemp -d "${TMPDIR:-/tmp}/lobstah-pr-assets.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
git clone --quiet --single-branch --branch pr-evidence -- "$remote" "$scratch/repo"
# Honor identity configured in this checkout as well as global Git settings.
for key in user.name user.email; do
  if value=$(git -C "$root" config --get "$key"); then
    git -C "$scratch/repo" config "$key" "$value"
  fi
done
dest="pr-$pr"
[[ ! -L $scratch/repo/$dest ]] || die "Evidence directory is a symlink: $dest"
mkdir -p "$scratch/repo/$dest"
for file in "$@"; do
  name=$(basename "$file")
  [[ ! -L $scratch/repo/$dest/$name ]] || die "Evidence target is a symlink: $dest/$name"
  cp -- "$file" "$scratch/repo/$dest/$name"
  git -C "$scratch/repo" add -- "$dest/$name"
done
if ! git -C "$scratch/repo" diff --cached --quiet; then
  git -C "$scratch/repo" commit -m "PR #$pr evidence" >&2
  pushed=false
  for attempt in 1 2 3 4 5; do
    if git -C "$scratch/repo" push origin HEAD:refs/heads/pr-evidence >&2; then
      pushed=true
      break
    fi
    before=$(git -C "$scratch/repo" rev-parse origin/pr-evidence)
    git -C "$scratch/repo" fetch --quiet origin pr-evidence
    after=$(git -C "$scratch/repo" rev-parse origin/pr-evidence)
    [[ $before != "$after" ]] || die 'Push failed without a concurrent update; check origin access and protection.'
    git -C "$scratch/repo" rebase origin/pr-evidence >&2 || die 'Concurrent upload changed the same file. Resolve by choosing a new filename and rerun.'
  done
  $pushed || die 'Too many concurrent uploads; rerun the command.'
fi
commit=$(git -C "$scratch/repo" rev-parse HEAD)
for name in "${names[@]}"; do
  url="https://raw.githubusercontent.com/$repo/$commit/$dest/$name"
  case "$name" in
    *.[pP][nN][gG]|*.[jJ][pP][gG]|*.[jJ][pP][eE][gG]|*.[gG][iI][fF]|*.[wW][eE][bB][pP]|*.[sS][vV][gG]|*.[aA][vV][iI][fF]) printf '![%s](%s)\n' "$name" "$url" ;;
    *) printf '[%s](%s)\n' "$name" "$url" ;;
  esac
done
