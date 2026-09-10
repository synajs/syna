# Working in this repository

This page is for people working **on** Syna. Using Syna needs none of it: `npm install syna@rc` and the
[README](README.md).

The workspace is private and carries its own version — the validation line of the release gate — while the two packages
it publishes are `syna` and `@synajs/tsconfig` (`packages/core`, `packages/tsconfig`), released in lockstep.
`docs/HISTORY.md` has the rounds; `docs/VALIDATION.md` the recorded run of the current one.

## Requirements

- Node.js ≥ 22 (developed and validated on Node 26; CI matrix 22/24)
- npm (workspaces + `package-lock.json`; the only package manager used here)
- PostgreSQL 17 client/server binaries (`initdb`, `pg_ctl`, `psql`) for the real-database tests of the reference
  application, or a test database URL in `SYNA_TEST_PG_URL`. Docker is not required, and PostgreSQL is a requirement of
  these tests, never of Syna.

## Install, build, test

```sh
npm ci
npm run build          # tsc -b for every package, example and app; never trust a checked-in dist (there is none)
npm run typecheck      # strict project build + compile-time API tests
npm test               # core behaviour/regression suites (node:test)
```

Application, tooling and PostgreSQL tests:

```sh
npm run test:app        # the reference application on the filesystem backend, site manager, preflight, review and audit regressions
npm run test:scripts    # gate tooling, deprecation list, name scans, the README's own programs, any-count budget
npm run test:postgres   # real PostgreSQL: a temporary cluster is created under work/pg and removed afterwards
```

## The seven examples

`apps/01-basics` … `apps/07-failure-modes`: one fictional domain — a multi-tenant notification delivery service — one
question each, in reading order. Every program asserts its own results, exits non-zero when one fails, prints the stable
lines its README lists, and is a step of the release gate. `docs/EXAMPLES.md` has the organisation, the fixtures and the
naming rule.

| example | the question it answers |
|---|---|
| `apps/01-basics` | How do I define the pieces of a service, connect them, and run them in a world that opens and closes cleanly? |
| `apps/02-per-tenant` | Each tenant needs its own provider client and outbox while the pool and the logger stay shared — without a named scope. |
| `apps/03-user-configurable` | Let a tenant choose its provider, store the choice, and get that provider on the next request. |
| `apps/04-two-versions` | The provider shipped SDK 2.x; tenants that chose it under 1.x keep working while new tenants get 2.x. |
| `apps/05-scheduled-jobs` | A scheduler inside the service opens one digest world per tenant, typed and closed when done. |
| `apps/06-testing` | Replace the real provider in an integration test without touching the program under test. |
| `apps/07-failure-modes` | What happens when a setup fails, hangs, or the world closes under it — and what do I read? |

```sh
npm run demo        # builds, then runs all seven; each ends with `<name>: OK`
npm run demo:03     # one of them
```

## Reference application

`apps/multitenant-blog` (`@syna-app/multitenant-blog`) is the narrow but complete multi-tenant blog engine that drove
the kernel: real PostgreSQL and real filesystem backends × dynamic HTTP and static builds, three Markdown recipes
sharing one set of remark/rehype factory slots, two tenants with domain mapping and replaceable authentication, and a
bounded, leased working set of site worlds. `docs/MULTITENANT_BLOG.md` documents it and `docs/PLUGIN_AUTHORING.md` its
plugin protocol; read the examples first, the application when a question is about scale, resources or an operating
boundary.

```sh
# three cells — HTTP alpha, HTTP beta, static alpha — on the filesystem backend; exit 1 unless every cell answers 200 with the tenant's page
npm run demo:multitenant-blog
# the same on the PostgreSQL backend, on a temporary cluster
node scripts/pg-test-cluster.mjs with -- node apps/multitenant-blog/bin/multitenant-blog.mjs demo --backend postgres
# development server (seeds fixtures when empty, runs the startup preflight, starts the worker)
node apps/multitenant-blog/bin/multitenant-blog.mjs serve --root /tmp/blog-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
# static build of one tenant; explain one request world and its fork budget
node apps/multitenant-blog/bin/multitenant-blog.mjs build --root /tmp/blog-content --tenant alpha --out /tmp/blog-alpha
node apps/multitenant-blog/bin/multitenant-blog.mjs explain --root /tmp/blog-content --tenant alpha
```

Stop the server with Ctrl-C (the worker stops, site environments drain, shared resources close last). Clean up with
`rm -rf /tmp/blog-content /tmp/blog-alpha` and `node scripts/pg-test-cluster.mjs stop` if a cluster was left running
(`SYNA_PG_KEEP=1`).

## Release gate

Acceptance orchestrator (transparent runner; every sub-command is spawned and recorded with exit code, timing, TAP
counts and log path). What it measures against — the benchmark baseline, the inventory records, the `any` budget, the
mutation record, the two published packages and the ordered list of steps — is the release profile of the workspace
version, `scripts/release-profiles/<version>.json`.

```sh
node scripts/verify-release.mjs --dev       # G0: build, type tests, core, the application on real PostgreSQL/FS and its matrix, tooling,
                                            #     API inventory, codemod idempotency, the name scans, the any budget, the seven examples,
                                            #     the three-cell demo, benchmarks + the same-machine comparison
node scripts/verify-release.mjs --release   # G0 + G1: source archive, rebuild from the archive in an empty directory (suites, examples and
                                            #     demo again), pack + tarball audit, the packed-package consumer and the README's own
                                            #     programs in a project built from the README, RELEASE_MANIFEST.json + SHA256SUMS.txt
node scripts/validation-doc.mjs             # docs/VALIDATION.md from the run that is meant to be the record
```

`--release` prints `COMPLETE`, `PARTIAL` or `BLOCKED` and exits 0 only on `COMPLETE`. A missing PostgreSQL never becomes
a skip; it is `BLOCKED`. The tooling never publishes, tags or pushes.

The benchmark comparison is machine-sensitive by construction: it runs both sides in one session under `--no-maglev`
and compares element-wise medians of 21 interleaved rounds. A round in which the *machine* stalls fails the run rather
than the code — re-run it on a quiet machine; widening a threshold or registering an exemption to get past one is not
the remedy.

## Documents and records

- `docs/` — the manual (API reference, semantic model, glossary, authoring guides) and the records (history,
  migrations, audits, validation).
- `validation/v<version>-<mode>/` — one gate run each: its manifest, logs, API inventory and scans. Records, never
  edited afterwards.
- `work/` — the ledgers of each round (task books under `work/tasks/`, the state and decisions of the round). Never in
  a source archive.
- `RELEASE_MANIFEST.json` — the release run of reference, with the archive and package digests.

Historical documents keep the names of their own time: the runtime was developed under the temporary package identity `@syna/core` and its presets under `@syna/tsconfig`. <!-- syna-public-rename: this line names the earlier packages on purpose -->
The records are not rewritten; what must not appear in a *current* file is a package a reader could try to install —
`scripts/lib/package-name-scan.mjs` is the check and `scripts/tests/no-legacy-package-names.test.mjs` its test.
