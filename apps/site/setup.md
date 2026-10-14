# Set up lobstah: a guide for agents

You are an agent, and a person has asked you to install lobstah and set it up
for their repos. This guide gives the steps in order, the exact commands, what
each step prints when it worked, and what to do when it did not. Some steps
belong to the person. Those are marked **Ask the person** or **Leave to the
person**: stop there and say what you need.

lobstah runs coding agents in the background, each job in its own git
worktree, and wakes the person when one has a catch or a question. It has
three parts:

- the `lobstah` command-line tool, from npm;
- a daemon that supervises the work;
- a plugin for the harness the person talks to (Claude Code or Codex), or for
  an OpenClaw gateway.

The workers are always Claude Code or Codex sessions. OpenClaw is a way to
send work to them, not a third kind of worker.

## What you must leave to the person

- **Logins.** lobstah does not sign anyone in. If Claude Code, Codex or `gh`
  is not signed in, say so and stop.
- **Which repos.** Ask for the real folder. Do not guess it and do not scan
  the home folder.
- **Installing a service.** `lobstah daemon install` registers a service that
  starts with the person's login. Ask before you run it.
- **Trusting hooks in Codex.** Only the person can review and trust them, in
  `/hooks`.
- **Allowing a third-party plugin** in OpenClaw, and allowing its tools.
- **Taking the helm from a live holder.** Never pass `--take` to
  `lobstah man helm` unless the person asks you to displace the other session.
- **Anything that needs `sudo`.** If a global npm install is refused, report
  it. Do not retry with `sudo`.

## 1. Check what is already there

```bash
node --version
git --version
```

- Node must be version 20 or later.
- At least one worker harness must be installed and signed in: Claude Code
  (`claude --version`) or Codex (`codex --version`; the lobstah plugin needs
  Codex 0.114 or later).

If any of these is missing, **ask the person** before you install it.

## 2. Install the command-line tool

```bash
npm i -g lobstah
lobstah version
```

**Worked:** `lobstah version` prints a version number.

**Did not work:**

- `EACCES` or another permission error from npm: the global npm folder is not
  writable. Report it and stop. Do not use `sudo`.
- `lobstah: command not found` after a clean install: npm's global `bin`
  folder is not on `PATH`. Report the folder (`npm prefix -g`) and stop.

The plugins do not carry the tool. Their hooks run the `lobstah` on `PATH`, so
this step comes before any plugin.

## 3. Tell lobstah about the repos

**Ask the person** which folder holds their repos, or which repos they want.
Then scan that folder, by its full path:

```bash
lobstah init --scan /full/path/to/their/repos
```

The scan takes a folder that is itself a repo, or a folder whose direct
children are repos. It does not look deeper, and it skips hidden folders. You
may pass several folders.

**Worked:** the output has `initialized: true` and an `added:` line naming a
key for each repo it found. The key is the folder's name.

**Did not work:**

- No `added:` line: nothing was found. A folder that does not exist is skipped
  without an error. Check the path with the person and run it again.
- `--scan requires at least one directory`: you left the folder out.

Always pass `--scan` with a folder. Do not run `lobstah init` by itself: see
"Known problems" below.

Then check the result:

```bash
lobstah repos
```

**Worked:** one row for each repo, with `exists` true and the `trunk` the
person expects.

### Read the config file

The file is `~/.lobstah/config.toml`. Read it and check three things with the
person:

1. **Repo keys.** Each `[repos.<key>]` block is one of the repos they named,
   and none is missing.
2. **Trunk.** Each `trunk =` is that repo's main branch, not a feature branch.
3. **Worker harness.** `[harness]` has `default = "claude"`. If the person's
   workers should be Codex sessions, change it to `default = "codex"`.
   Installing the Codex plugin does not change this.

In this file, keys that stand alone (such as `notifyCommand`) must come before
the first `[section]`. A key written under a `[repos.<key>]` block belongs to
that repo.

### Known problems in `init`, and the safe path

These are faults in the tool at version 0.7.5, not how it is meant to work.
Until they are fixed, do this:

| If                                                                             | Then                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| someone ran `lobstah init` with no `--scan`                                    | The file has a made-up `[repos.example]` block, and `lobstah doctor` fails on it. Delete that block, then run the scan.                                                                                                                                                                                                                                                                     |
| two repos have the same folder name                                            | Only the first is added, and nothing says the second was skipped. Add the second under a name of its own: `lobstah repos add /full/path/to/repo --key other-name`.                                                                                                                                                                                                                          |
| a repo's folder name has a dot in it                                           | A scan writes its key wrongly, and a second scan then breaks the file. Look for such folders before you scan. If there is one, do not scan its parent: pass each of the other repos to `--scan` by its own path, and add the dotted one with a key that has no dot: `lobstah repos add /full/path/to/my.repo --key my-repo`. If it was scanned already, delete its `[repos.…]` block first. |
| a repo was on a feature branch when scanned, and its `origin/HEAD` was not set | The feature branch is written as `trunk`. Change `trunk =` in that repo's block to the real main branch.                                                                                                                                                                                                                                                                                    |
| you want issue pickup on repos that are already in the file                    | Running `lobstah init --scan <folder> --pickup` again changes nothing for them, though the output suggests it. Add `pickup = true` to each repo's block by hand.                                                                                                                                                                                                                            |
| you want notifications                                                         | Do not uncomment the `notifyCommand` example in the file: its quotes are not valid there. Write your own line above the first `[section]`, in single quotes: `notifyCommand = 'ntfy pub my-topic "$LOBSTAH_VERB $LOBSTAH_ID: $LOBSTAH_NOTE"'`.                                                                                                                                              |

## 4. Run the doctor

```bash
lobstah doctor
```

It prints a table of checks, each `ok`, `warn`, `fail` or `skip`, with a
detail.

**Exit status 0 does not mean lobstah is ready.** Only a `fail` row makes the
exit status 1. A missing harness or a stopped daemon can be a `warn`, and a
plugin that is not installed is a `skip`. Read every row.

- `config` fails: the file is missing or is not valid TOML. The detail says
  which line.
- `repo <key>` fails: its path does not exist or is not a git repo. Fix the
  block in the config file.
- `repo <key>` warns that `origin/<trunk>` was not found: the trunk is wrong,
  or the repo needs a `git fetch`.
- `harness claude` or `harness codex` warns: that harness is not on `PATH`,
  and jobs sent to it will fail.
- `daemon` warns that there is no heartbeat: expected until step 5.
- `plugin claude` or `plugin codex` reads `skip`, `not installed`: expected
  until step 6.
- A `github` row fails: `gh` is not signed in, or cannot read the repo.
  **Leave the login to the person.**

The doctor does not check that a harness is signed in, that the trunk is the
branch the person means, or that a first job runs.

## 5. Install the daemon

**Ask the person** first: this installs a service that starts when they log
in.

```bash
lobstah daemon status
lobstah daemon install
lobstah daemon status
```

On macOS this is a launchd agent, and on Linux a systemd user unit.

**Worked:** `lobstah daemon install` prints `loaded: true`, and
`lobstah daemon status` then prints `daemon: running` and `installed: true`.

**Did not work:**

- `loaded: false`: the `detail` line carries the service manager's own error.
  Report it.
- `git is not reachable on the service PATH`: the service runs with a fixed
  `PATH`, not the shell's. Report the path it printed.
- **Windows:** there is no service to install, and the command says so. Run
  `lobstah daemon` in a terminal that stays open, or under a process manager
  the person chooses.

Running `lobstah daemon install` a second time reloads the service. That is
safe.

## 6. Add the plugin for the harness

Do one of these, for the harness the person will talk to.

### Claude Code

From a shell:

```bash
claude plugin marketplace add aequitas-labs/lobstah
claude plugin install lobstah@lobstah
```

Or, typed by the person inside Claude Code: `/plugin marketplace add
aequitas-labs/lobstah`, then `/plugin install lobstah@lobstah`.

The marketplace is `aequitas-labs/lobstah`, and the plugin is
`lobstah@lobstah`. Run `lobstah doctor` again: the `plugin claude` row should
now read `ok` and say the plugin's version matches the tool's.

**A plugin added during a session is not loaded in that session.** The person
must open a new Claude Code session. In it they type:

```text
/lobstah:man
```

**Worked:** the new session signs on at the helm, prints its charter, and
gives the address of the glass, the page where the person acts on what the
fleet needs: `http://127.0.0.1:4949` unless another port is set.

**Did not work:**

- `/lobstah:man` is not known: the session is older than the plugin. Open a
  new one.
- Sign-on is refused because another session holds the helm: say who holds
  it and stop. **Leave the choice to the person.**

If you are the session that just installed the plugin, you cannot take the
helm yourself. Tell the person to open a new session and type `/lobstah:man`.

### Codex

From a shell:

```bash
codex plugin marketplace add aequitas-labs/lobstah
codex plugin add lobstah@lobstah
```

Then two steps that are the person's:

1. **Leave to the person:** Codex asks for a one-time review of the plugin's
   hooks. In Codex, open `/hooks`, review lobstah's hooks and trust them.
   Installing the plugin does not trust its hooks. Until they are trusted,
   the session-start hook does not run, the session has no id for lobstah,
   and the helm cannot be taken.
2. Open a new Codex session and type:

```text
$lobstah:man
```

**Worked:** the same as for Claude Code: a charter, and the address of the
glass.

To check the trust step from a shell, run `lobstah doctor` again: the
`hooks codex` row names each hook and says `trusted` beside it.

**Did not work:** the skill loads, and sign-on fails for want of a session
id: the hooks are not trusted yet. Send the person back to `/hooks`. Do not
make up a session id.

### OpenClaw

Do steps 1 to 5 on the gateway host: the repos and the daemon live there.
Then:

```bash
openclaw plugins install lobstah-openclaw-plugin
```

OpenClaw asks before it installs a plugin from an outside source. **Leave
that answer to the person**, and do not pass a flag that skips it.

The plugin registers four tools, all of them optional: `lobstah_dispatch`,
`lobstah_status`, `lobstah_send` and `lobstah_cancel`. An optional tool does
nothing until the gateway allows it. **Ask the person**, then add either the
plugin's id, `lobstah`, or the four tool names to `tools.allow` in the
gateway's config, and keep what is already listed there.

**Worked:** `openclaw plugins inspect lobstah --runtime --json` lists the
plugin, and typing `/lobstah` in the chat prints the state of the fleet.

`/lobstah` shows status. It does not take a helm and it does not open the
glass. For a helm, use Claude Code or Codex as above.

### By hand

Steps 1 to 5 are the whole install. The three commands on the lobstah page
are steps 2, 3 and 5:

```bash
npm i -g lobstah
lobstah init --scan ~/src
lobstah daemon install
```

`~/src` there is an example. Use the person's own folder. Then add the plugin
for the harness, as above, to take a helm. To open the glass without a helm:

```bash
lobstah glass --detach
```

It prints the address to open.

## 7. Tell the person what is done and what is left

End with a short list:

- what you installed and its version (`lobstah version`);
- the repos now in the config file, each with its trunk, and the worker
  harness;
- whether the daemon is installed and running;
- any `warn` or `fail` row the doctor still shows;
- what is left for them: opening a new session and typing `/lobstah:man` or
  `$lobstah:man`, trusting the hooks in Codex, allowing the tools in OpenClaw,
  signing in to anything that was not signed in.

Do not say lobstah is set up if a step above is still open.

## More

- [Claude Code guide](https://raw.githubusercontent.com/aequitas-labs/lobstah/main/docs/harness/claude-code.md)
- [Codex guide](https://raw.githubusercontent.com/aequitas-labs/lobstah/main/docs/harness/codex.md)
- [OpenClaw integration](https://raw.githubusercontent.com/aequitas-labs/lobstah/main/docs/openclaw.md)
- [Configuration reference](https://raw.githubusercontent.com/aequitas-labs/lobstah/main/docs/configuration.md)
- [README](https://raw.githubusercontent.com/aequitas-labs/lobstah/main/README.md)
