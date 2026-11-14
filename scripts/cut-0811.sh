#!/usr/bin/env bash
# Run after the 0.8.11 release preview is approved. This script cuts the
# release; it does not run as part of building or testing the repository.
set -euo pipefail

R=aequitas-labs/lobstah
N=502
TESTED=73e98ad5f45ca20a8f8c3416a8896ca62d347066

state=""
head=""
for _ in $(seq 1 60); do
  read -r state head < <(gh pr view "$N" -R "$R" --json mergeStateStatus,headRefOid --jq '"\(.mergeStateStatus) \(.headRefOid)"')
  [[ "$state" == CLEAN ]] && break
  sleep 60
done

[[ "$head" == "$TESTED" ]] || {
  echo "#$N head moved to ${head:0:12} since the preview (tested ${TESTED:0:12})" >&2
  exit 1
}
[[ "$state" == CLEAN ]] || {
  echo "#$N is not green after 60 minutes ($state)" >&2
  exit 1
}

gh pr merge "$N" -R "$R" --merge --match-head-commit "$TESTED" >/dev/null || {
  echo "merge refused" >&2
  exit 1
}
merge_sha=$(gh pr view "$N" -R "$R" --json mergeCommit --jq .mergeCommit.oid)
echo "#$N merged at $merge_sha"

for tag in v0.8.11 plugin-v0.8.11; do
  if current=$(gh api "repos/$R/git/ref/tags/$tag" --jq '.object.sha // empty' 2>/dev/null); then
    [[ "$current" == "$merge_sha" ]] || {
      echo "tag $tag already points to $current, expected $merge_sha" >&2
      exit 1
    }
  else
    gh api "repos/$R/git/refs" -f "ref=refs/tags/$tag" -f "sha=$merge_sha" >/dev/null
  fi
done

for package in lobstah lobstah-openclaw-plugin; do
  published=""
  for _ in $(seq 1 30); do
    published=$(npm view "$package" version 2>/dev/null || true)
    [[ "$published" == 0.8.11 ]] && break
    sleep 30
  done
  [[ "$published" == 0.8.11 ]] || {
    echo "npm still reports ${published:-unavailable} for $package after 15 minutes" >&2
    exit 1
  }
  echo "npm $package@$published is live"
done
for tag in v0.8.11 plugin-v0.8.11; do
  sha=$(gh api "repos/$R/git/ref/tags/$tag" --jq '.object.sha // empty')
  [[ "$sha" == "$merge_sha" ]] || { echo "tag $tag moved to $sha" >&2; exit 1; }
  echo "$tag $sha"
done
