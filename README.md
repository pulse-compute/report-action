# Pulse report action

Reusable GitHub automation for Pulse report and comparison evidence on pull requests.

**Status: Native report capture is implemented; baseline comparison integration and PR publishing remain in progress.** No `@v1` release tag exists. Use a reviewed commit SHA for validation. RA-01 provides a reusable workflow, public installed-CLI capture, per-project artifacts and a run summary; it does not post a PR comment yet.

## Intended consumer experience

Install a small caller workflow, pin the central reusable workflow by reviewed SHA, and select the repository's package setup and Pulse profiles. A lightweight discovery job runs on PR updates; builds run only when relevant changes exist. The planned complete integration supplies downloadable report/comparison HTML and JSON with one maintained PR comment. The current capture workflow supplies head report HTML/JSON, artifact identity and a run summary.

Initial scope is Native build evidence and offline downloads. GitHub artifacts require sign-in and expire according to retention. Interactive public hosting, deployment, runtime/provider qualification and permanent archival are outside the first release.

The repository is currently private. Cross-repository reuse requires the repository owner's GitHub Actions access configuration for permitted consumers, or a separately approved visibility change. Its explicit source checkout can additionally require a read-only `tooling_read_token` for this repository. That token is used only in discovery and is never passed to capture jobs. Same-repo use and public-tooling use need no additional token. Creating this repository does not configure that access.

## Native report capture

Copy [examples/pulse-reports.yml](examples/pulse-reports.yml) to the consumer's `.github/workflows/pulse-reports.yml`, replace `REVIEWED_FULL_COMMIT_SHA` with a reviewed report-action SHA, and select the explicit profiles and dependency installation root. Do not filter the trigger to `.pulse/**`: ordinary source and shared dependencies are build inputs too. The workflow supports `pull_request` events on GitHub.com and uses `job.workflow_sha` to obtain its own exact source. GitHub Enterprise Server is not yet supported.

| Input | Default / contract |
| --- | --- |
| `profiles` | JSON array, default `["local"]`; 1–8 distinct explicit names |
| `install_directory` | `.`; repository-relative package/lock root containing the selected projects |
| `package_manager` | `npm` or `pnpm`; no floating auto-detection |
| `pulse_version` | `1.0.0-beta.10`; must match the consumer's installed exact CLI version |
| `setup_command` | Empty; optional non-secret setup after install |
| `build_command` | Empty uses public `pulse build --json`; override must emit one matching completed build JSON object |

Declare the CLI and app dependencies in the consumer lockfile first. npm uses `npm ci --ignore-scripts`; pnpm uses `install --frozen-lockfile --ignore-scripts` with an exact `pnpm@x.y.z` packageManager field. No implicit Pulse CLI installation or version fallback occurs. Node is pinned to 24.18.0. Native provider selection comes from each profile's public build plan and is checked against the completed build and report. JavaScript profiles are explicitly skipped before building a Native report.

Optional commands run in the installation root with `PULSE_PROJECT`, `PULSE_PROFILE` and `PULSE_CLI` environment variables. For example:

```yaml
with:
  profiles: '["ci"]'
  install_directory: apps
  setup_command: npm run generate
  build_command: node "$PULSE_CLI" build "$PULSE_PROJECT" --profile "$PULSE_PROFILE" --json
```

Commands must not contain secrets or print extra stdout around the single build JSON object. Raw command output and command bodies are not retained in artifacts. A command returning an execution plan or exiting successfully without a completed matching build does not count as a successful capture. Capture rejects tracked-source or lockfile mutation; generators must write ignored disposable outputs. Timeouts and Native-only limitations remain explicit.

Discovery runs in a separate job without executing project code. It stages only this workflow's exact tooling and a plan; capture jobs receive no repository secrets or comment-write token. Project subprocesses additionally omit token/credential and GitHub file-command environment variables. This is a permissions boundary, not a sandbox guarantee for arbitrary application/build code; PR-produced reports remain untrusted evidence for the future publisher to admit.

The matrix is bounded to 256 project/profile entries, two concurrent captures, 45 minutes per capture job and 12 minutes per subprocess. No affected projects means no install/build. Removed projects produce a skip status without dependency resolution. Missing/failed captures do not turn the workflow green or become reports.

Each successful artifact contains only `head.json`, `head.html`, `manifest.json` and `capture.json`. A failed/skipped capture contains status only, with phase, exit class and a stable diagnostic/failure code rather than raw logs or source values. Head report capsule provenance is unchanged. Baseline status is explicitly `not-requested` (or `new-project`); RA-02 owns baseline selection and compare integration.

After upload, a separate small binding receipt records the GitHub artifact ID and archive digest; these cannot be embedded in the archive they identify. The summary uses those IDs to link downloadable artifacts and lists missing terminal captures. Artifact names include recipe/run/attempt identity. Captures and bindings are retained for 30 days; the same-run tooling plan for 14 days. No automatic PR comment, live hosting, deployment or runtime qualification is performed.

Local validation:

```bash
npm test
npm run test:capture
```

`test:capture` creates isolated temporary consumer Git repositories and installs real beta.10 packages with scripts disabled. It covers root/nested reports, failure/status handling, plan-only rejection, JavaScript skip, no-op selection and removed projects. The self-caller in CI additionally exercises the actual reusable workflow and GitHub artifact handoff; separate external consumers/fork publishing remain RA-04/RA-03 qualification. npm capture is exercised now; the pnpm path remains a separate consumer-matrix obligation in RA-04.

## Implementation queue

| Unit | Deliverable | Dependency |
| --- | --- | --- |
| [RA-00 / #1](https://github.com/pulse-compute/report-action/issues/1) | Project discovery and evidence identity | Foundation PR |
| [RA-01 / #2](https://github.com/pulse-compute/report-action/issues/2) | Build/capture reusable workflow and consumer caller | RA-00 |
| [RA-02 / #3](https://github.com/pulse-compute/report-action/issues/3) | Exact baseline recovery and comparison | RA-01 + Pulse public adapter |
| [RA-03 / #4](https://github.com/pulse-compute/report-action/issues/4) | Verified PR comment publisher, including forks | RA-01/02 |
| [RA-04 / #5](https://github.com/pulse-compute/report-action/issues/5) | Real consumer qualification and first release | RA-01/02/03 |

Pulse owns the public comparison defect in [pulse#503](https://github.com/pulse-compute/pulse/issues/503). Its existing shared comparison engine and HTML renderer will be consumed through a supported public entry point for release. Beta.10 does not expose the proposed `pulse compare` command. The compare CLI syntax in that issue is a proposal, not an available command.

The owner explicitly authorized a temporary internal shim **for validation**, described below. It does not duplicate matching/arithmetic and does not turn the internal modules into public exports. RA-02 validation can proceed before #503 is released; consumer release still requires its supported replacement.

## Temporary comparison validation

`src/compare-validation.mjs` bridges the exact published `@pulse-compute/cli@1.0.0-beta.10` internals while #503 awaits release. Use requires an explicit validation opt-in:

```bash
npm ci --prefix validation --ignore-scripts --no-audit --no-fund
npm run test:shim
mkdir -p validation/.output
npm run validate:compare -- --allow-internal-beta10 validation/fixtures/before.json validation/fixtures/after.json validation/.output/example
```

The output directory must be new. The shim writes `compare.json`, self-contained `compare.html`, and `compare-shim-receipt.json`. The receipt records the validation-only adapter, reviewed pin digest, package version, upstream issue, original input byte hashes, capsule/comparison hashes, compatibility and generated file hashes. It does not claim a fresh application build or verified Git lineage.

The isolated `validation/package-lock.json` pins the registry dependency closure and npm integrity. Before importing code, the loader verifies package names/versions and 56 package/report/dependency files against `validation/internal-compare-pin.json`, including the entire report inventory and the contracts path module used by it. Missing/changed/extra report files, changed entrypoints, package versions, digest mismatches or symlink paths fail. It resolves packages only from the isolated validation installation. It never loads application configuration or automatically falls back to another version/adapter.

Six installed-package validation tests cover real retained capsules, identical-input control, malformed/tampered data, changed package/code/inventory, unsafe paths, opt-in and unchanged input bytes. [Fixture provenance](validation/fixtures/README.md) distinguishes retained beta.9/beta.10 example evidence from a newly built PR pair. CI separately installs with lifecycle scripts disabled, runs these tests and retains a comparison/receipt bundle for 14 days. HTML is a download, not a hosted viewer.

Removal condition: when a released installed CLI supports #503, replace this adapter with the public command and rerun the same fixture assertions. Delete the internal loader, pins and isolated validation dependency installation once equivalent public-command validation passes. Do not silently repin the internal shim to a newer Pulse release or enable it as a production fallback.

## Discovery contract

`src/discover.mjs` inspects Git objects without importing configuration or executing application code:

- Require exact full target-base and PR-head commit SHAs; derive their merge-base explicitly.
- Find tracked regular `.pulse/config.ts` files in both merge-base and head trees. The directory containing `.pulse/` is the project root; a repository-root project is `.`.
- Treat changes anywhere below a project root as relevant, including ordinary source outside `.pulse/`. Nested changes also affect a containing parent project.
- Changes outside known project roots conservatively affect every project. This includes shared source, root lockfiles and setup files. There is no claimed dependency-graph analysis in v1.
- Keep added, removed and renamed roots explicit. Untracked/generated `.pulse/` content does not create projects.
- Optional `ignorePrefixes` are literal repository-relative prefixes. Callers own the correctness of exclusions; default is no exclusions.
- Reject symbolic-link configurations and unsafe/control-character paths. The initial implementation supports SHA-1 Git repositories and bounds discovery at 256 roots/64 MiB command output.

Run discovery locally with Node 24:

```bash
npm run discover -- <full-target-base-sha> <full-pr-head-sha> /path/to/repository
```

This prints `pulse.report-action.discovery.v1` JSON. It does not build or contact GitHub. Unrelated changes can cause conservative rebuilds; that is intentional until a proven input graph can safely narrow them.

## Evidence identity

`src/evidence.mjs` implements `pulse.report-action.evidence.v1` for PR bundles:

| Field | Meaning |
| --- | --- |
| Repository / PR | Consumer repository and PR number |
| Revisions | Target base, merge-base baseline and PR head, each a full SHA |
| Project | Relative root plus a path-derived stable ID |
| Recipe | Profile, provider, Native target, exact Pulse version, lock SHA-256 and execution fingerprint |
| Workflow / run | Workflow path and source revision; run ID, attempt and event |
| Baseline | Available, or unavailable with a bounded reason |
| Files | Explicit role, relative path, byte count and SHA-256 |

Available baselines require all six files: head/base report JSON + HTML and comparison JSON + HTML. An unavailable baseline requires head JSON + HTML and a reason; it cannot claim comparison files. RA-01 uses `not-requested` until baseline integration exists. Failed head builds have separate bounded capture statuses, not fabricated successful evidence manifests. `capture.json` records Node/package-manager versions, lifecycle policy, setup/build hashes and tooling revision bound by the execution fingerprint.

`sealBundle` hashes only named output files; it rejects symlink traversal and nonregular/oversized files. `verifyBundle` rereads and verifies every listed file. The future uploader must stage only this named inventory plus the manifest, never upload the source checkout or `.pulse/` wholesale.

`validateArtifactBinding` admits metadata for an exact successful PR run, expected project/recipe, attempt, full revisions, workflow identity, artifact ID, archive digest and unexpired retention. Expected identities must come from authenticated GitHub run/PR metadata, not from the bundle itself. The caller must separately establish PR association and latest-head/run ordering, verify the downloaded archive digest before extraction, and validate contained extraction plus file hashes. These integrations are RA-02/03 work, not claims made by a metadata validator.

Artifact names include project ID, stable recipe hash, run ID and attempt. Names support lookup; they do not replace artifact IDs, digest verification or exact identity checks. A source SHA alone does not identify the recipe. A digest binds bytes; it does not establish that untrusted project code produced truthful evidence.

The manifest is an orchestration record. It never rewrites the Pulse capsule's unknown revision, freshness or provenance fields and never promotes a PR bundle into a trusted baseline merely because its hashes match. Baseline reuse requires its own approved-push origin and matching recipe contract in RA-02.

## Execution and publication boundary

PR builds run without repository secrets or comment-write authority. A separate trusted default-branch publisher will consume bounded data, authenticate its run/PR association and create GitHub-issued download links. It must never execute PR scripts, evaluate downloaded HTML or use artifact-supplied URLs. Serialize publishing and recheck PR head/latest run before updating one bot-owned comment.

Use the PR merge-base as the default baseline. Reuse only evidence for that exact revision and matching recipe, otherwise rebuild it. Do not substitute the latest successful artifact, infer missing measurements as zero, or use a cache hit as evidence provenance.

## Development

The core foundation needs no npm dependencies or installation step:

```bash
npm test
```

Core tests use real temporary Git repositories and output files. Coverage includes merge-base behavior, shared/nested/renamed/deleted projects, path safety, baseline absence, byte tampering, fork/run identity, stale attempts, expired artifacts and recipe mismatches. CI runs the same tests on pinned Node 24.18.0 with SHA-pinned checkout/setup actions. The opted-in comparison validation has its own isolated dependencies and job, as described above.

## References

- [Reusable GitHub workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [Artifact IDs, URLs and digests](https://github.com/actions/upload-artifact#outputs)
- [Workflow run triggers and trust boundaries](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Pulse report CLI](https://github.com/pulse-compute/pulse/blob/v1.0.0-beta.10/docs/reference/cli.md#pulse-report)
