# Agent guide

Use this guide when extending report-action. To install it in another repository,
follow [README.md](README.md) and copy the templates in `examples/`.
Setup and the code map are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Start here

- Read the relevant workflow, source module, and corresponding `test/` file.
- Run `npm test` with Node 24; core tests need no dependency installation.
- For capture/comparison changes, install isolated validation dependencies and
  run `npm run test:shim` and `npm run test:capture` as documented in
  `CONTRIBUTING.md`. Installed-package tests need registry access.
- Keep changes focused and prepare a reviewable PR with validation results.

## Adding behavior

- New capture input: update `.github/workflows/reports.yml`, `normalizeInputs`
  in `src/capture.mjs`, and affected execution identity/baseline matching.
- New policy expectation: update `src/publisher-source.mjs` and admission tests;
  derive trusted expectations from policy and authenticated GitHub metadata.
- New output or comment field: check `src/presentation.mjs`, `src/workflow.mjs`,
  `src/publisher.mjs`, and artifact admission together. Keep the README sample
  link block consistent with `renderComment`; do not commit generated reports.
- Update `examples/` and `docs/configuration.md` for user-facing changes.
- Keep docs focused on current setup and behavior. Put sprint progress and
  one-off evidence history in issues/PRs, not the README or new history files.

## Boundaries to preserve

This repository owns GitHub orchestration, project discovery, evidence retention
and PR presentation. Pulse owns report collection, comparison matching, capsule
contracts, diagnostics and HTML rendering.

- Preserve exact base/head/project/profile/provider/target/toolchain/run/attempt
  identities. Never silently use a nearby successful baseline or mutable cache
  as provenance. Missing evidence remains explicit.
- Discover tracked `.pulse/config.ts` roots from both Git revisions. Shared input
  changes conservatively affect all projects until a proven dependency graph can
  narrow them. Never execute configuration during discovery.
- Keep project execution isolated from PR-comment write tokens and repository
  secrets. Publisher code and configuration come from trusted pinned sources.
- Treat PR artifacts as untrusted data. Validate run/PR association through
  GitHub, verify archive/file digests, bound extraction and reject unsafe paths.
  Never execute artifact content or trust embedded URLs and PR numbers alone.
- Use public Pulse interfaces. Do not duplicate the existing comparison engine
  or depend on internal package paths. Pulse #503 owns public compare access.
  Explicit owner exception: `src/compare-validation.mjs` may use the exact
  pinned beta.10 internals solely for opted-in validation until #503 ships.
  Keep the isolated lockfile, byte pins, receipt and rejection tests. No automatic
  fallback, version range, public-support promise or production release use.
- Stage only explicit report outputs; do not upload whole workspaces or `.pulse/`.
- Document what is implemented versus planned. Do not tag a consumer release or
  claim end-to-end PR evidence from mocked/local-only tests.
- Keep dependencies minimal; prefer Node built-ins. Pin external actions by SHA.
- `npm test` is required for changes. Add meaningful integration/adversarial tests
  for new execution, retention, publishing or trust boundaries.
- Prepare reviewable PRs. Human release, visibility, repository-access settings,
  provider deployment and consumer installation are separate actions.
