Changes to one harness plugin require an equivalent change to the other in the same PR.

## PR evidence

Put screenshots and other evidence on the shared orphan branch `pr-evidence`, in
`pr-<number>/` (one folder per PR), never in a PR's source branch or `main`.
Run `scripts/pr-assets.sh <pr> <files...>` to upload and print commit-pinned links:

```markdown
![Alt](https://raw.githubusercontent.com/aequitas-labs/lobstah/<commit>/pr-<n>/<file>.png)
```

Use those links in the PR body. If another upload wins a push race, fetch,
rebase onto `origin/pr-evidence` and retry; never force-push or delete this branch.
The helper does this automatically and leaves your checkout alone. Existing
`pr-assets/<n>` branches and old commit-pinned links stay as they are.
