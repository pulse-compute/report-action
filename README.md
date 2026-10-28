# Pulse report action

Build Pulse Native reports in GitHub Actions and attach download links to pull requests. Discover affected projects automatically, capture their reports, and keep one bot comment up to date as the PR changes.

**Pre-release:** install using a reviewed full commit SHA; there is no `v1` release. Native capture and PR publishing are available. Comparisons require an explicit validation-only beta.10 opt-in; see [comparison settings](docs/configuration.md#comparisons).

[Quick start](#quick-start) · [PR attachment example](#pr-attachment-example) · [Settings and options](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md)

## Quick start

### 1. Prepare your project

Use a GitHub.com repository with a tracked `.pulse/config.ts`, a Native profile, and a committed npm or pnpm lockfile. Declare `@pulse-compute/cli` and your application/provider dependencies in that lockfile. The default CLI version is exactly `1.0.0-beta.10`. The action installs from your lockfile; it does not add or upgrade Pulse.

Dependency installation disables lifecycle scripts. If your build needs generated assets, configure a non-secret `setup_command` that writes ignored outputs. See [package setup](docs/configuration.md#package-setup-and-custom-commands).

### 2. Install the capture workflow

Save this as `.github/workflows/pulse-reports.yml`, or copy the [annotated template](examples/pulse-reports.yml). Replace `REVIEWED_FULL_COMMIT_SHA` with a reviewed 40-character commit SHA from this repository. Change `local` to your Native profile and `main` to your default branch if needed.

```yaml
name: Pulse reports
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  actions: read
jobs:
  reports:
    uses: pulse-compute/report-action/.github/workflows/reports.yml@REVIEWED_FULL_COMMIT_SHA
    with:
      profiles: '["local"]'
      package_manager: npm
      install_directory: '.'
      pulse_version: 1.0.0-beta.10
```

Open or update a PR. The workflow discovers tracked Pulse projects, builds affected Native profiles, and adds download links to the Actions run summary. Pushes to the default branch capture reusable baselines. For a different approved baseline branch, set `baseline_branch` and match the push filter.

Do not restrict triggers to `.pulse/**`: application source, shared files, and lockfiles also affect builds. Public report-action workflows need no extra secret, subject to your repository's Actions allow policy.

### 3. Enable the PR comment

Install these two files on your repository's **default branch**:

| Copy from this repository | Save in your repository |
| --- | --- |
| [Publisher workflow](examples/pulse-report-publisher.yml) | `.github/workflows/pulse-report-publisher.yml` |
| [Publisher policy](examples/pulse-report-publisher.json) | `.github/pulse-report-publisher.json` |

In the publisher workflow, set its reviewed SHA and ensure `workflow_run.workflows` matches the capture workflow's `name` (`Pulse reports` above). Start with `dry_run: true` to inspect the generated comment in the publisher's job summary, then set it to `false` to post comments.

In the policy, replace `REVIEWED_FULL_CAPTURE_COMMIT_SHA` with the SHA used by the **capture** workflow. Match its inputs, expected provider for every profile, and exact Node/package-manager versions. The example uses Node `v24.18.0` and npm `11.16.0`; verify the npm version against your capture's execution metadata. See the [policy reference](docs/configuration.md#publisher-policy).

Trigger a fresh PR capture after installation. Only the publisher receives `pull-requests: write`; capture remains read-only. It validates the current PR, run, recipe, and artifact bytes before creating or updating its comment.

## PR attachment example

This is the visible comment block for a successful validation comparison. Names, revisions, run IDs, artifact IDs, and URLs below are illustrative placeholders, not live downloads. Capture-only runs show `—` under Compare and `baseline unavailable: not-requested` under State.

<!-- BEGIN PR COMMENT EXAMPLE -->
## Pulse reports

Head: `1111111111111111111111111111111111111111`

Baseline (merge-base): `2222222222222222222222222222222222222222`

[Capture run 123456789, attempt 1](https://github.com/example/my-app/actions/runs/123456789) — success.

| Project | Profile | Report | Compare | Evidence | State |
| --- | --- | --- | --- | --- | --- |
| my-app | local | [report.html](https://github.com/example/my-app/actions/runs/123456789/artifacts/1001) | [compare.html](https://github.com/example/my-app/actions/runs/123456789/artifacts/1002) | [evidence.zip](https://github.com/example/my-app/actions/runs/123456789/artifacts/1003) | validation comparison: compatible |

Documentation and troubleshooting: [report-action](https://github.com/pulse-compute/report-action/tree/3333333333333333333333333333333333333333) — version status unavailable.
<!-- END PR COMMENT EXAMPLE -->

`report.html` and `compare.html` download standalone HTML files to open locally. `evidence.zip` contains the reports, JSON, checksums, and capture metadata. The comparison link appears only when available. Missing, failed, expired, or incompatible results stay explicit.

Downloads require GitHub sign-in and repository access and expire after 30 days. This integration does not host reports publicly. Public tooling does not make private consumer source or artifacts public.

## How it works

1. Discover tracked `.pulse/config.ts` roots at the PR head and merge-base without executing configuration. Shared changes conservatively affect every project; unchanged projects need no PR build.
2. Install locked dependencies with scripts disabled, build selected Native profiles, and capture HTML/JSON. JavaScript targets are skipped.
3. If comparison validation is enabled, reuse an eligible approved-push report for the exact merge-base or rebuild that revision with its own lockfile. Missing baselines never become invented zero deltas.
4. Publish links through a separate trusted workflow. It checks identities and hashes, keeps one bot-owned comment, and rejects stale results.

For all inputs, policy fields, limits, and upgrade instructions, see [Settings and options](docs/configuration.md). For failures and current limitations, see [Troubleshooting](docs/troubleshooting.md). To extend the integration, start with [Contributing](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
