# Release profiles

One JSON file per released version. `scripts/verify-release.mjs` is the engine; a profile is
everything about a release that is not the engine.

Until 1.0.0-rc.4 each release had a gate script of its own — `verify-v05.mjs`,
`verify-v06.mjs`, `verify-v07.mjs`, `verify-v08.mjs`, `verify-release.mjs` — and the four
older ones were copies of each other differing in a step list and a handful of constants.
1.0.0-rc.5 keeps one script and puts the differences here. The deleted scripts are in the git
history; what they *ran* is in this directory, taken from the manifests they wrote.

## The current release

`1.0.0-rc.5.json` is read by the gate on every run. It carries:

- **`constants`** — the benchmark baseline (file, commit, label, rounds, registered
  improvements), the `any` budget, the inventory records this source must be identical to and
  the increment registered against each, and the mutation-audit record the gate reads.
- **`steps.dev`** — what `--dev` runs, in order. **`steps.release`** — what `--release` adds
  after it. The last step of either run is `release-profile`, which compares the steps the run
  actually recorded with these lists and fails when they differ. A gate that quietly stops
  running a check is a defect of the gate, and only the list can see it.

Changing what a release is measured against is an edit to this file, reviewable on its own,
rather than an edit buried in a 700-line script.

## Earlier releases

`0.5.0.json` … `1.0.0-rc.4.json` are records, not scripts. Each was extracted from that
release's own manifest (`validation/<version>-release/manifest.json`) and carries the commit,
the source fingerprint, the status and every step with the exact command line it ran.

To reproduce one: check out the commit the profile names, install from its lockfile, and run
the commands in `steps` in order — that release's gate script is in the history at that commit,
so `node scripts/verify-v07.mjs --release` (or whichever `gate` the profile names) is the
short way. The step list is here so that the *contents* of a past run can be read, compared
and cited without unpacking an archive or checking out a tree.

| profile | commit | steps | fingerprint |
|---|---|---:|---|
| `0.5.0` | `e174c57` | 34 | `8d2c5b9d…` |
| `0.6.0` | `f019402` | 39 | `c7a83b6a…` |
| `0.7.0` | `1abe595` | 40 | `673d7636…` |
| `0.8.0` | `38a722e` | 42 | `fadb4a93…` |
| `1.0.0-rc.1` | `77d6440` | 43 | `e90606c5…` |
| `1.0.0-rc.2` | `46b344f` | 52 | `03bc5469…` |
| `1.0.0-rc.3` | `5ae7baf` | 53 | `b8f89b73…` |
| `1.0.0-rc.4` | `e96871b` | 53 | `fce61dd3…` |
