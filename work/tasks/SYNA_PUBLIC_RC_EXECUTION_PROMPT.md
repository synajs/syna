# Execution rule

This file is the authoritative specification for this round.
The `/goal` text is only its compact success condition.
If the two conflict, stop and report the conflict rather than guessing.

---

把当前 Syna 仓库整理成第一次真正面向外部用户发布的 public RC。

本轮包含两件必须一起完成的工作：

1. 把 npm 发布身份从内部开发阶段使用的 `@syna/*` 迁移到最终公开身份；
2. 从零重写一份真正面向人类用户的 README，并验证 README 里的使用方式可以从最终 tarball 独立运行。

这不是 Syna semantic redesign。

最终目标：

```text
runtime package:    syna
tsconfig package:   @synajs/tsconfig

runtime version:    1.0.0-rc.1
tsconfig version:   1.0.0-rc.1   # 若保持 lockstep 最简单

install:
npm install syna@rc

user import:
import { ... } from 'syna'
```

现有 Syna public API、semantic model、runtime behaviour、serialized identities 一律不变。

完成后：

```text
可以人工最后检查并执行 npm publish
```

但本任务本身：

```text
DO NOT npm publish
DO NOT create a git tag
DO NOT create a GitHub Release
```

---

# Phase 0 — 先确认 npm 发布身份

在修改任何 package metadata 之前执行：

```bash
npm view syna
npm view @synajs/tsconfig
npm whoami
```

必要时使用 npm 的只读权限查询确认当前账号对 `@synajs` scope 的发布权限。

目标确认：

```text
syna
```

可以由本项目发布，并且：

```text
@synajs/tsconfig
```

属于我们有权发布的 npm scope。

如果：

```text
syna
```

已被不相关第三方占用，或者：

```text
@synajs
```

不是当前发布者可控制的 scope：

**立即停止 package rename，报告实际 registry 状态。**

不要擅自：

* 改成第三个包名；
* 继续做一半 rename；
* 创建 npm organization；
* publish；
* 使用 `@syna/*` 作为 fallback。

README 的纯文本研究可以保留，但不要提交一个无法真正发布的 package identity。

---

# Phase 1 — 固定最终 npm identity

## 1.1 Runtime

当前 runtime package：

```text
@syna/core
```

迁移为：

```text
syna
```

对应 package metadata：

```json
{
  "name": "syna",
  "version": "1.0.0-rc.1"
}
```

内部目录：

```text
packages/core
```

可以继续保留。

**不要为了 package name 改成 `syna` 就搬源码目录。**

---

## 1.2 TypeScript config package

当前：

```text
@syna/tsconfig
```

迁移为：

```text
@synajs/tsconfig
```

因为 `@syna` 不是我们的正式 npm scope。

目标：

```json
{
  "name": "@synajs/tsconfig",
  "version": "1.0.0-rc.1"
}
```

如果现有 release tooling、workspace dependencies 和 lockfile 保持两个 package lockstep 最简单，就继续 lockstep。

不要在这一轮设计独立版本体系。

---

# Phase 2 — RC version reset

公开 unscoped `syna` 第一次 release candidate 从：

```text
1.0.0-rc.1
```

开始。

此前仓库里的：

```text
@syna/core@1.0.0-rc.2
...
@syna/core@1.0.0-rc.5
```

属于正式 npm identity 确定前的开发 / validation candidate。

它们不是要被删除的历史。

在：

```text
CHANGELOG
HISTORY
适合的 release-history 文档
```

明确记录类似事实：

> The runtime was developed and validated under the temporary `@syna/core` package identity through the earlier 1.0 release-candidate rounds. The public unscoped package starts at `syna@1.0.0-rc.1`.

以及：

> The accompanying TypeScript configuration package moved from the temporary `@syna/tsconfig` name to `@synajs/tsconfig`.

不要：

* 重写 git 历史；
* 把历史文档里的旧名字机械替换；
* 假装旧 package identity 从未存在。

---

# Phase 3 — 当前用户面全面迁移

当前推荐给用户使用的代码全部迁移：

```ts
import { ... } from '@syna/core'
```

→

```ts
import { ... } from 'syna'
```

当前对 tsconfig package 的引用：

```text
@syna/tsconfig
```

→

```text
@synajs/tsconfig
```

覆盖至少：

* root `README.md`
* npm package README
* `packages/core/package.json`
* tsconfig package metadata
* root workspace dependencies
* package lockfile
* apps/01–07 当前代码
* reference application 当前代码
* fixtures
* consumer smoke
* package author examples
* current API documentation examples
* current snippets
* type-test consumer fixtures
* release scripts
* `npm pack` expectations
* tarball filenames
* current demos
* current CI/release assumptions
* `tsconfig extends` / devDependencies
* README Quick Start

不要修改：

* 历史 migration 文档中描述过去事实的 `@syna/core`;
* 旧 audit / work ledger；
* 有意测试旧名字的历史 fixture；
* serialized implementation references；
* Service / Contract / Binding nominal IDs。

**npm package specifier 变化不能改变 runtime nominal identity。**

---

# Phase 4 — public API 必须冻结

本轮禁止任何 public runtime API 改动。

以下名称和语义全部保持：

```text
createRuntime
definePackage

Service
Entry
Env
Input
Contract
Binding

requires
parameters
uniqueWithin
metadata

load
loadAll
enter
run
check
explain
inspect

fresh
share
override
```

以及现有：

```text
error codes
RuntimeEvent shapes
implementation-ref serialization
lineage uniqueness
parent-only reuse
deadline semantics
cleanup semantics
retry semantics
owner-anchored Entry semantics
```

API inventory 应当保持：

```text
0 added
0 removed
0 changed
```

npm package specifier rename 不应被实现成 runtime API change。

---

# Phase 5 — README 从零重写

不要继续 patch 现在的 README。

当前 README 更像：

```text
release evidence
contributor manual
audit index
example catalog
history index
```

混在一起。

请重新设计一份面向第一次访问 Syna 的 TypeScript 开发者的 README。

目标读者：

> 会 TypeScript / Node.js，但第一次听说 Syna。

他应在 3–5 分钟内理解：

```text
Syna 是什么
为什么可能需要它
如何安装
如何写第一个 Service
Entry / Env 大概是什么
资源如何关闭
tenant/context-specific dependency 怎么表达
implementation choice 怎么表达
怎么测试
怎么 inspect/explain
详细文档在哪里
```

---

# Phase 6 — README 第一屏

README 开头：

```md
# Syna
```

然后一个短 tagline，例如核心意思：

> A runtime for composing stateful TypeScript services with explicit lifetimes.

接着 1–2 个自然段，从实际程序讲问题。

应该快速让用户理解：

```text
application-wide database pool
tenant-specific client
request/build/job-specific resources
automatic reuse when dependencies match
new instances when contextual facts or implementation choices differ
deterministic cleanup when a world closes
```

不要第一屏就出现：

```text
canonical slot
SCC
fixed-point
single-parent forest
bisimulation
lineage anchor
```

这些属于 semantic model。

首屏附近必须出现：

```bash
npm install syna@rc
```

以及类似：

```ts
import { createRuntime, definePackage } from 'syna'
```

Requirements 只需要：

```text
Node.js >= 22
TypeScript recommended
```

**不要把 PostgreSQL 写成 Syna requirement。**

---

# Phase 7 — Quick Start

README 尽早出现一个可以完整运行的最小例子。

目标：

```text
约 30–50 行核心 TypeScript
```

只介绍：

```text
Input
Service
Entry
Runtime
load()
run()
onDispose()
```

建议结构：

```text
DatabaseConfig Input
        ↓
Database Service
        ↓
App Entry
        ↓
runtime.run(...)
```

例子中 Service 创建一个真正有生命周期意义的资源，并：

```ts
onDispose(...)
```

释放。

不要在第一例里塞：

```text
Contract
Binding
multiple revisions
override
selector
retry
multi-tenant
full diagnostics
```

第一例的目标只有一个：

> 让陌生用户理解 Syna 最基本的 execution/lifetime model。

不要发明 API。

必须从真实、现有、已验证的 API 中构造。

---

# Phase 8 — Quick Start 必须自动验证

README 里的主 Quick Start 必须进入测试。

要求做到其中一种：

```text
从 README 自动 extract → compile → run
```

或者：

```text
canonical fixture → 自动生成/校验 README block
```

但必须确保 README 与实际执行内容不会漂移。

fresh consumer 中必须直接验证 Quick Start。

不能只在 monorepo workspace 内 compile。

---

# Phase 9 — Quick Start 后解释 mental model

紧接着简短解释：

### Runtime

一个 Runtime 知道这个程序允许使用哪些 Service definitions。

创建 Runtime 本身不会启动 Services。

### Entry

Entry 描述一个 world 要求什么，以及调用者需要提供什么 contextual facts / choices。

### Env

一个 Env 是一次 execution world。

child world 会复用 parent 中仍然兼容的 Service；当 Input 或 implementation choice 变化时，需要变化的部分会重新创建。

### Service

有 identity、dependencies 和 lifecycle 的 managed component。

### Input

外部传入的 contextual fact。

### Contract / Binding

可以稍后介绍，不要挤进第一屏。

详细形式化语义链接：

```text
docs/SEMANTIC_MODEL.md
docs/GLOSSARY.md
```

不要在 README 重新写完整数学模型。

---

# Phase 10 — Why / Where Syna is useful

使用真实场景解释，而不是营销 bullet spam。

至少覆盖：

## Shared infrastructure

一个 application DB pool 可以被多个 child worlds 复用。

## Tenant-specific resources

一个 tenant-specific API client 只属于该 tenant world。

## Requests / builds / jobs

短生命周期 Env 可以在完成时自动清理它创建的资源。

## User-selectable implementations

这里第一次介绍：

```text
Contract
Binding
```

给一个短小、真实、能理解的例子：

```text
EmailProvider
Stripe-like provider choice
Storage backend
Authentication implementation
```

使用虚构 vendor name 或中性名字，不需要真实品牌。

## Multiple revisions

简单解释同一 Service family 的不同兼容 revision 可以共存。

不要在 README 展开 resolver algorithm。

## Testing

展示 override 的最小例子。

## Diagnostics

展示：

```ts
runtime.check(...)
runtime.explain(...)
env.inspect()
```

说明用途即可。

详细 schema 链接 API reference。

---

# Phase 11 — 一个短的 contextual / per-tenant 例子

README 最多再放一个比较完整的例子。

它应展示 Syna 真正区别于普通工厂函数的地方：

```text
root world
└── shared database pool
    ├── tenant A world → tenant A client
    └── tenant B world → tenant B client
```

可以使用简短 ASCII 图。

重点体现：

* shared resource；
* contextual Input；
* dependency-driven fork；
* world cleanup。

不要把整个 multitenant-blog reference app 搬进 README。

---

# Phase 12 — Boundaries

加入一个短的 boundaries section。

准确说明 Syna 不负责：

* untrusted code sandboxing；
* Runtime hot package install/uninstall；
* distributed/process-global singleton；
* 自动把任意 configuration equality 变成 scope semantics；
* 强制终止忽略 AbortSignal 的 JavaScript；
* domain-specific transaction guarantees。

详细链接：

```text
docs/SEMANTIC_MODEL.md
docs/DEFERRED.md
```

语气正常，不要写成 defensive FAQ。

---

# Phase 13 — README 文档导航

README 最后提供一个短导航。

建议分组：

```text
Start here
- Examples
- API Reference
- Semantic Model
- Glossary

Building packages
- Package Authoring
- Plugin Authoring

Compatibility
- API Stability
- History / migrations

Internals
- Architecture
- Validation
- Audit
```

不要再把：

```text
v0.4 migration
v0.5 migration
v0.6 migration
v0.7 migration
rc task books
work/v05
work/rc4
...
```

逐项塞到首页。

历史继续留在 HISTORY。

---

# Phase 14 — README 主体中移除 release-engineering 噪声

主 README 正文不再展开：

* release gate 的 50+ steps；
* test execution 数量；
* fingerprint；
* benchmark 数字；
* source archive SHA；
* PostgreSQL cluster 操作；
* vendor scan；
* codemod internals；
* audit work ledger；
* historical task books；
* 全部 migration 清单。

可以保留一句：

> Releases are validated from a rebuilt source archive, including packed-package consumer tests.

然后链接：

```text
docs/VALIDATION.md
```

即可。

---

# Phase 15 — 文风

README 必须像一个优秀开源库作者写的技术说明。

避免：

```text
This isn't X. It's Y.
Not X, but Y.
Every X does A, B and C.
Whether you're ...
Powerful
seamless
robust
revolutionary
game-changing
```

不要用大量三项排比和 slogan。

不要每一节开头重复卖 Syna。

更倾向：

> A Runtime knows which service definitions the program may use. Creating it starts nothing. Calling an Entry opens an Env, and services are materialized only when that world needs them.

不要写：

> Syna isn't another DI container — it's a powerful revolutionary runtime...

README 要自然、技术、克制。

---

# Phase 16 — README 大小

目标大约：

```text
250–400 lines
```

不是硬限制。

优先级：

```text
clarity > line count
```

要求：

* Quick Start 尽早出现；
* 最多两个较完整例子；
* 深层语义全部链接 docs；
* 不重新变成 contributor manual。

---

# Phase 17 — GitHub README 与 npm README 同源

现在如果仍然存在：

```text
/README.md
/packages/core/README.md
```

两份独立叙事，本轮解决掉。

最终要求：

> GitHub 首页与 `npmjs.com/package/syna` 显示同一份 canonical 用户 README。

推荐简单方案：

```text
root README.md = canonical
package README = release/build 时受控复制
```

或者 repository 中保持 byte-identical，并有测试保证。

不要依赖 symlink。

加入自动检查：

```text
npm tarball README == canonical root README
```

避免以后再次漂移。

---

# Phase 18 — `@synajs/tsconfig` 的用户定位

普通 `syna` 用户不应该被要求安装：

```text
@synajs/tsconfig
```

它是 package author / repository tooling 的辅助 package。

README 主 Quick Start：

```bash
npm install syna@rc
```

即可。

只有 package-author / contributor 文档需要介绍：

```text
@synajs/tsconfig
```

如果 fresh consumer 为了 compile TypeScript 需要自己的 tsconfig，使用普通 standalone tsconfig 即可，不要把 `@synajs/tsconfig` 变成 Syna runtime 的隐式 requirement。

---

# Phase 19 — package metadata 检查

最终：

```text
syna/package.json
```

必须正确包含：

```text
name
version
description
repository
homepage
bugs
license
engines
exports
main/types if retained
files
sideEffects
dependencies
```

重点核对：

```text
name = syna
version = 1.0.0-rc.1
```

`semver` 等 runtime dependency 保持正确。

`@synajs/tsconfig` 应只出现在合理的 dev/build dependency 位置。

---

# Phase 20 — `npm pack` 验收

对最终 runtime package执行：

```bash
npm pack --dry-run
npm pack
```

检查实际 tarball。

目标文件名类似：

```text
syna-1.0.0-rc.1.tgz
```

必须包含：

```text
package.json
README.md
LICENSE
dist/index.js
dist/index.d.ts
其他真正需要的 dist 文件
```

不得包含：

```text
work/
audit scratchpads
benchmarks
tests
validation artifacts
release secrets
monorepo-only material
```

除非当前 package `files` 明确需要某些额外运行时文件。

同样 pack：

```text
@synajs/tsconfig
```

确认 package name / tarball / metadata 正确。

---

# Phase 21 — fresh consumer

建立完全新的临时目录。

只安装本轮 pack 出来的 runtime tarball：

```bash
npm init -y
npm install /absolute/path/syna-1.0.0-rc.1.tgz
```

不要利用 workspace linking。

consumer 不能看到 monorepo 的 `packages/core`。

确认：

```ts
import {
  createRuntime,
  definePackage,
} from 'syna'
```

可正常：

```text
typecheck
build
run
```

然后把 README Quick Start **按 README 原文**执行。

断言实际结果。

同时确认 consumer 不依赖：

```text
@syna/core
@syna/tsconfig
@synajs/tsconfig
```

其中 `@synajs/tsconfig` 不是 runtime requirement。

如果 README 第二个主要例子属于复制运行型内容，也至少 compile 它。

---

# Phase 22 — current-surface scan

对“当前用户面”执行严格 scan：

```text
README.md
package README
packages/* package metadata
apps current source
current examples
current API docs
current authoring docs
current consumer fixtures
release scripts
current demos
```

不允许继续推荐：

```text
@syna/core
@syna/tsconfig
```

应分别使用：

```text
syna
@synajs/tsconfig
```

历史文档例外。

不要用全仓零命中作为规则，因为 HISTORY / migration / audit 合理需要保留旧名字。

---

# Phase 23 — release tooling

更新现有 release gate，让它理解：

```text
runtime package = syna
tsconfig package = @synajs/tsconfig
public RC = 1.0.0-rc.1
```

更新：

* pack filename expectations；
* consumer install；
* manifests；
* artifact naming；
* API inventory baseline mapping；
* current package-name scans；
* README package test。

不要改变 gate 强度。

禁止：

* 放宽 benchmark；
* 新增 benchmark exemption；
* 删除 test；
* 增加 skip；
* 绕过 PostgreSQL；
* 修改 mutation audit 使它更容易通过；
* 弱化 archive rebuild；
* 弱化 consumer smoke。

---

# Phase 24 — README / tarball release test

加入 release-level assertions：

1. canonical root README 与 package README 同源；
2. packed `syna` tarball 中的 README 与 canonical README 一致；
3. Quick Start 从 README 提取后能在 fresh consumer compile/run；
4. tarball metadata：

```text
name=syna
version=1.0.0-rc.1
```

5. runtime tarball 当前用户面无 `@syna/core` dependency；
6. runtime consumer 不需要 `@synajs/tsconfig`。

---

# Phase 25 — release gate

最终必须执行：

```bash
node scripts/verify-release.mjs --release
```

要求：

```text
COMPLETE
0 failed
0 skipped
API inventory 0 changes
mutation audit intact
archive rebuild succeeds
fresh consumer succeeds
README consumer succeeds
```

如果 benchmark 发生异常：

先调查。

不要通过：

```text
threshold widening
new exemption
statistic rewrite
workload change
```

来使它变绿。

---

# Phase 26 — README 最终人工式检查

完成后重新从“第一次看到 Syna 的开发者”视角阅读。

只读 README，应能回答：

```text
What is Syna?
Why would I use it?
How do I install it?
How do I define a Service?
What is an Entry?
What is an Env?
How are resources cleaned up?
How do contextual Inputs work?
How do Contracts / Bindings work?
How do I replace a Service in tests?
How do I inspect/explain a plan?
What Node version do I need?
Where is the detailed semantic documentation?
```

第一屏附近应看到：

```text
what Syna is
npm install syna@rc
Quick Start
```

而不是：

```text
PostgreSQL
release gate
benchmark
audit history
```

---

# Phase 27 — 明确禁止

本轮不得：

* 修改 planner semantics；
* 修改 lifecycle semantics；
* 修改 Service / Entry / Env model；
* 修改 Contract / Binding semantics；
* 修改 error codes；
* 修改 serialized implementation ref；
* 添加 named scope；
* 修改 public API；
* 删除历史资料；
* npm publish；
* git tag；
* GitHub Release；
* 为了 README 发明一个不存在的 convenience API；
* 把 `@synajs/tsconfig` 变成普通 runtime consumer dependency；
* 把 repo 全局所有旧 `@syna/*` 历史字符串机械替换掉。

---

# Phase 28 — commits

把工作拆成逻辑清晰的 commits。

建议类似：

```text
chore(release): move public packages to syna and @synajs/tsconfig
docs(readme): rewrite the public Syna introduction
test(release): validate README and packed consumer
release(rc): prepare syna 1.0.0-rc.1
```

实际可以根据修改组织调整，但不要一个巨大无法 review 的 commit。

---

# Phase 29 — 最终报告

完成后报告：

```text
1. npm view syna result
2. npm view @synajs/tsconfig result
3. publish permission check result
4. final runtime package name/version
5. final tsconfig package name/version
6. files migrated from @syna/core → syna
7. files migrated from @syna/tsconfig → @synajs/tsconfig
8. historical references intentionally preserved
9. README structure
10. README line count
11. README Quick Start validation
12. GitHub/npm README single-source mechanism
13. runtime npm pack filename + sha256
14. tsconfig npm pack filename + sha256
15. tarball content audit
16. fresh consumer typecheck/build/run
17. current-surface legacy-name scan
18. API inventory
19. mutation audit
20. core test result
21. app test result
22. PostgreSQL/matrix result
23. release gate verdict
24. final commit SHA
25. git status
26. residual limitations
```

最后显式确认：

```text
NOT published to npm
NO git tag
NO GitHub Release
```

最终仓库状态应当是：

> `syna@1.0.0-rc.1` 与 `@synajs/tsconfig@1.0.0-rc.1` 已完整准备、README 已面向真实用户重写、pack 与 fresh consumer 已验证，只差人工最后 review 和真正 publish。
