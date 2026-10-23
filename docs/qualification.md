# RA-04 qualification progress

Status: the external npm consumer report/comment flow passed validation. RA-04
remains open; this
record does not authorize an action release or a `v1` tag.

This record contains outcomes and tool versions only. Consumer identifiers, URLs,
source revisions, run/artifact/comment identities, raw logs, screenshots and
report contents are intentionally omitted. Original provenance is retained
separately. No withheld identity is replaced with synthetic provenance.

## Qualified configuration

- Reviewed reusable-workflow source:
  `0408c9c4393f9ba889c5f371ea803105535d31a5` in this repository.
- Published Pulse CLI/runtime/provider dependency baseline: `1.0.0-beta.10`.
- Hosted capture: Node `v24.18.0`, npm `11.16.0`, Fastly Native profile.
- Exact npm lockfile installation with lifecycle scripts disabled and an ignored
  asset-generation setup command.
- Public tooling called across owners without an extra tooling-read secret.
- Capture permissions: contents/actions read. The separately installed
  default-branch publisher alone requests pull-request write permission.
- Comparisons explicitly opt into the byte-pinned internal beta.10 adapter for
  validation. No supported public comparison interface is implied.

## Observed results

| Check | Evidence class | Result |
| --- | --- | --- |
| Source change outside `.pulse/` selects the root project | Hosted consumer PR | Passed |
| Native head JSON and standalone HTML capture | Hosted consumer PR | Passed |
| Missing approved-push evidence rebuilds the exact merge-base | Hosted consumer PR | Passed |
| Approved-branch baseline capture and later exact retained reuse | Hosted push and PR | Passed |
| Shared-engine comparison with JSON/HTML and validation receipt | Hosted consumer PR | Compatible |
| Actual Node/npm identity matches trusted publisher policy | Downloaded capture metadata | Passed |
| Archive size/digest, bounded extraction and file inventory/hash checks | Downloaded real artifacts and production admission | Passed |
| Retained producer origin/current attempt and equality of comparison base bytes | Authenticated metadata and production admission | Passed |
| Deliberate comparison-file mutation | Real downloaded bundle, local negative check | Rejected; original bytes restored and reverified |
| Default-branch publisher uses trusted policy/mode despite proposed PR enablement | Real `workflow_run`, explicit dry-run result | Passed; no comment created |
| Live bot-comment creation | Hosted consumer PR, publisher result and authenticated bot comment | Passed |
| Subsequent head/run updates the same bot comment without duplication | Second hosted capture, publisher update result and authenticated comment state | Passed |

Capture/comment validation concerns orchestration and evidence presentation.
It does not qualify application runtime semantics, deployed provider behavior,
performance, arbitrary project-code trust or a consumer release.

## Remaining RA-04 obligations

- Real external-fork comment permissions and stale completion/rerun ordering.
- pnpm consumer installation and monorepo/shared-lockfile cases; live
  config addition/removal/rename, nested-project and no-op cases. Existing
  discovery/integration fixtures do not substitute for that consumer matrix.
- Hosted failed head/base capture, expiry/unavailability and transient artifact
  visibility/transport handling. Existing adversarial/local tests retain their
  separate evidence class; retry only transient transport/visibility failures,
  never identity or digest mismatches as successes.
- Interactive offline opening of both downloaded report and comparison HTML.
  Local browser execution was unavailable; standalone file generation and byte
  checks do not establish browser interaction.
- A released supported public comparison adapter from
  [Pulse #503](https://github.com/pulse-compute/pulse/issues/503), replacement of
  the internal shim and repeat qualification through that public interface.

The consumer installation uses the documented SHA/policy pins, retention and
upgrade/rollback procedure. Reports/comparisons and upload bindings expire after
30 days; plans after 14 days. A changed tooling SHA or execution recipe can force
an exact baseline rebuild. Public tooling does not publish consumer artifacts.

No release tag, deployment, provisioning, visibility or repository-access setting
change is part of this qualification record. Human release remains separate.
