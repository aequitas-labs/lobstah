# GitHub permissions

lobstah talks to GitHub in two ways. The `gh` CLI does the reads and the
worker's PR commands; `git` pushes branches. Pickup's GitHub source calls
the REST API with its own token source ([pickup.md](pickup.md#boundary)).
Each of these runs as some GitHub identity: a user (a personal access
token, or `gh auth login`), or a GitHub App installation token.

A user token with the `repo` scope can do everything below. A GitHub App
(or a fine-grained token) gets only the permissions its installation
grants. This page lists the permissions lobstah needs, what each one is
used for, and what happens when it is missing.

## App permissions

| Permission | Access | Used for | When it is missing |
| ---------- | ------ | -------- | ------------------ |
| **Checks** | read | PR watches read each PR's check results (`gh pr view --json statusCheckRollup`). `lobstah doctor` probes check runs. | GitHub answers "Resource not accessible by integration". The watch still records the PR state (open, merged, closed, review decision, merge state) and marks its checks `unknown (no permission)`. A PR with unknown checks is never `ready`. The watch reports the error (see below) and backs off. Failed checks do not fork CI-fix continuations, because the watch cannot see them. |
| **Pull requests** | read and write | Read: PR watches read the PR itself. Write: workers open PRs (`gh pr create`); pickup comments on PRs and, when the merge loop is on, updates branches and merges. | Read missing: the PR view fails, even without check results. The watch error says "fails even without check results". Write missing: a worker cannot open its PR and reports the error; pickup comments and merges fail. |
| **Contents** | read and write | Read: doctor and the merge loop read commits. Write: workers push their branches; the merge loop merges. | Read missing: GitHub hides the repo's code. Write missing: `git push` fails, so a worker cannot deliver its branch. |
| **Metadata** | read | Every repo call. GitHub grants it to every App. | Nothing works for that repo. |
| **Issues** | read and write | Only when tracker pickup uses GitHub issues: pickup reads assigned issues, labels them, and comments status. | Pickup sees no issues, or cannot claim or comment on them. |

`Checks: read` is the permission that is easiest to forget. An App
created for pushing code usually has Contents and Pull requests, but not
Checks. Without it, every PR watch fails every cycle.

## Check what you have

`lobstah doctor` prints a `github` row and one `github <repo>` row per
configured repo with a GitHub origin:

```
github      ok    gh runs as a GitHub App installation (4 repos)
github web  warn  acme/web: pull requests readable, contents readable, checks NOT readable — checks: Resource not accessible by integration (HTTP 403) — grant the GitHub App `Checks: read`; see docs/github.md
```

The first row says which identity `gh` runs as: a user (by login) or an
App installation. The repo rows probe pull requests, contents, and check
runs on the trunk. Every probe is a read-only `GET`.

## When a PR watch fails

A failing watch keeps the reason. For each failed check lobstah:

- writes the first meaningful line of the error to the daemon log, with
  the watch key, the exit code, and a remedy:

  ```
  pr:acme/web#12 check failed: Resource not accessible by integration (exit 1) — grant the GitHub App `Checks: read` (or use a token with the `repo` scope); see docs/github.md
  ```

- fills the `error` column of the watches table in `lobstah man tend`
  and `lobstah watch`, and the watch in the glass, with the reason and
  the time the failure streak began.
- posts one `watch-failing` notice at the third consecutive failure, and
  one `watch-recovered` notice when the watch next succeeds.
- backs off when the cause will not fix itself (a missing permission, no
  access to the repo, bad or expired credentials, a rate limit): the poll
  interval doubles with each consecutive failure, up to one hour. Other
  errors retry at the normal interval.

The classified causes and their remedies:

| Cause | Typical error | Remedy |
| ----- | ------------- | ------ |
| Checks permission missing | `Resource not accessible by integration` | Grant the App `Checks: read`. |
| PR permission missing | `Resource not accessible by integration (fails even without check results)` | Grant the App `Pull requests: read` and `Contents: read`. |
| Repo not found or no access | `Could not resolve to a Repository`, `HTTP 404` | Check the repo name, and install the App on the repo (or use a token that can see it). |
| Bad or expired credentials | `HTTP 401: Bad credentials`, `gh auth login` | Run `gh auth status`; log in again or refresh the token. |
| Rate limit | `API rate limit exceeded` | Wait for the reset (`gh api rate_limit`). The watch backs off. |
| `gh` missing | `spawnSync gh ENOENT` | Install the GitHub CLI and put it on the daemon's `PATH`. |

Any other error is shown as GitHub printed it.
