# Pulse report action

Reusable GitHub automation for Pulse report and comparison evidence on pull requests.

**Status: Native capture, exact baseline recovery and opted-in comparisons are implemented for validation.** No `@v1` release tag exists. Use a reviewed commit SHA. A separate verified PR publisher is implemented with an installation template; consumer release still requires the supported Pulse #503 adapter and RA-04 qualification. The temporary beta.10 adapter requires explicit opt-in and produces a validation receipt. [RA-04 progress](docs/qualification.md) records observed external-consumer results and the remaining release gates.

## Intended consumer experience

Install a small caller workflow, pin the central reusable workflow by reviewed SHA, and select the repository's package setup and Pulse profiles. A lightweight discovery job runs on PR updates; builds run only when relevant changes exist. The integration supplies `report.html`, `compare.html` and `evidence.zip` links in one maintained PR comment after the separate publisher is installed. The workflow supplies head report HTML/JSON, artifact identity and a run summary; opted-in validation adds baseline and comparison HTML/JSON.

Initial scope is Native build evidence and offline downloads. GitHub artifacts require sign-in and expire according to retention. Interactive public hosting, deployment, runtime/provider qualification and permanent archival are outside the first release.

This tooling repository is public. Public and private consumers can call its pinned reusable workflows without an additional `tooling_read_token`, subject to their GitHub Actions allow policies. Consumer source and generated artifacts stay in the consumer repository and follow its access permissions; public tooling does not make private consumer evidence public. A private mirror can require both GitHub Actions sharing configuration and a read-only tooling token for explicit source checkout. Such tokens are confined to tooling checkout and are never passed to project execution.

## Native report capture

Copy [examples/pulse-reports.yml](examples/pulse-reports.yml) to the consumer's `.github/workflows/pulse-reports.yml`, replace `REVIEWED_FULL_COMMIT_SHA` with a reviewed report-action SHA, and select the explicit profiles and dependency installation root. Do not filter the trigger to `.pulse/**`: ordinary source and shared dependencies are build inputs too. The workflow supports `pull_request` and approved-branch `push` events on GitHub.com and uses `job.workflow_sha` to obtain its own exact source. GitHub Enterprise Server is not yet supported.

| Input | Default / contract |
| --- | --- |
| `profiles` | JSON array, default `["local"]`; 1–8 distinct explicit names |
| `install_directory` | `.`; repository-relative package/lock root containing the selected projects |
| `package_manager` | `npm` or `pnpm`; no floating auto-detection |
| `pulse_version` | `1.0.0-beta.10`; must match the consumer's installed exact CLI version |
| `baseline_branch` | Empty selects the repository default branch; only pushes to this branch produce reusable baselines |
| `compare_internal_beta10` | `false`; explicit validation-only comparison opt-in pending #503 |
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

Each successful artifact contains only `head.json`, `head.html`, `manifest.json` and `capture.json`. A failed/skipped capture contains status only, with phase, exit class and a stable diagnostic/failure code rather than raw logs or source values. Head report capsule provenance is unchanged. Without comparison opt-in, PR baseline status is explicitly `not-requested` (or `new-project`). Approved pushes have a separate baseline manifest.

The run summary and verified PR comment separate viewing from inspection: **report.html** downloads the head report as one HTML file, **compare.html** downloads the comparison as one HTML file when available, and **evidence.zip** downloads the complete comparison bundle (or the head bundle when comparison is unavailable). The evidence bundle retains JSON, HTML, the manifest's file checksums, capture/provenance metadata and the validation receipt when applicable. GitHub's pinned upload action uses `archive: false` for HTML copies; they are not ZIP-wrapped. Actual HTML filenames include project/recipe/run/attempt identity to avoid collisions across the matrix; link labels stay short. Existing internal evidence and binding artifacts remain available for exact-baseline recovery and verification.

Before linking a standalone HTML artifact, the publisher independently authenticates its name, source run/head/attempt, retention, byte size and GitHub digest, downloads its raw bytes within the shared budget, and verifies equality to the HTML checksum in the admitted evidence manifest. It never evaluates HTML. Missing/expired standalone copies are explicit and keep the evidence download available; a digest, byte or identity mismatch rejects publication. Older capture pins without standalone copies expose evidence.zip only until the reviewed capture pin and publisher policy are upgraded together. Downloads retain repository access controls and 30-day retention; no public hosting or new secret is introduced.

After upload, a separate small binding receipt records the GitHub artifact ID and archive digest; these cannot be embedded in the archive they identify. The summary uses those IDs to link downloadable artifacts and lists missing terminal captures. Artifact names include recipe/run/attempt identity. Captures and bindings are retained for 30 days; the same-run tooling plan for 14 days. The capture workflow grants no comment-write authority. Install the separate publisher below for comments. No live hosting, deployment or runtime qualification is performed.

Local validation:

```bash
npm test
npm run test:capture
```

`test:capture` creates isolated temporary consumer Git repositories and installs real beta.10 packages with scripts disabled. It covers root/nested reports, failure/status handling, plan-only rejection, JavaScript skip, no-op selection and removed projects. The self-caller in CI additionally exercises the actual reusable workflow and GitHub artifact handoff; additional consumer/package-manager cases and external-fork publishing remain RA-04 qualification. Observed external npm consumer results are recorded in [RA-04 progress](docs/qualification.md). npm capture is exercised now; the pnpm path remains a separate consumer-matrix obligation in RA-04.

## Exact baseline and comparison validation

Enable `compare_internal_beta10: true` in a reviewed caller to validate comparisons. Include `push` on the approved branch and `actions: read` alongside `contents: read`; the example includes both triggers. Pushes capture all tracked Native project/profile pairs, so an unchanged project can still supply a future exact baseline. A push outside `baseline_branch` is rejected before any project execution.

For each affected PR project the baseline is the exact Git merge-base. Lookup uses the caller's authenticated workflow ID/path, approved branch, same repository/source repository, successful completed push run, full source revision and current attempt. Recipe matching includes project/profile, provider/Native target, exact locked Pulse version, installation root, lock digest, package manifest digest, Node/package-manager versions, setup/build hashes, lifecycle policy and central tooling SHA. Pin the same central tooling SHA on producer and consumer to permit reuse. Changing that SHA deliberately causes a rebuild. Multiple eligible archives fail closed; no newest/nearest choice is made.

The API supplies artifact IDs, archive SHA-256 and expiration. Before extraction, verify the archive digest; the Python standard-library extractor accepts exactly four root-level regular files, bounds sizes and rejects traversal, symlinks, duplicate entries and extra files. Then verify the approved-push manifest and report byte hashes. Recheck the run attempt after download. Missing, expired, wrong-recipe or otherwise ineligible evidence triggers a fresh build of the exact merge-base. Corrupt archives, ambiguous matches, API failures and identity violations fail closed rather than masking an integrity problem with a rebuild. Pagination is bounded to 1,000 runs/artifacts per lookup.

Rebuild uses the baseline's own lockfile and CLI version with the same explicit setup/build recipe and pinned orchestration toolchain. It does not install the head's CLI over an older baseline. Provider or toolchain differences remain visible in the original reports and shared-engine compatibility checks. Unresolvable baseline dependencies or a failed/skipped baseline build produce an unavailable baseline with `build-failed`, retain the head report, and fail the comparison job. New projects retain head-only evidence with `new-project`; removed projects retain `project-removed` status. There is no invented zero delta for missing or incompatible evidence.

Comparison bundles contain `head.json/html`, `base.json/html`, `compare.json/html`, the shim receipt, manifest and capture status. The manifest binds all seven evidence files; `baselineSource` records retained run/attempt/artifact ID/archive digest or the exact rebuild revision/recipe. Capture status also records toolchain differences. The separate upload binding identifies the comparison archive itself. Summaries prefer comparison artifacts, and missing comparison jobs remain missing even when a head capture succeeded. Downloads remain GitHub artifacts governed by the consumer repository permissions and retained for 30 days. Capture/comparison jobs post no comment; the separately installed publisher below handles comments.

Only the lookup step receives an explicit read-only GitHub token; baseline setup/build steps receive no repository secret or write token. The optional cross-repository tooling token remains confined to discovery. Artifact HTML is never evaluated by orchestration. These boundaries do not turn arbitrary project code into sandboxed or trusted evidence.

`npm test` covers metadata/retention/attempt/recipe and adversarial ZIP boundaries. `npm run test:capture` builds real installed baseline/head revisions, exercises exact rebuild and approved-push capture/reuse, and verifies new/failed baselines. A synthetic provider mismatch made with the pinned capsule constructor checks incompatible results retain null deltas; it is not a fresh provider qualification. Hosted self-calls additionally validate the actual GitHub handoff. Publisher orchestration is implemented below. [RA-04 progress](docs/qualification.md) separates observed external npm consumer capture/publishing from pending pnpm, external-fork and broader matrix qualification.

## Implementation queue

| Unit | Deliverable | Dependency |
| --- | --- | --- |
| [RA-00 / #1](https://github.com/pulse-compute/report-action/issues/1) | Project discovery and evidence identity | Foundation PR |
| [RA-01 / #2](https://github.com/pulse-compute/report-action/issues/2) | Build/capture reusable workflow and consumer caller | RA-00 |
| [RA-02 / #3](https://github.com/pulse-compute/report-action/issues/3) | Exact baseline recovery and comparison | RA-01 + opted-in shim for validation; public adapter for release |
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

Available baselines require all six files: head/base report JSON + HTML and comparison JSON + HTML. An unavailable baseline requires head JSON + HTML and a reason; it cannot claim comparison files. Capture-only PR runs use `not-requested`. Validation comparisons add a seventh inventory role for the adapter receipt. Failed head builds have separate bounded capture statuses, not fabricated successful evidence manifests. `capture.json` records Node/package-manager versions, lifecycle policy, setup/build hashes and tooling revision bound by the execution fingerprint.

`sealBundle` hashes only named output files; it rejects symlink traversal and nonregular/oversized files. `verifyBundle` rereads and verifies every listed file. The future uploader must stage only this named inventory plus the manifest, never upload the source checkout or `.pulse/` wholesale.

`validateArtifactBinding` admits metadata for an exact successful PR run, expected project/recipe, attempt, full revisions, workflow identity, artifact ID, archive digest and unexpired retention. Expected identities must come from authenticated GitHub run/PR metadata, not from the bundle itself. The caller must separately establish PR association and latest-head/run ordering, verify the downloaded archive digest before extraction, and validate contained extraction plus file hashes. RA-02 authenticates head/approved-push downloads and verifies their archives. RA-03 still owns PR association/latest-head checks for privileged publishing.

Artifact names include project ID, stable recipe hash, run ID and attempt. Names support lookup; they do not replace artifact IDs, digest verification or exact identity checks. A source SHA alone does not identify the recipe. A digest binds bytes; it does not establish that untrusted project code produced truthful evidence.

The manifest is an orchestration record. It never rewrites the Pulse capsule's unknown revision, freshness or provenance fields and never promotes a PR bundle into a trusted baseline merely because its hashes match. Baseline reuse requires its own approved-push origin and matching recipe contract, described below.

## Verified PR publisher

Install three reviewed files on the consumer **default branch**:

1. Copy [examples/pulse-report-publisher.yml](examples/pulse-report-publisher.yml) to `.github/workflows/pulse-report-publisher.yml`. Set `workflows` to the capture caller's workflow name, and replace the publisher SHA placeholder with a reviewed full report-action SHA.
2. Copy [examples/pulse-report-publisher.json](examples/pulse-report-publisher.json) to `.github/pulse-report-publisher.json`. Set the capture caller path, its pinned capture-tooling SHA, the same inputs/profiles, each expected Native provider, and the exact capture Node/npm versions. The publisher and capture tooling can use different reviewed SHAs. The example npm version is a pin to review against your capture toolchain, not floating auto-detection.
3. Keep the existing [capture caller](examples/pulse-reports.yml) read-only. For validation comparisons, explicitly enable `compare_internal_beta10` in both its inputs and the publisher policy. Begin with `dry_run: true` in the publisher caller to review admission and the rendered job summary; set it to `false` to enable the comment.

The publisher calls [.github/workflows/publish.yml](.github/workflows/publish.yml). It requests only `contents: read`, `actions: read` and `pull-requests: write`, and uses the built-in GitHub Actions token. A narrowly scoped optional tooling-read token can support private cross-repository source checkout; no broad PAT is required. It checks out its own version-pinned tooling and the default-branch policy at the publisher event revision. It never checks out the PR, downloads executable tooling from capture artifacts, installs project/adapter dependencies, imports configuration, evaluates HTML or runs project scripts. The only extraction subprocess is its reviewed Python standard-library helper in isolated mode, without GitHub credentials or file-command environment paths.

Admission derives PR association from authenticated run metadata plus GitHub's commit-to-PR API (with an exact owner/branch PR lookup when both association lists are empty), then requires exactly one current open PR with matching base/source repositories, source repository ID/branch and exact head. Empty `workflow_run.pull_requests` is supported, including fork-style events; absent/deleted/closed association is ignored, and ambiguous association fails closed. Artifact-embedded PR numbers cannot route publication. The workflow ID/path and referenced capture-tooling SHA must match the default-branch policy.

The publisher authenticates the PR's current test-merge commit and its base/head parents, obtains the exact merge-base from GitHub, reads bounded Git trees/blobs without checking out source, and uses the same discovery selector as capture. Expected recipes come from policy plus the head's actual package/lock bytes: project/profile/provider/Native target, Pulse version, install root, Node/package-manager versions, lifecycle policy, setup/build hashes and tooling revision. It ignores uploaded executable tooling plans and upload-binding claims when deriving expectations. `tooling.revision: "pr-merge"` is reserved for the tooling repository's same-repository validation of local reusable workflows; the authenticated referenced SHA must equal the current test-merge SHA. Consumer policy should use an exact reviewed capture SHA.

A base-branch advance or regenerated test merge can make a completed capture ineligible even if its head is unchanged. Rerun capture against that current base; the publisher does not infer an old workflow snapshot or substitute evidence. A changed toolchain or recipe requires an updated reviewed policy and fresh matching capture.

For each expected artifact, admit only the exact run/attempt/name, GitHub artifact ID, unexpired retention and archive digest. Verify the ZIP before extraction, require a small explicit root-level report/status inventory, reject duplicate members, traversal, symlinks, encrypted/nonregular files and extra executable content, then verify manifest inventories and all report byte hashes. Archives are limited to 128 MiB each and 512 MiB total per publication; expanded archives to 450 MiB, report files to 64 MiB, metadata to 64 KiB, dependency blobs to 4 MiB, Git trees to 100,000 entries/8 MiB responses, and API pagination to 1,000 rows. Limits fail closed. Source labels and mentions are escaped; the comment uses only GitHub-derived download links and bounded diagnostic codes.

Comparison admission additionally verifies the validation pin receipt and original input/output hashes. Rebuilt baseline identity/recipe must match the exact source revision. Retained baselines are separately authenticated against an approved successful push, current attempt, workflow/branch/revision/recipe, artifact digest and the comparison's actual base report bytes. Original capsule unknowns stay unknown. File/identity checks do not attest that arbitrary PR build code produced truthful measurements, and no comparison arithmetic is duplicated here.

The publisher maintains one marked `github-actions[bot]` comment, identified by GitHub.com bot ID/login/type, with report/compare archive links, full head/merge-base SHAs, run/attempt and missing/failed/expired/unavailable/incompatible states. It ignores human/other-bot lookalike markers, updates its existing comment, and skips identical results. Multiple owned comments or malformed state require reconciliation rather than creating another duplicate. Failed capture runs can publish valid partial evidence and bounded failure statuses; cancelled/nonterminal runs are ignored.

Repository-wide publication concurrency spans all PRs, including fork events without a PR number. Immediately before its single create/update, it rechecks current PR head/base/test merge and the newest same-head workflow run/attempt, including queued/in-progress successors. Older completions and older marked comment states cannot replace newer results. GitHub's comments API has no atomic PR-head precondition; the recheck narrows the remaining external head-change race, while concurrency serializes this publisher's own writes. GitHub retains at most one pending concurrency run, so newer pending events may replace older pending events; admission always rechecks canonical latest state.

Initial installation without this default-branch publisher continues to expose capture job-summary links. Artifacts require sign-in and expire with their configured retention; the publisher neither hosts HTML nor changes artifact retention. Removing the publisher does not grant capture jobs any comment permission.

Publisher tests use authenticated-API fixtures, real ZIP files and adversarial payloads for same-repository/fork association, PR/head/recipe forgery, expired evidence, newer runs, stale attempts, removed/no-op projects, baseline origin, duplicate versus update behavior, escaping and extraction limits. The installed-CLI integration also admits a freshly generated real comparison bundle. **Those tests do not establish live bot-comment delivery.** Separate hosted external-consumer results and remaining external-fork obligations are recorded in [RA-04 progress](docs/qualification.md). Consumer installation still requires review of the default-branch publisher template and policy. No release tag is created here.

GitHub references: [workflow_run privileges/default-branch behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [workflow run API](https://docs.github.com/en/rest/actions/workflow-runs), and [PR issue-comment permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

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
