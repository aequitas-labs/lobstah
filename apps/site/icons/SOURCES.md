# Where each mark comes from

The product marks on the page are their owners' trademarks. They are used
only to name the product a feature works with, at small size, with the
product's name beside them. The shapes are the published ones, not redrawn.
`scripts/build-site.mjs` inlines each file where the page asks for it and
changes nothing but the wrapper's attributes.

| File              | Mark                               | From                                                                                      | Version | Set's licence       | Owner's notes                                                                                                                           |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- | ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code.svg` | Claude Code                        | [Simple Icons](https://simpleicons.org), `claudecode`                                     | 16.35.0 | CC0 1.0             | source given as https://code.claude.com; no guidelines link in the set                                                                  |
| `codex.svg`       | Codex                              | [lobe-icons](https://github.com/lobehub/lobe-icons), `@lobehub/icons-static-svg`, `codex` | 1.95.1  | MIT                 | OpenAI's brand page (https://openai.com/brand/) refused an automated read; its terms were not checked                                   |
| `github.svg`      | GitHub                             | Simple Icons, `github`                                                                    | 16.35.0 | CC0 1.0             | https://github.com/logos                                                                                                                |
| `linear.svg`      | Linear                             | Simple Icons, `linear`                                                                    | 16.35.0 | CC0 1.0             | source given as https://linear.app; no guidelines link in the set                                                                       |
| `graphite.svg`    | Graphite (graphite.dev)            | Simple Icons, `graphite`                                                                  | 16.35.0 | CC0 1.0             | source given as https://graphite.dev; no guidelines link in the set                                                                     |
| `slack.svg`       | Slack                              | [devicon](https://github.com/devicons/devicon), `slack-original`                          | 2.17.0  | MIT                 | https://slack.com/media-kit says use of the marks means following its guidelines; the full guidelines (brand.slackhq.com) were not read |
| `openclaw.svg`    | OpenClaw                           | lobe-icons, `@lobehub/icons-static-svg`, `openclaw`                                       | 1.95.1  | MIT                 | the project itself is MIT (github.com/openclaw/openclaw)                                                                                |
| `eyes.svg`        | a pair of eyes, for "stands watch" | drawn for this page                                                                       |         | MIT, with this repo | not a product mark                                                                                                                      |
| `stack.svg`       | a stack, for PR stacks             | drawn for this page                                                                       |         | MIT, with this repo | not a product mark                                                                                                                      |

Simple Icons 16.35.0 does not ship Slack, OpenAI or Codex marks, which is why
those two come from other sets.

The set licences cover the files, not the trademarks. To drop a mark, delete
its file and the place in `index.html` that asks for it; the build fails on a
missing file, so nothing ships half-removed.
