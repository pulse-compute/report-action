# Settings and options

[Quick start](../README.md#quick-start) · [Troubleshooting](troubleshooting.md)

## Capture workflow inputs

Pass these under `jobs.<job>.with` when calling [reports.yml](../.github/workflows/reports.yml).

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `profiles` | string | `'["local"]'` | JSON array of 1–8 distinct names. Use letters, digits, `.`, `_`, or `-`, beginning with a letter or digit; maximum 64 characters per name. |
| `install_directory` | string | `.` | Repository-relative directory containing `package.json`, the lockfile, and every selected project. |
| `package_manager` | string | `npm` | `npm` or `pnpm`; no auto-detection. pnpm requires an exact `pnpm@x.y.z` packageManager field. |
| `pulse_version` | string | `1.0.0-beta.10` | Exact CLI version already installed from the consumer lockfile. No version ranges or fallback. |
| `setup_command` | string | empty | Optional Bash command after dependency installation. |
| `build_command` | string | empty | Optional Bash override; empty uses `pulse build <project> --profile <profile> --json`. Must emit one completed matching build JSON object. |
| `baseline_branch` | string | empty | Approved push branch; empty uses the repository default branch. Match the caller's push filter. |
| `compare_internal_beta10` | boolean | `false` | Opt into the temporary beta.10 comparison adapter for validation only. |

The workflow runs on `ubuntu-latest` with Node `24.18.0`. It accepts `pull_request` and approved-branch `push` events on GitHub.com. Capture callers require `contents: read` and `actions: read`.

## Package setup and custom commands

npm uses `npm ci --ignore-scripts --no-audit --no-fund`. pnpm uses its exact declared version with `install --frozen-lockfile --ignore-scripts`. Commit the corresponding lockfile before enabling the workflow.

Setup and custom build commands run in `install_directory`, once per selected project/profile, with these environment variables:

| Variable | Value |
| --- | --- |
| `PULSE_PROJECT` | Absolute path to the selected project |
| `PULSE_PROFILE` | Selected profile name |
| `PULSE_CLI` | Absolute path to the installed Pulse CLI entry point |

```yaml
with:
  profiles: '["ci"]'
  install_directory: apps
  setup_command: npm run generate
  build_command: node "$PULSE_CLI" build "$PULSE_PROJECT" --profile "$PULSE_PROFILE" --json
```

Commands must not contain secrets. Generators must write ignored disposable outputs: changing tracked source or the lockfile fails capture. A build override must emit only the matching completed build JSON on stdout, not a plan or surrounding logs. Command bodies and raw output are not retained in artifacts. Each command is limited to 8,192 characters and each subprocess to 12 minutes.

For a monorepo, choose a common installation root containing all discovered projects and their shared lockfile. A repository-root `.pulse/config.ts` makes the repository itself a project; nested changes also affect containing projects. Changes outside known project roots conservatively affect all projects. The workflow does not expose a dependency-graph selector or an ignore-prefix input.

## Comparisons

Set `compare_internal_beta10: true` in both the capture caller and the publisher policy's `inputs`. Include approved-branch pushes in the caller to retain baselines.

The adapter is pinned to `@pulse-compute/cli@1.0.0-beta.10` internals and is **validation-only**. It is not a supported public `pulse compare` command or a production fallback. A consumer release requires replacement with the supported interface tracked in [Pulse #503](https://github.com/pulse-compute/pulse/issues/503).

The baseline is the exact Git merge-base. Reuse requires a successful approved push with matching project/profile/provider, lockfile and execution recipe, tooling SHA, run attempt, and unexpired verified artifacts. Missing, expired, or otherwise ineligible evidence triggers an exact rebuild with the baseline's own dependencies. Corrupt or ambiguous evidence and identity violations fail closed. A changed tooling SHA or recipe can force a rebuild.

New projects keep head-only reports (`new-project`); removed projects are skipped (`project-removed`). A failed baseline build keeps the head report but fails comparison. Incompatible reports retain their compatibility state instead of claiming a valid zero delta.

## Publisher workflow inputs

Pass these to [publish.yml](../.github/workflows/publish.yml). Install its [caller](../examples/pulse-report-publisher.yml) on the consumer default branch and trigger it through `workflow_run` for the capture caller's name.

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `policy_path` | string | `.github/pulse-report-publisher.json` | Trusted policy path in the default-branch checkout at the publisher event revision. |
| `dry_run` | boolean | `false` | Validate artifacts and render the job summary without creating or updating a comment. |

The publisher requires `contents: read`, `actions: read`, and `pull-requests: write`. It uses the built-in GitHub token and never executes PR source or artifact HTML. Completed PR captures with success or failure can supply results; cancelled/nonterminal runs are ignored. Publishing is serialized per repository and rechecks current PR head/base and newest run/attempt before writing.

## Publisher policy

Copy [pulse-report-publisher.json](../examples/pulse-report-publisher.json) and edit these fields. This is a trusted allowlist: changes to capture settings must be reflected here before matching results can publish.

| Field | Value / contract |
| --- | --- |
| `schemaVersion` | `pulse.report-action.publisher-policy.v1` |
| `captureWorkflow` | Consumer caller path, e.g. `.github/workflows/pulse-reports.yml`; not its display name. |
| `tooling.repository` | `pulse-compute/report-action`, or your reviewed mirror. |
| `tooling.workflow` | `.github/workflows/reports.yml` |
| `tooling.revision` | Full reviewed **capture** SHA matching the caller. `pr-merge` is reserved for this repository's own validation. |
| `inputs` | Matching capture inputs, using a JSON array for `profiles`. Omitted fields use the capture defaults. Include custom setup/build commands and baseline branch when configured. |
| `providers` | Map every selected profile to its expected Native provider, e.g. `{ "local": "node", "ci": "fastly" }`. |
| `nodeVersion` | Exact capture version including `v`, currently `v24.18.0`. |
| `npmVersion` | Exact capture npm version when `package_manager` is `npm`. The example is `11.16.0`; verify against capture execution metadata. For pnpm, the version comes from the consumer's exact packageManager pin. |

The publisher workflow may use a different reviewed SHA from capture. Policy `tooling.revision` always identifies capture. Both workflows and the policy must be trusted; never point the publisher at PR source.

## Optional secret

Both workflows accept `tooling_read_token`, a narrowly scoped contents-read token for checking out a private tooling mirror. Public report-action needs no extra token. A private mirror also needs appropriate GitHub Actions sharing settings. The token is confined to pinned tooling checkout and is never passed to project execution. Do not use `secrets: inherit` for project builds.

## Downloads, retention, and limits

| Item | Behavior |
| --- | --- |
| `report.html` | Standalone head report; download and open locally. |
| `compare.html` | Standalone comparison when available. |
| `evidence.zip` | Complete comparison bundle, or head bundle when comparison is unavailable. Includes JSON/HTML, manifest checksums, capture metadata, and validation receipt when applicable. |
| Retention | Reports, comparisons, and binding receipts: 30 days. Same-run tooling plans: 14 days. |
| Capture matrix | At most 256 project/profile entries; two concurrent jobs per matrix. |
| Timeouts | Capture/comparison jobs: 45 minutes each. Publisher: 15 minutes. |
| Publisher bounds | 128 MiB per archive, 512 MiB total download budget, 450 MiB expanded per archive, 64 MiB per report file, 64 KiB metadata. |
| Lookup bounds | Up to 1,000 runs/artifacts per lookup; source trees limited to 100,000 entries and 8 MiB API responses. |

Retention and job limits are fixed in the reusable workflows, not caller inputs. Links use GitHub access controls. Actual HTML filenames include project/recipe/run/attempt identity; comment labels stay short. Missing standalone HTML leaves the verified evidence bundle available. No hosted viewer or permanent archive is provided.

## Upgrade or roll back

1. Review and pin the desired capture and publisher commits.
2. Update policy `tooling.revision`, matching capture inputs, providers, and toolchain versions on the default branch. Keep these changes coordinated with the caller pins.
3. Use publisher `dry_run: true` to inspect admission and the rendered result, then restore `false` when ready.
4. Trigger a fresh capture. Run an approved-branch push to refresh retained baselines when needed.

Roll back by restoring the previous reviewed caller pins and matching policy together, then capture again. A base-branch advance can invalidate a completed capture even when its PR head has not changed. The comment footer links to the installed capture revision and gives a best-effort version status; lookup failure does not block reports.
