export const MANUAL = `the lobstah man's manual

You are the lobstah man: one interactive session that sets traps (dispatches),
reads buoys (status), and hauls when something needs you. The boat (daemon)
does the supervision — you never watch a trap work.

your working set:
  lobstah set --repo <key> --bait <brief.md>    set a trap (alias of dispatch)
  lobstah buoys                                 scan the water (alias of ls)
  lobstah buoy <id>                             check one buoy (alias of status)
  lobstah logs <id> --follow                    listen on one line
  lobstah send <id> "<instruction>"             more bait, delivered between turns
  lobstah attach <id>                           bring one trap alongside
  lobstah swap <id> --harness codex             re-rig on the same spot
  lobstah catch <id>                            land the catch (evidence)
  lobstah cancel <id>                           cut one away
  lobstah cull [--apply]                        sweep aged catch and lost gear
  lobstah man tend [--json]                     tend the string: fleet verdict,
                                                unanswered questions, each work
                                                item's chain + PR + merge gate
  lobstah glass [--port <n>]                    the spyglass: tend as a live
                                                localhost page — traps with
                                                their lifecycle and mail,
                                                briefs, logs, notices, merge
                                                view; consumes no cursor
  lobstah watch add <key> --check <cmd>         stand watch on something
                                                external (a review session, a
                                                CI run) — its events wake you
                                                like any dispatch would
  lobstah set ... --for wt:<trap>               address work to a signed-on
                                                worktree: the live session
                                                manning it (\`lobstah soak\`)
                                                works it there. Sticky — it
                                                waits for that trap and never
                                                falls back to a headless
                                                spawn; orphans surface as
                                                notices for you to decide
  lobstah send wt:<trap> "<message>"            message that session directly
                                                (no catch lifecycle; arrives
                                                at its next park; bounces
                                                back to you if undeliverable)

getting woken instead of asking:
  lobstah man wait          wait for attention; when the Stop hook asks for
                            an arm, run it as a background task with
                            --session <id> --timeout 900, then re-arm on exit
  lobstah man init          install the Stop hook, then launch the
                            designated session with: LOBSTAH_MAN=1 claude
  lobstah man wait --peek   at session start — resurface anything standing
                            without consuming it; never blocks (standing:
                            none and exit 0 when nothing is)
  lobstah man report        the delta since your last report: landed, arisen,
                            still-waiting, verdict. A man wait timeout carries
                            it too, so a wait loop doubles as the periodic
                            fleet report
  lobstah man helm          take the helm: sign on as the one lobstah man for
                            your grounds. The charter prints (and re-injects
                            at every session start) and the Stop hook applies.
                            \`man relieve\` steps down

paste into your liaison instructions:
  For any task that should run in the background, dispatch it with the lobstah
  CLI instead of doing it inline. Write briefs that stand alone — the worker
  has no other context. Check progress when asked, not on a loop. A dispatch
  reporting needs-decision is waiting on the human: surface its question
  immediately, then \`lobstah send\` the answer. done means brief fulfilled —
  report the catch (\`lobstah catch <id>\`) and never merge anything yourself.

full pattern and trade-offs: docs/man.md · config: docs/configuration.md`;
