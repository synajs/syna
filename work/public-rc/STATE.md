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

1. **The workspace keeps its own version line; the packages restart.** The gate names the source archive and the
   release profile after the version in the root `package.json`, and used to name the validation directory after it
   too. Setting that to `1.0.0-rc.1` would have overwritten `validation/v1.0.0-rc.1-release/` — a record five later
   profiles and this round's inventory chain still refer to. So the private workspace went to `1.0.0-rc.6` (its sixth
   gate round of the 1.0 line) and the two published packages start at `1.0.0-rc.1`. The release profile carries the
   mapping (`scripts/release-profiles/1.0.0-rc.6.json`, `constants.packages`), and the gate asserts the packed
   tarballs are exactly those packages.
1a. **The public evidence has a lineage of its own.** Naming this release's evidence `validation/v1.0.0-rc.6-release/`
   told a reader that the evidence for `syna@1.0.0-rc.1` was filed under a number that is not the package's — and left
   the next public candidate no place to go. The profile now names the directory as well
   (`constants.validation`): `validation/public/syna-v1.0.0-rc.1-release/`, and `validation/public/syna-v1.0.0-rc.2-release/`
   after it. The top-level `v<version>-*/` directories are the repository's own rounds and are untouched — nothing was
   deleted, renamed, moved, renumbered or rewritten. `scripts/validation-doc.mjs`, the CI artifact and the two name
   scans (a recorded run is a record in either lineage) follow the profile; `validation/README.md` states the
   distinction. The gate's own `previousRelease` key keeps the run-to-run comparison across the move.
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
- `node scripts/verify-release.mjs --release` — COMPLETE, recorded on `7401ce9` under
  `validation/v1.0.0-rc.6-release/`. That run stays where it is: it is the repository's sixth 1.0 round, and the README
  changed after it (`9af39ff`), so its fingerprint no longer holds on the tree.
- **The release run of reference**: `node scripts/verify-release.mjs --release` on `5cf16ef` (clean checkout, the
  commit that separates the lineages) — **COMPLETE**, 62 steps, 0 failed, 0 skipped, 1166 test executions (583 distinct
  cases, 583 re-run in the copy unpacked from the source archive), 1166 passed; 404 source files, fingerprint
  `f8383620…`; PostgreSQL 17.10 in a temporary cluster. Evidence `validation/public/syna-v1.0.0-rc.1-release/` and
  `RELEASE_MANIFEST.json`; `docs/VALIDATION.md` generated from it. Inventory 374 items, identical to the 1.0.0-rc.5
  record (0 added, 0 removed, 0 changed) and to the frozen 0.8.0 record up to the three items registered in rc.3, 0
  `@deprecated`. Mutation record: 2 mutants, 0 survived, 6 input files. Same-machine benchmark against 1.0.0-rc.4:
  139/139 rows within ±10 %, largest deviation 4.2 %. `pack-metadata` 0 problems on both tarballs; the README's own
  project, built with `syna-1.0.0-rc.1.tgz` as its only dependency, 0 problems. No attempt was repeated and nothing was
  re-run: the gate passed on the first run of this tree. Superseded by the run below, which carries the cleaned root.
- **The release run of reference** (final): the same command on `4e7bcb5` (clean checkout, the root cleanup and the
  tag archival) — **COMPLETE**, 62 steps, 0 failed, 0 skipped, 1166 test executions (583 distinct cases, 583 re-run in
  the unpacked copy), 1166 passed; 404 source files, fingerprint `2935e751…`; PostgreSQL 17.10 in a temporary cluster.
  Same step list and the same per-step test counts as the run it replaces. Inventory 374 items, identical to the
  1.0.0-rc.5 record and to the frozen 0.8.0 record up to the three items registered in rc.3, 0 `@deprecated`; mutation
  record 2 mutants, 0 survived, 6 input files; benchmark 139/139 within ±10 %, largest deviation 4.8 %;
  PostgreSQL/matrix 45/45 in the workspace and 45/45 again in the copy unpacked from the archive; `pack-metadata` 0
  problems; README consumer 0 problems. Passed on the first run of this tree.
  - Both source archives are new (`e5894e74…`, `9a7fb4fa…`): they carry the edited scripts and documents. The two
    package tarballs were re-packed by this run and came out byte-identical to the previous run's
    (`ba676329…`, `3d88e537…`) — the cleanup touched nothing inside `packages/core` or `packages/tsconfig`, and
    `npm pack` is deterministic over identical content. Same bytes, freshly produced; not a reused hash.

## For whoever publishes

- `npm publish --tag rc` in both package directories (above), from an account that is a member of the `@synajs`
  organisation on npm.
- **The tag name `v1.0.0-rc.1` is free again.** It pointed at `4a5a978` — the release of the earlier candidate under
  the temporary identity, not the package now being prepared. That history is preserved under
  `archive/pre-public-v1.0.0-rc.1`, which is the *same annotated tag object* (`8a7ff02`, the original tagger, date and
  message) and peels to the same commit; the archive tag was confirmed on `origin` before the old name was deleted
  there and locally. The commit itself and every validation record of it are untouched.
- The public `v1.0.0-rc.1` tag is **not** created here. It is to be created later against the exact provenance commit
  of the final gate run, so that the tag and the recorded fingerprint name the same tree.

## The root, before publishing

The workspace root carried the 0.5 Claude Code task package — the execution prompt, its goal file, the Chinese
starting guide, the research note and the `SHA256SUMS.txt` that pins the four. It was never part of the source archive
or the fingerprint (`listSourceFiles`), but it was the first thing a visitor to the repository saw, and it describes a
round that ended five candidates ago. It moved as one unit to `work/v05/task-package/`, where the rest of that round's
ledger already lives; its own hash list moved with it and still verifies from there. The audit reports, the validation
records and the older ledgers that say those files were at the root are left exactly as they are: they describe where
the files were at the time, which is what a record is for.

Not done, by instruction: no `npm publish`, no public release tag, no GitHub Release.

## The name npm accepted — `synajs`（最终包名）

Everything above was prepared for the unscoped name `syna`, and that name was never published: when the publish was
attempted npm rejected it under its package-name similarity policy — a refusal that `npm view syna` (E404 throughout the
preparation) could not show in advance. The runtime package is **`synajs`**; `@synajs/tsconfig` is unchanged. The
registry before this round: `npm view synajs` → E404 (unregistered; not owned by anyone, which is not a guarantee of
publishability), `npm view syna` → E404, `npm whoami` → E401 (no credential in this environment), `npm view
@synajs/tsconfig` → `1.0.0-rc.1` already on the registry under the project's own maintainer.

What changed is the npm identity and every current surface that names it — manifests, lockfile, imports, the two
READMEs, the current documents, the release profile, the gate's consumer projects and tarball audit, and the
package-name scan, which now rejects `syna` as a package. `packages/core/src` is untouched; the API inventory, the
mutation audit, the benchmark thresholds and the PostgreSQL/matrix suites are the same checks. The run recorded above
stays as `validation/public/syna-v1.0.0-rc.1-release/`, immutable; the release run of `synajs@1.0.0-rc.1` is
`validation/public/synajs-v1.0.0-rc.1-release/`, fresh archives, fresh tarballs, fresh hashes, with the earlier run
named as the one it continues from. Still not done, by instruction: no `npm publish`, no `v1.0.0-rc.1` tag, no GitHub
Release; `archive/pre-public-v1.0.0-rc.1` untouched.

## The README that ships — evergreen wording（最终文案）

The README inside the runtime tarball is immutable once `synajs@1.0.0-rc.1` is published, and until this round it said
the first public RC "is being prepared" / "正在准备中" — true during preparation, false the moment the tarball is on the
registry. Four sentences changed and nothing else: the install section says to install the 1.0 release candidate from
the npm `rc` tag, and the status section says `synajs@1.0.0-rc.1` is the first public release candidate of Syna, with
the API frozen and the earlier names and candidates in the history; the Chinese README carries the same meaning. No
sentence claims a registry event. `packages/core/README.md` is the synced copy (`npm run readme:sync`, byte for byte),
the executable blocks and their documented output are untouched, and the README tests pass (8/8).

The gate ran again on that commit (`63a30ed`, clean checkout): COMPLETE, 62 steps, 0 failed, 0 skipped, 1168 test
executions, source fingerprint `d028549ab893fac497ec1cb0754da53a3f187281213177cb0107c2966b85be92` (404 files); the
API inventory, the mutation audit, the benchmark comparison (139/139 rows within the tolerance, largest deviation
4.1 %), PostgreSQL/matrix (45/45 twice), the archive rebuild, the packed consumer and the README consumer are the same
checks with the same results. Fresh archives, fresh tarballs, fresh hashes in `SHA256SUMS.txt`; the only payload
difference from the previous run's runtime tarball is `package/README.md`. The tsconfig tarball is byte-identical to
the previous local run because `packages/tsconfig` did not change; `@synajs/tsconfig@1.0.0-rc.1` is already on the
registry and is packed and validated here, not republished.

Tarball bytes across environments: the CI gate on the previous commit (Node 22, Linux) produced a `synajs-tsconfig`
tarball whose decompressed tar stream is byte-identical to the local one (same entries, same headers, same tar
SHA-256), while the gzip bytes differ — a different deflate implementation, not a different package. The CI gate on the
evidence commit (`2fc9bef`, run 37990683494, COMPLETE 62/62, 1168 tests, Node 22, PostgreSQL 16) confirms it for the
runtime tarball too: `synajs-1.0.0-rc.1.tgz` is 138197 bytes locally (sha256 `9c3acc3c…`) and 138336 bytes from CI
(sha256 `27e6b6b0…`), and the two decompress to the same tar stream (sha256
`361f20fa79c3fba5b8b6443902985fd031ac1fcab735528abafb326649f5be97`): 103 entries, identical names, modes, times,
owners and contents, identical `package.json`. The difference is the deflate encoder, not the package; the packaging
is not redesigned to force byte-identical archives across environments, and the hashes in `SHA256SUMS.txt` remain those
of the local run that produced the manifest. Still not done, by
instruction: no `npm publish`, no republish of `@synajs/tsconfig`, no `v1.0.0-rc.1` tag, no GitHub Release.
