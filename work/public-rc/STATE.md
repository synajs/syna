# syna 1.0.0-rc.1 — working state

Task book `work/tasks/SYNA_PUBLIC_RC_EXECUTION_PROMPT.md` (goal `work/tasks/SYNA_PUBLIC_RC_GOAL.txt`). Baseline
1.0.0-rc.5 = commit `5170dd3` (the gate on `64f5221`; `work/rc5/STATE.md` and the two fixes committed after it).

Two things had to happen together: the npm identity the runtime is published under, and a README written for someone
who has never heard of Syna. Neither touches the runtime — `packages/core/src` is byte-identical to the baseline.

## Phase 0 — the registry, before anything was renamed

```
npm view syna                → E404 (the name is unregistered)
npm view @synajs/tsconfig    → E404 (the name is unregistered)
registry search scope:synajs → 0 packages
npm whoami                   → E401 (the token in ~/.npmrc is expired)
```

Neither identity is taken, and no third party publishes under `@synajs`. What could **not** be verified from here is
publish *permission*: the local npm credential is expired, so the account behind it could not be asked what it may
publish. That is a prerequisite of the publish itself, not of this round, which publishes nothing.

When the time comes: `npm login`, then **`npm publish --tag rc`** in `packages/core` and in `packages/tsconfig`. The
tag matters — the README tells a reader to run `npm install syna@rc`, and that resolves only if the release is
published under the `rc` dist-tag; publishing a candidate as `latest` would hand it to everyone who types
`npm install syna`. `@synajs/tsconfig` carries `publishConfig.access: public` (a scoped package is restricted by
default); an unscoped `syna` is public already. The `@synajs` organisation has to exist on npm and the account has to
be a member of it; the GitHub organisation `synajs` exists and owns this repository, which is where the name comes
from.

## The decisions

1. **The workspace keeps its own version line; the packages restart.** The gate names the validation directory, the
   source archive and the release profile after the version in the root `package.json`. Setting that to `1.0.0-rc.1`
   would have overwritten `validation/v1.0.0-rc.1-release/` — a record five later profiles and this round's inventory
   chain still refer to. So the private workspace went to `1.0.0-rc.6` (its sixth gate round of the 1.0 line) and the
   two published packages start at `1.0.0-rc.1`. The release profile carries the mapping
   (`scripts/release-profiles/1.0.0-rc.6.json`, `constants.packages`), and the gate asserts the packed tarballs are
   exactly those packages.
2. **The npm rename renames no identity the runtime serializes.** `packages/core/src/runtime.ts` still declares the
   internal package as `@syna/core` and its internal derive Entry as `@syna/core/entry/derive/v1`. Those are nominal
   ids — they appear in plans, inspections and stored references — and they are frozen like every other
   (`docs/API_STABILITY.md`). A second reason not to touch that file: it is one of the six inputs of the mutation
   record (`work/rc5/mutations/RESULTS.json`), which is hash-pinned, and a record produced from other sources is stale
   rather than evidence.
3. **One README, and it runs.** The root `README.md` is canonical and `packages/core/README.md` is a byte-identical
   copy, so GitHub and npmjs.com show the same page; the gate compares the copy inside the packed tarball as well. The
   document's `package.json`, `tsconfig.json` and two programs are read out of it (`scripts/lib/readme-programs.mjs`)
   and executed twice — in the workspace, and in a project the gate builds from the README alone whose only dependency
   is the packed tarball. Links are absolute so they resolve on npm; the code and output blocks of `README.zh-CN.md`
   are the same blocks, asserted.
4. **The contributor material moved rather than disappeared.** What the old README carried for people working *on*
   Syna — requirements including PostgreSQL, the build/test commands, the seven examples, the reference application,
   the gate — is `CONTRIBUTING.md`, linked from the README's documentation map and part of the source archive.
5. **`@synajs/tsconfig` is not a runtime requirement.** The README's `tsconfig.json` is a plain standalone one; both
   consumer projects of the gate assert that nothing of this workspace was installed beside the runtime.

## What the gate gained

| step | what it asserts |
|---|---|
| `no-legacy-package-names` | no current file installs, imports or extends `@syna/core` or `@syna/tsconfig`; records excepted by name, the two lines that spell one on purpose allowed by literal, the lines that explain the rename marked `syna-public-rename` — all listed in `package-name-scan.json` |
| `pack-metadata` | both tarballs are the packages the profile declares (name, version, filename); the runtime ships `package.json`, `README.md`, `LICENSE` and `dist/` and nothing else; it asks a consumer for no package of this workspace; its README is the canonical one |
| `readme-consumer-install/build/main/tenants/result` | the README's own project, built from the README with the packed tarball as its only dependency, prints what the README says it prints, and installed nothing of this workspace |

`scripts/tests/no-legacy-package-names.test.mjs` and the rewritten `scripts/tests/readme-example.test.mjs` are the
self-tests of the two, in `gate-self-tests` (51 cases).

## Acceptance

- `node scripts/verify-release.mjs --dev` — COMPLETE, 581/581, 0 failed, 0 skipped (`validation/v1.0.0-rc.6-dev/`).
- First `--release` run: PARTIAL on `benchmark-compare` alone. Round 8 of 21 failed on the **baseline** side (the
  exported 1.0.0-rc.4 source, untouched by this round): every case of that one process was ~20× its usual value
  (`bound-entry-…` p95 0.19 ms → 4.62 ms against its 1 ms budget, `site-enter-…` 0.23 ms → 3.80 ms), while the current
  side of the same round was 0.185 ms / 0.235 ms. A machine stall in one process, not a regression — the run was
  repeated on a quiet machine. No threshold, exemption, statistic or workload was changed.
- `node scripts/verify-release.mjs --release` — COMPLETE (see `RELEASE_MANIFEST.json` and
  `validation/v1.0.0-rc.6-release/`).

## For whoever publishes

- `npm publish --tag rc` in both package directories (above), from an account that is a member of the `@synajs`
  organisation on npm.
- **The tag name `v1.0.0-rc.1` is taken.** It is on `origin` already, pointing at `4a5a978` — the release of the
  earlier candidate under the `@syna/core` identity. A tag for this release needs another name; the workspace version
  (`v1.0.0-rc.6`) or the package identity (`syna-v1.0.0-rc.1`) both say which release it is.

Not done, by instruction: no `npm publish`, no git tag, no GitHub Release.
