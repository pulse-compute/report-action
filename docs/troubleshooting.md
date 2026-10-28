# Troubleshooting

[Quick start](../README.md#quick-start) · [Settings and options](configuration.md)

Start with the capture run summary, then the publisher job summary. The evidence bundle's `capture.json` records bounded status/failure codes and execution metadata; it does not retain raw command output.

| Symptom | What to check |
| --- | --- |
| No PR comment | Install the publisher caller and policy on the default branch. Match `workflow_run.workflows` to the capture caller's name; check `dry_run` and publisher permissions. Trigger a fresh PR capture. |
| `Producer tooling differs from publisher policy` | Match policy `tooling.revision` to the capture caller's full SHA, not the publisher SHA. |
| Recipe or toolchain mismatch | Match profiles, provider, CLI version, installation root, setup/build commands, and actual Node/npm versions in policy; capture again. |
| Stale head/base/run or changed PR test merge | Trigger a fresh capture against the current head and base. Older completions and attempts cannot overwrite newer results. |
| No affected projects | Check that `.pulse/config.ts` is tracked at the expected root and that the PR changes affect a discovered project. No-op PRs skip install/build. |
| `unsupported-javascript-target` | Select a Native profile. JavaScript report capture is not supported. |
| Install/setup failure | Commit the correct lockfile, exact CLI and pnpm pins, and required dependencies. Lifecycle scripts are disabled; use `setup_command` for ignored generated assets. Private dependency installs requiring secrets are outside the current execution contract. |
| Setup or build changed tracked files | Write generated files into ignored output directories; do not modify tracked source or lockfiles. |
| Build override rejected | Emit one completed matching `pulse build --json` object. Plans, extra stdout, and an exit code alone are insufficient. |
| Compare link absent | Comparisons are off by default. Enable the validation opt-in in both caller and policy, or inspect the explicit new-project, baseline-failure, or incompatibility state. |
| Baseline rebuilt despite earlier reports | Reuse needs the exact merge-base from an approved push with the same recipe/tooling and unexpired artifacts. A nearby successful commit is not a substitute. |
| HTML link missing but evidence available | The standalone copy may be missing/expired, or capture may use an older pin. Use the verified bundle; upgrade capture and policy together for standalone links. |
| Downloads unavailable | Sign in with repository access and check the 30-day retention window. Generate a fresh capture after expiration. |
| Digest, identity, ZIP, or size validation fails | Inspect the failing artifact and configured workflow; do not disable validation or substitute another run's evidence. |
| Multiple bot-owned comments | Reconcile duplicate marked `github-actions[bot]` comments before retrying; the publisher will not guess which one to update. |
| `version status unavailable` | The optional public version lookup failed or cannot inspect a private mirror. Reports still work and the documentation link remains pinned. |

## Current scope

- GitHub.com and Native reports; no GitHub Enterprise Server, report hosting, deployment, or runtime/provider qualification.
- Pre-release installation by full commit SHA. Comparisons use an explicitly opted-in, byte-pinned internal beta.10 adapter until a supported public replacement is available.
- External npm capture, baseline recovery/reuse, and live comment create/update have been exercised. Broader hosted coverage remains incomplete for external forks, pnpm/monorepos, failed/expired capture scenarios, and offline browser interaction. Local fixture tests do not establish those hosted behaviors.

Capture jobs execute project code with read-only repository permissions and without publisher credentials. This is not a sandbox guarantee. Artifact identity and hash checks establish which bytes were produced, not that arbitrary PR code reported truthful measurements. Pulse capsule provenance and unknown fields remain unchanged.
