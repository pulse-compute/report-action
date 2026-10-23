# Retained report fixtures

These are unmodified retained `01-hello-json` report capsules from earlier
website work. They validate the shim against real serialized evidence, not
invented measurements. They are not a newly built PR baseline/head pair.

- `before.json`: retained `w46-final-reports/01-hello-json.json`, producer
  `1.0.0-beta.9`, SHA-256
  `25f7ed4e8032ed65e56975d8bd35d2445168b7b3363a709fa5b1454a559a3f82`.
- `after.json`: retained `website-beta10-release-reports/01-hello-json.json`,
  producer `1.0.0-beta.10`, SHA-256
  `322099bc22ad506d4ecaff06ba1ab4a25b89f3201ccde83b3ebdd341c22b450a`.

Both capsule revisions remain null. Their measured primary artifact sizes
are both 2,273 bytes. The shared engine reports `different-build` and retains
metadata differences. The zero byte delta is an actual observation in these
fixtures; it does not establish equivalent toolchains or a code-change result.

The validation tests also compare `after.json` to itself as a genuine no-change
control. Invalid-input cases are constructed only in temporary test directories.
