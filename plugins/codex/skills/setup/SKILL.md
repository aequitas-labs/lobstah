---
name: setup
description: Install and set up lobstah with the person — check prerequisites, install the CLI, scan their repos, tune the config together, run the doctor, install the daemon, add the plugin, and report what is left. Use when the user asks to set up, install, configure or tune lobstah, or to add repos to it.
---

# Set up lobstah

Invoke `$lobstah:setup` to load this skill.

Follow the setup guide, <https://lobstah.dev/setup.md> (in the repo:
`apps/site/setup.md`). It has the exact commands, what each prints when it
worked, and what to do when it did not. This skill keeps its order and its
stops; read the guide for everything else. Skip a step that is already done.

1. **Check** node, git, and a signed-in worker harness (guide step 1).
2. **Install** the CLI if `lobstah version` prints nothing (step 2).
3. **Scan** the folder the person names: `lobstah init --scan <full path>`,
   then `lobstah repos` (step 3).
4. **Read and tune** `~/.lobstah/config.toml` with the person: check repo
   keys, trunks and the worker harness, then ask each question in "Tune it
   with the person", one at a time. Write only what they change (step 3).
5. **Doctor**: run `lobstah doctor` and read every row, not the exit status
   (step 4).
6. **Daemon**: ask first, then `lobstah daemon install` (step 5).
7. **Plugin** (guide step 6). This skill runs from the Codex plugin, so it
   is installed. Its hooks must be trusted in `/hooks` — **the person's
   step**; `lobstah doctor`'s `hooks codex` row says `trusted` once done.
   Add the Claude Code plugin only if the person also talks to Claude Code.
8. **Report** what is done and what is left (step 7).

Stop and hand these to the person; never do them yourself:

- signing in to Claude Code, Codex or `gh`;
- choosing the repos: ask for the folder, do not guess it or scan the home
  folder;
- installing the daemon's service, until they say yes;
- trusting hooks in Codex;
- anything that needs `sudo`;
- taking the helm from a session that holds it.

When the doctor shows no `fail` row and the daemon runs, the person can type
`$lobstah:man` in a new session to take the helm.
