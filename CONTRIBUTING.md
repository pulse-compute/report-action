# Contributing

This repository owns GitHub workflow orchestration, discovery, report retention, and PR presentation. Pulse owns report collection, comparison logic, capsule contracts, diagnostics, and HTML rendering. Read [AGENTS.md](AGENTS.md) before editing.

## Local setup

Use Node 24 (CI pins `24.18.0`), npm, Git, and Python 3. Core code uses Node built-ins and needs no dependency installation:

```bash
npm test
```

For installed-CLI comparison and capture integration tests:

```bash
npm ci --prefix validation --ignore-scripts --no-audit --no-fund
npm run test:shim
npm run test:capture
```

Capture integration tests create temporary consumer repositories and install real packages; they need registry access. These local tests do not send PR comments. CI also exercises the reusable workflow and standalone artifact downloads on GitHub.

## Code map

| Area | Files |
| --- | --- |
| Consumer install templates | `examples/` |
| Capture and publisher workflows | `.github/workflows/reports.yml`, `.github/workflows/publish.yml` |
| Discovery and input normalization | `src/discover.mjs`, `src/capture.mjs` |
| Capture orchestration and summaries | `src/workflow.mjs` |
| Exact baseline lookup/rebuild and comparison | `src/baseline.mjs`, `src/comparison.mjs` |
| Manifest identity and file checks | `src/evidence.mjs`, `src/baseline-evidence.mjs` |
| Publisher policy and authenticated source expectations | `src/publisher-source.mjs` |
| Artifact admission and extraction | `src/publisher-artifacts.mjs`, `src/extract-*.py` |
| Comment rendering, ownership, and freshness | `src/publisher.mjs` |
| Standalone HTML and documentation footer | `src/presentation.mjs`, `src/documentation.mjs` |
| Core and adversarial tests | `test/` |
| Installed-package and hosted tests | `integration/`, `validation/test/` |

## Adding an option or feature

1. Define the behavior, default, and failure state. Keep missing/failed/incompatible results explicit.
2. For a capture input, update the reusable workflow declaration and `normalizeInputs` in `src/capture.mjs`. Decide whether it changes execution identity, baseline eligibility, or publisher expectations; update those together.
3. For publisher policy changes, update `publisherPolicy` and authenticated expectation derivation in `src/publisher-source.mjs`. Never derive trusted expectations from uploaded artifacts.
4. Update the relevant consumer templates, [configuration reference](docs/configuration.md), and quick start if installation changes. Keep the README comment example aligned with `renderComment` when presentation changes.
5. Run `npm test`. Add focused tests for changed behavior, including invalid inputs. Run the installed-CLI suites for capture/comparison changes and exercise hosted handoffs when changing workflow/artifact behavior.

For execution, retention, or publishing changes, include adversarial cases for identities, path traversal, tampering, stale runs, and permissions as applicable. Docs-only work should check links and examples without adding redundant behavior tests.

## Local discovery and comparison

Inspect tracked projects without executing configuration:

```bash
npm run discover -- <full-target-base-sha> <full-pr-head-sha> /path/to/repository
```

To exercise the temporary comparison adapter after installing validation dependencies:

```bash
mkdir -p validation/.output
npm run validate:compare -- --allow-internal-beta10 validation/fixtures/before.json validation/fixtures/after.json validation/.output/example
```

The output directory must be new. This writes comparison JSON/HTML and a validation receipt. [Fixture notes](validation/fixtures/README.md) describe the retained inputs; they are not a fresh PR pair.

The adapter verifies the isolated lockfile and byte pins before loading beta.10 internals. Keep its explicit opt-in, receipt, and rejection tests. When the supported interface tracked in [Pulse #503](https://github.com/pulse-compute/pulse/issues/503) is available, replace the adapter, rerun equivalent tests, and remove the internal loader/pins/isolated dependency installation. Do not silently repin it or use it as a production fallback.

## Pull requests

Explain the resulting behavior, relevant compatibility or permission changes, and what you tested. Keep sprint logs, implementation queues, and one-off validation records in issues/PRs; repository docs should describe installation, current behavior, and maintenance. Preserve test fixtures and their provenance when they are required for reproducible checks. Release tags, consumer installation, and repository settings are separate actions.
