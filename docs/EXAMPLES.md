# Examples (EXAMPLES)

Seven runnable programs under `apps/01-basics` … `apps/07-failure-modes`, one fictional domain, one question each, in reading order. Every program asserts its own results and exits non-zero when one fails; its last line is `<name>: OK`; each is a step of the release gate (`scripts/verify-release.mjs`, `demo-01-basics` … `demo-07-failure-modes`) that must print the stable lines the program's README lists. `npm run demo` builds and runs all seven; `npm run demo:01` … `npm run demo:07` run one.

The domain is a multi-tenant notification delivery service: tenants, providers, notifications, deliveries. A provider's client is a Service that owns a connection and closes it; "can send a notification" is a Contract; which provider a tenant chose is a Binding stored as JSON; the current tenant is an Input; a daily digest is a child world a Service opens by itself; the provider's SDK 2.x is a second revision of the same Family. The programs show the mapping; no Syna concept appears as a business name.

## The seven programs

| directory | the question it answers | what the code shows |
|---|---|---|
| `apps/01-basics` | How do I define the pieces of a service, connect them, and run them in a world that opens and closes cleanly? | `define.service` with `requires` and `setup`, `onDispose` closing what the setup opened, `define.entry`, `runtime.run()`; an eager `Logger` starts first and closes last. No Contract, no Binding, no Input. |
| `apps/02-per-tenant` | Each tenant needs its own provider client and outbox while the pool and the logger stay shared — without a named scope. | `CurrentTenant` as an Input read by the pieces that are per tenant; child worlds (`AppEntry` → `TenantEntry` → `SandboxEntry`); `env.explain()` listing what a world would create or fork and why; `reuse: { share }` refusing a fresh pool (`SHARE_CONSTRAINT_FAILED`). No Contract, no Binding. |
| `apps/03-user-configurable` | Let a tenant choose its provider, store the choice, and get that provider on the next request. | The `Notifier` Contract and `provides`; a Binding (`define.binding`), `to()` / `parse()` and the one serialized shape of an `ImplementationRef`; a settings page built from `Notifier.all`; a malformed stored choice refused (`INVALID_DESCRIPTOR`). One revision per provider. |
| `apps/04-two-versions` | The provider shipped SDK 2.x; tenants that chose it under 1.x keep working while new tenants get 2.x. | Two revisions of one Family admitted together, `catalog.implementations()` / `catalog.revisions()`, `revision.range()` from the 1.x code, a stored range that no admitted revision satisfies (`MISSING_IMPLEMENTATION`). |
| `apps/05-scheduled-jobs` | A scheduler inside the service opens one digest world per tenant, typed and closed when done. | A Service depending on an Entry gets an `AnchoredEntry`: `check()` during its own setup, `run()` after the owner is Ready, a child world per tenant with its own `DigestJob` Input; entering from inside setup refused (`OWNER_NOT_READY`). |
| `apps/06-testing` | Replace the real provider in an integration test without touching the program under test. | `override(AcmeNotify, RecordingNotifier)` at Runtime construction; the same program under the real and the fake Runtime; the fake records every send. |
| `apps/07-failure-modes` | What happens when a setup fails, hangs, or the world closes under it — and what do I read? | A sticky failure, `failure: { attempts, delayMs, afterExhaustion, cooldownMs }`, `loadTimeoutMs` and `LOAD_TIMEOUT` with the attempt still running, `disposalGraceMs` and an abandoned attempt, a setup wait cycle; the error codes and the `details` fields to read, the `RuntimeEvent`s to listen for. |

Each program is `apps/0N-<name>/src/index.ts` (package `@syna-demo/0N-<name>`, `syna.id` `demo.examples.<name>`); its `README.md` opens with the problem, without Syna internals, then "What the code shows", "Run" and "What it prints".

## The fixtures

The programs share six packages under `packages/`, all `private` (never published), all in the same domain:

| package | version | `syna.id` | exports |
|---|---|---|---|
| `@syna-demo/notify-contract` | 1.0.0 | `demo.notify.contract` | the `Notifier` Contract (`send(notification) → Delivery`), the `Notification` / `Delivery` types, the `CurrentNotification` Input |
| `@syna-demo/acme-notify-v1` | 1.8.4 | `demo.notify.acme` | `AcmeNotify` (`provides: [Notifier]`; requires `CurrentTenant` and `Logger`): `send()` |
| `@syna-demo/acme-notify-v2` | 2.4.1 | `demo.notify.acme` | `AcmeNotify` of the same Family: `send()` and `sendBatch()` |
| `@syna-demo/globex-notify` | 3.1.0 | `demo.notify.globex` | `GlobexNotify` (`provides: [Notifier]`), the second Family |
| `@syna-demo/tenant-store` | 1.2.0 | `demo.tenant-store` | `TenantStore` (a fake connection pool over a directory; `onDispose` closes it), its `TenantStoreConfig` Input, the `CurrentTenant` Input and the `Tenant` type |
| `@syna-demo/logger` | 1.1.0 | `demo.logger` | `Logger` (eager; owns a sink it closes itself) |

`acme-notify-v1` and `acme-notify-v2` are one package at two versions under two local directories (`docs/PACKAGE_AUTHORING.md`, "Stable exports"): the same `syna.id`, hence one Family with two revisions.

## Naming rule（命名规则）

示例使用虚构名字；只有代码真的与某个产品交互时才使用它的真名。

The examples use fictional names; a real product's name appears only where the code really interacts with that product. Acme and Globex are the stock fictional companies; infrastructure packages are named for their function (`tenant-store`, `logger`). The reference application `apps/multitenant-blog` names PostgreSQL, `pg`, `remark`, `unified` and `rehype` by their real names because it really uses them. The release gate's must-run step `no-vendor-names` (`scripts/lib/vendor-name-scan.mjs`; `scripts/tests/no-vendor-names.test.mjs`) scans every current file for a real vendor name used as a fictional component name and for the pre-1.0.0-rc.2 name of the reference application; the historical documents, the ledgers under `work/` and the recorded evidence keep their wording, and the application's own on-disk literals that its rename left alone are allowed by name and listed in every run.

## The examples are where the manual's snippets come from（demo 是手册 snippet 来源）

The code shown in the READMEs and in the documents is cut from the examples, not written next to them. The two programs of `README.md` / `README.zh-CN.md` are the exception, and for a reason: a reader who has just run `npm install syna@rc` has the runtime and nothing else, so the Quick Start and the world-per-tenant example depend on no fixture package and stand on their own. They are held to the rule from the other side instead — `scripts/lib/readme-programs.mjs` reads the files and the printed output out of the document, `scripts/tests/readme-example.test.mjs` compiles and runs them under the README's own `tsconfig.json`, and the release gate does it again in a project built from the README alone whose only dependency is the packed tarball; the examples of `docs/API_REFERENCE.md` and `docs/PACKAGE_AUTHORING.md` use the same domain and the same names. When an example changes, the snippet follows; when a snippet needs something the examples do not show, the example grows first. Every "What it prints" block is what the release gate matches.

## The reference application

`apps/multitenant-blog` is not an example: it is the application that drove the kernel — real PostgreSQL and filesystem backends, dynamic HTTP and static builds, a bounded and leased working set of site worlds — and its document is `docs/MULTITENANT_BLOG.md`. Read the seven examples first; read the application when a question is about scale, resources or an operating boundary.
