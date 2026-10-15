# PR evidence

Shared orphan branch `pr-evidence` for lobstah screenshots and evidence: one
`pr-<number>/` folder per PR. Upload with `scripts/pr-assets.sh <pr> <files...>`
from a source checkout and embed its commit-pinned raw links in the PR body.

Append commits; fetch, rebase and retry on push races. Never force-push, delete,
or merge this branch into source branches or main. Existing `pr-assets/<n>`
branches remain untouched so their old links keep working.
