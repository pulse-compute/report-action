# Pulse report action

Reusable GitHub automation for Pulse report and comparison evidence on pull requests.

**Status: foundation implemented; consumer workflow and PR publishing are not yet implemented or released.** Do not install a `@v1` action yet. No release tag exists. This repository currently provides tested project discovery and evidence-binding primitives, plus the implementation queue below.

## Intended consumer experience

Install a small caller workflow, pin the central reusable workflow by reviewed SHA, and select the repository's package setup and Pulse profiles. A lightweight discovery job runs on PR updates; builds run only when relevant changes exist. Each affected project receives downloadable report HTML and comparison HTML, authoritative JSON, and an identity manifest. One maintained PR comment links the retained artifacts.

Initial scope is Native build evidence and offline downloads. GitHub artifacts require sign-in and expire according to retention. Interactive public hosting, deployment, runtime/provider qualification and permanent archival are outside the first release.

The repository is currently private. Cross-repository reuse requires the repository owner's GitHub Actions access configuration for permitted consumers, or a separately approved visibility change. Creating this repository does not configure that access.

## Implementation queue

| Unit | Deliverable | Dependency |
| --- | --- | --- |
| [RA-00 / #1](https://github.com/pulse-compute/report-action/issues/1) | Project discovery and evidence identity | Foundation PR |
| [RA-01 / #2](https://github.com/pulse-compute/report-action/issues/2) | Build/capture reusable workflow and consumer caller | RA-00 |
| [RA-02 / #3](https://github.com/pulse-compute/report-action/issues/3) | Exact baseline recovery and comparison | RA-01 + Pulse public adapter |
| [RA-03 / #4](https://github.com/pulse-compute/report-action/issues/4) | Verified PR comment publisher, including forks | RA-01/02 |
| [RA-04 / #5](https://github.com/pulse-compute/report-action/issues/5) | Real consumer qualification and first release | RA-01/02/03 |

Pulse owns the public comparison defect in [pulse#503](https://github.com/pulse-compute/pulse/issues/503). Its existing shared comparison engine and HTML renderer must be used through a supported public entry point. This action will not duplicate matching/arithmetic or import private package paths. Beta.10 supports report capture, but does not expose the proposed `pulse compare` command. The compare CLI syntax in that issue is a proposal, not an available command.

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
| Recipe | Profile, provider, Native target, exact Pulse version and lock SHA-256 |
| Workflow / run | Workflow path and source revision; run ID, attempt and event |
| Baseline | Available, or unavailable with a bounded reason |
| Files | Explicit role, relative path, byte count and SHA-256 |

Available baselines require all six files: head/base report JSON + HTML and comparison JSON + HTML. An unavailable baseline requires head JSON + HTML and a reason; it cannot claim comparison files. Failed head builds will have separate capture status/log handling in RA-01, not a fabricated successful evidence manifest.

`sealBundle` hashes only named output files; it rejects symlink traversal and nonregular/oversized files. `verifyBundle` rereads and verifies every listed file. The future uploader must stage only this named inventory plus the manifest, never upload the source checkout or `.pulse/` wholesale.

`validateArtifactBinding` admits metadata for an exact successful PR run, expected project/recipe, attempt, full revisions, workflow identity, artifact ID, archive digest and unexpired retention. Expected identities must come from authenticated GitHub run/PR metadata, not from the bundle itself. The caller must separately establish PR association and latest-head/run ordering, verify the downloaded archive digest before extraction, and validate contained extraction plus file hashes. These integrations are RA-02/03 work, not claims made by a metadata validator.

Artifact names include project ID, stable recipe hash, run ID and attempt. Names support lookup; they do not replace artifact IDs, digest verification or exact identity checks. A source SHA alone does not identify the recipe. A digest binds bytes; it does not establish that untrusted project code produced truthful evidence.

The manifest is an orchestration record. It never rewrites the Pulse capsule's unknown revision, freshness or provenance fields and never promotes a PR bundle into a trusted baseline merely because its hashes match. Baseline reuse requires its own approved-push origin and matching recipe contract in RA-02.

## Execution and publication boundary

PR builds run without repository secrets or comment-write authority. A separate trusted default-branch publisher will consume bounded data, authenticate its run/PR association and create GitHub-issued download links. It must never execute PR scripts, evaluate downloaded HTML or use artifact-supplied URLs. Serialize publishing and recheck PR head/latest run before updating one bot-owned comment.

Use the PR merge-base as the default baseline. Reuse only evidence for that exact revision and matching recipe, otherwise rebuild it. Do not substitute the latest successful artifact, infer missing measurements as zero, or use a cache hit as evidence provenance.

## Development

No npm dependencies or installation step are needed:

```bash
npm test
```

Tests use real temporary Git repositories and output files. Coverage includes merge-base behavior, shared/nested/renamed/deleted projects, path safety, baseline absence, byte tampering, fork/run identity, stale attempts, expired artifacts and recipe mismatches. CI runs the same tests on pinned Node 24.18.0 with SHA-pinned checkout/setup actions.

## References

- [Reusable GitHub workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [Artifact IDs, URLs and digests](https://github.com/actions/upload-artifact#outputs)
- [Workflow run triggers and trust boundaries](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Pulse report CLI](https://github.com/pulse-compute/pulse/blob/v1.0.0-beta.10/docs/reference/cli.md#pulse-report)
