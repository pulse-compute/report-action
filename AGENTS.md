# Report action maintainer instructions

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
- Stage only explicit report outputs; do not upload whole workspaces or `.pulse/`.
- Document what is implemented versus planned. Do not tag a consumer release or
  claim end-to-end PR evidence from mocked/local-only tests.
- Keep dependencies minimal; prefer Node built-ins. Pin external actions by SHA.
- `npm test` is required for changes. Add meaningful integration/adversarial tests
  for new execution, retention, publishing or trust boundaries.
- Prepare reviewable PRs. Human release, visibility, repository-access settings,
  provider deployment and consumer installation are separate actions.
