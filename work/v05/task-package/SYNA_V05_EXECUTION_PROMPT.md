# Syna v0.5 + Hyla-mini：实施任务书

> 这是要求你实际编写、运行、审计并交付代码的任务，不是请你继续输出一份设计建议。
> 本文件是本轮的需求基线；它已经吸收了多轮审计，并覆盖旧 RFC 中已被撤回的方向。
> **先以 Hyla-mini 固定真实应用行为，再由应用和回归测试驱动 Syna 内核修复。**

## 0. 任务、权限与完成含义

你是本项目的实施负责人。把当前工作区中的 Syna v0.4 基线修订为可执行的 v0.5，并完成使用它的 Hyla-mini。可以重写错误的内部模块；保留有价值的代码、测试和公共风格。不要先推倒全部内核、闭门重建，再拼一个展示用 demo。

你必须交付：实际源码、可运行应用、类型测试、行为测试、真实 PostgreSQL/文件系统集成、应用级验收、性能与工作集报告、迁移说明、独立审计记录，以及从最终归档重新构建的证据。完成不是“测试数量很多”，更不是“自称再无漏洞”。

授权范围是当前项目的本地开发、必要的开发依赖、隔离测试和本地归档。遵守工作区已有安全规则与权限提示。不要强推、发布 npm 包、部署线上服务、使用生产数据库、读取无关密钥、修改用户全局 Claude 设置、绕过权限保护，或执行破坏性 git reset/clean。保留用户未提交改动。清理只删除本任务自己创建且明确记录的资源。

本任务允许你自行决定未指定的低层实现细节，不要对每个正常编码选择征求确认。遇到依赖安装/容器/权限等真正外部阻塞时，先尝试安全的本地替代路径，继续其他可做的工作；记录精确阻塞，不可将缺失验证改写为成功。

不需要实现整个商业 BlogAssembly，也不需要完成通用 Fluida ORM。本轮追求窄范围内的完整纵向用例，而不是广范围的空壳。

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > 本轮经过记录的具体实现决策 > 旧 RFC/语义文档 > 旧代码与旧测试。不能以实现既有行为反过来证明它合理。

工作区可能已经是完整源码仓库，也可能只放了归档。首先定位并实际检查：

- `syna-v0.4.0-source.tar.gz` 或 `syna-v0.4.0-source.zip`；
- 解包后的 `packages/core/src`、tests、type-tests、apps、benchmarks；
- `docs/SEMANTIC_MODEL.md`、API reference、旧审计；
- 可能存在的 `syna-v0.5-design-rfc/DESIGN_ZH.md` 与 `model-results.json`。

不要假设历史聊天、ChatGPT sandbox 路径、某个本地绝对路径或报告中声称的文件在本机一定存在。列出真实路径和大小，安全解包，确认有源码；不要从只有文档的包继续。

旧材料只帮助解释背景。**旧 RFC 中的跨祖先普通实例复用、Prepared 协议、重新引入 `implSelector` 公共名称、四层缓存规划不进入本轮。**旧 v0.4 的强 load barrier、activation 中返回假 Ready、只在零依赖 Fake 上通过的 override，都不是必须兼容的正确行为。

不要照抄“88 个测试通过”“hardened”“PASS”等历史结论。本轮自己记录环境、构建产物和运行结果。若某旧测试是对已撤回语义的断言，可修订，但必须在迁移表中逐项说明；不能删掉有效反例来获得全绿。

保持本文件原意，不要通过修改本任务书、降低验收项、把错误重新叫成 feature 来完成 goal。真遇到需求互相矛盾，提供最小反例、影响和保守处理；不暗改核心规则。

## 2. 应用背景：为什么要造 Syna

- BlogAssembly 是托管、多租户、支持自定义域名的博客平台。
- Hyla 是其开源博客引擎，同时支持单租户自部署。
- Hyla 要共享动态请求渲染和静态构建的内容/渲染主线。
- Fluida 计划统一 PostgreSQL、MongoDB、文件系统等数据后端；本轮只做 PostgreSQL 与文件系统的最小真实 adapter 接口，不做完整 ORM。
- 官方和第三方能力采用同一套 Service/Contract 组合机制。
- 渲染阶段、文章、语言、主题、配方、租户、认证与授权是应用概念，不进入 Syna 内核。

最重要的使用规则：

**想要两个对象时，先问它们是否只是同一个 Factory Service 的两个产物。配置不同不自动意味着需要两个 Service slot 或两个 Env。只有受 Syna 管理的依赖身份、上下文事实或资源归属不同，才需要 Env 分叉。**

例如 remark 工厂的两次 configure 可以产生正文、评论的不同插件/processor；Factory slot 仍共享。数据库连接配置若明确作为 Postgres Service 的 Input，重提供它当然应分叉 Postgres。不要将该规则绝对化为“配置永远不影响 slot”。

工厂产物若借用 Service 的资源，不得活过对应资源 owner；由该领域 API 明确借用/关闭协议，Syna 不自动把每个产物变成 node。

## 3. 本轮范围已经裁定

### 3.1 必须实现

1. Hyla-mini 的真实两后端 × 两执行方式矩阵。
2. 同一组 remark/unified 插件 Factory 服务，生成三份不同配方的管线。
3. 两租户隔离、域名映射、一次 auth 实现替换、配置更新。
4. 按需、有界、租约保护的 SiteEnv 工作集管理。
5. 移除隐式 setup barrier；普通 Promise 的 catch、race、后台调用按 JS 原义工作。
6. `ServiceRef.load()` / `InputRef.read()`；Input 同步保留原始载荷。
7. parent 当前语义世界中的 canonical-slot 复用固定点。
8. 编译期 override；私有 exact 与 range 解析一致。
9. Attempt、Waiter、Owner 的失败恢复和取消边界。
10. 真正 Ready 的普通 Entry；Service-owned BoundEntry 在合法 Ready anchor 上工作。
11. `C.all`、只读 catalog、精确/持久化实现引用；不新造 selector 同义名字。
12. `check()` / `explain()` 输出分叉范围和原因。
13. 成熟 semver 库、明确 Node/TS 平台、可维护内核模块。
14. 有界缓存、应用冷热路径 benchmark、归档内外一致的可重跑交付。

### 3.2 明确不做

- 通用跨祖先历史实例搜索或“全历史基数最优复用”。
- Prepared/prepare/activation group 实验协议；activation 期间递归开新世界不进入 v0.5。
- Env merge、多父 Env、动态 caller Env。
- Runtime 内热装卸、dependency epoch 重启、跨 Runtime 自动资源迁移。
- 完整插件市场、包安装器、线上部署器、不可信代码沙箱。
- 新的 `implSelector` 公共拼写、第二套 Profile/Recipe/Stage 内核 DSL。
- MongoDB adapter、完整通用 ORM、完整后台管理站、完整 UI i18n 平台。
- reactive Input、跨进程 singleton、自动 Contract adapter。
- 新造一套“更精巧”的 Promise/effect DSL 来实现完备死锁检测。

必要的最小内核接口细化应由真实用例证明，并写一条简短决策记录。不能因为审计可能再提问，就预先扩展另一半框架。

## 4. 执行方式：应用先行，阶段闭环

### Phase A：勘察与建立任务账本

检查 git 状态、源码/归档、Node、包管理器、TS、PostgreSQL/容器能力和 Claude Code 可用工具。记录真实版本，不自动切换付费模型或擅自改变权限。

运行可运行的 v0.4 baseline；明确哪些测试只验证旧语义、哪些有效。长时间 pending 的探针放独立进程并设置测试兜底期限，不能挂住整轮。

建立简短的：

- `work/v05/STATE.md`：当前阶段、实际失败、修改文件、下一步、资源状态。
- `work/v05/DECISIONS.md`：保持/修正/扩展/排除及理由。
- `work/v05/ACCEPTANCE.md`：本文件 K/H/P/R 编号到测试/命令/证据的映射。
- `work/v05/ISSUES.md`：反例、期望、复现、根因、修复、复验、状态。

这些是执行状态，不是为了再次写一份 35 KB RFC。尽快进入可运行纵向切片。

### Phase B：先建立 Hyla-mini 的第一条完整路径

先以 v0.4 的主要 API 拼写写出一个租户、一个内容后端、一个 HTTP 页面和一个静态构建命令。可以暂时只移除 barrier 和补少量兼容适配，使应用继续前进；禁止在应用层绕过 Syna 内部图访问。

尽早接入真实 PostgreSQL和真实文件系统；建立后端/渲染矩阵、工厂共享、双租户和 SiteEnv manager 的应用级测试。将其在旧内核上的真实失败记录下来，不要求先把整个 v0.4 全绿。

不能把所有业务绕过 Syna 后留几个无关 Service 装饰门面。应用需要实际使用 admission、Input、Binding/Contract、Entry、owner、分叉与 cleanup。

### Phase C：针对应用失败和回归清单修内核

每个修复先有小而独立的复现，再改根因，再跑相关应用和历史回归。按模块重构，避免把全部功能继续加入 Runtime 巨类。

别让“先应用”变成删除针对性反例。应用验收检验有用性，黑盒回归和状态交错测试检验可靠性。

### Phase D：独立审计、性能与交付

在接口已稳定、主用例已跑通后进行新上下文独立审计。修复报告中的可复现缺陷，添加 regression，再从干净归档重建。

不要用“我们进行了很多轮思考”作为验收证据。以下各项以实际命令、退出码、机器可读结果和源码 fingerprint 为准。

## 5. 并行协作：用隔离提高质量，不用数量掩盖风险

可用时使用 Claude Code 原生 subagents；只在已经启用并确实适合独立任务时使用 agent teams，不要求用户为此启用实验功能。不要为了开更多 agent 花费大半时间搭编排系统。

主负责人拥有 Syna core 与整合权。最多同时分派三个边界清楚的任务：

1. **应用实施者**：Hyla-mini、两后端 fixture、配方、租户工作集和 E2E；不得修改内核语义或验收器来让自己的 demo 通过。
2. **反例审计者**：从本文件和公开 API 编写独立黑盒探针；默认不改 production source；输出复现和机制，不输出模型评分。
3. **交付/性能复核者**：独立解包、安装、编译、跑真实 PostgreSQL、检查归档和缓存/工作集数据；不得手写 PASS。

每个任务交付：改动文件、实际执行命令、结果、未解决问题、最小复现。agent 之间不同时改同一文件；跨边界先报告主负责人再整合。

worktree 只能从正确基线开始。核对它实际位于哪个 commit、是否包含当前未提交改动；不要假设 worktree 自动继承主会话现状。审计者应审最终候选 snapshot，而不是默认分支的旧代码。归档复核阶段使用只读/独立解包目录。

至少有一次最终审计应由没有参与该模块实现的新上下文执行。给 reviewer 需求和代码，不给“已经证明正确”的自我总结。若原生子代理不可用，不得虚构独立审计；可以完成自审并如实标记该项未独立验证。

长任务通过磁盘账本和 Claude 原生任务列表保持进度。压缩/恢复上下文后先读本文件、STATE 和未解决 issues。不要 `/clear` 后假装状态完整；不要丢失安全边界。

## 6. 保持的公共 API 及迁移约束

优先沿用：

```ts
const define = definePackage(packageJson)

define.service(...)
define.contract(...)
define.input(...)
define.binding(...)
define.entry(...)

requires
parameters
uniqueWithin
metadata
revisionMetadata

serviceRef.load()
inputRef.read()
loadAll(...)

runtime.enter(...) / runtime.run(...)
env.enter(...) / env.run(...) / env.derive(...)
env.bind(...)
env.dispose()
Contract.all
Binding.to(...)
override(...)
```

这不是要求逐字保留错误签名；是禁止无必要地再次全面换名。新增 `explain()` 和 Input 同步读取是有具体理由的增量。保持局部类型推导，不使用全局 `declare module Services` 注册表，不要求调用者手抄实现类型。

- Service 稳定导出名不含版本；exact Revision 默认来自包 version。
- Contract/Input/Binding/Entry 的 `apiVersion` 与 package major 解耦，默认 1。
- `#syna/package` 或同等明确、可编译方案获得包 metadata，真实下游包在开发和构建阶段都不能产生 TS 红线。
- 统一实际 Node 平台、engines、CI、tsconfig 和真实 `@types/node`。不要手写 ambient async_hooks 来掩盖不兼容，不虚称浏览器通用。
- `.load()` 不 thenable。`Promise.resolve(ref)` 必须得到 ref，不启动 Service。
- Input `.read()` 返回载荷本体，允许 undefined、Promise/thenable、函数等 opaque payload；不通过 async 返回吸收它。
- Input 旧 `.load()` 如保留需标记弃用并诚实返回 Awaited 类型；不能在 `.read()` 中克隆或 freeze 用户载荷。
- `loadAll()` 可以仅接受 Service refs；若维持异构 Input 支持，必须显式装箱以保留 Input 载荷，不进行意外 assimilation。
- Service setup 返回实例若自身具有 callable `then`，必须明确限制/诊断，或提供不与普通 async 返回混淆的包装；不要暗中改变其类型含义。
- 旧 `preload()` 不再参与 strong 语义。可做兼容 wrapper，但说明它启动真实 slot、结果服从同一 failure policy；不得声称失败无痕。
- `C.all` 是本轮唯一推荐的同 Env 实现集合/选择器。旧 `C.selector` 只做最小兼容：保留已文档化的候选子世界语义，内部转调 Entry 工具或明确报告不支持的 activation 场景；不再扩展为新的 core primitive。
- 原先仅因 bug 才能成功的行为不保证兼容；正确性修复逐条列入 MIGRATION。不要为兼容重新引入 barrier 或假 Ready。

## 7. v0.5 核心语义：实现与测试必须对应

### K01 — 定义世界与运行世界分离

Runtime 有限、封闭、不可变。构造时可编译索引、检查定义，但没有 Env、slot、实例。内部传递依赖不自动进入公共 admission。新代码集需要新 Runtime/部署，不在现存 Runtime 插拔。

### K02 — Entry 与单父 Env

每个 Env 由一次 Entry invocation 创建；没有 parent 是 root，有 parent 是后代。普通 enter 只接受 Ready anchor，返回真正 Ready child。Service-owned BoundEntry 在 setup 期间被调用、owner 未 Ready 时给出明确错误，普通 catch 可处理它；禁止虚构 Prepared 或返回假 Ready。

没有 ambient caller Env；同一 Service 被多个后代共享时，owner 仍唯一。外部只得到 Entry requires 的类型化表面，不得到 unrestricted locator。

### K03 — parent 可见候选与固定点

child 的活动 roots 来自继承 root declarations 与本次新增 requirements；Binding 改变时应在 child 中重新解释，不是简单 union 旧图。

**普通复用只针对 parent 当前可见 slots，不恢复被 parent 遮蔽/移出的历史普通 slot。**parent 当前 slot 可以由更早祖先拥有，那仍然可正常复用。

选定版本/实现图后：按精确名义节点和边匹配 parent 候选；移除 fresh、结构不匹配、dependency slot 不一致的节点，传播到依赖者直至固定点。只有在这个候选域下声明唯一最大合法复用集，不宣称跨历史或跨所有版本选择的全局最优。

同 Env 同 resolved node 只有一个 canonical visible slot。slot 变化沿 reverse dependency 传播；结构 SCC 一起继承或分叉，但不要求同时 materialize。

`fresh`/`share` 支持已有 exact 与 Family target；Family 对当前活动 revisions 生效，不激活未使用的所有版本。冲突明确失败，不 silently relax。不把 payload 相等性或 setup 是否已执行作为复用条件。

### K04 — lineage uniqueness 持久承诺

保留 `uniqueWithin: 'lineage'`：一旦 Family 在某 Env 扎根，后代再使用时不得更换 revision、resolved binding 或 canonical slot。

即使中间 Env 暂时没有活动路径使用该 Family，anchor 承诺仍要保留。可用简单的持久化 anchor map 和必要 dependency slot 记录，不恢复通用历史搜索。重新使用时，要么复用该硬约束指定的 slot 且全部当前依赖一致，要么明确报冲突，不能悄悄开第二实例。

siblings 在共同祖先从未锚定时可分别锚定。unique dependency 若因 Input 重提供需要分叉，应输出完整冲突链。无需把“fixed 依赖任意 Input”一概定为错误；Hyla 的具体入口检查与预算负责发现不合适的布局。

### K05 — Input 与 Binding

Input 是 Entry 外部提供、Syna 不拥有其载荷生命周期的事实。省略则继承；显式重提供即新 Input slot，即使同对象；presence 与 undefined 分开；重复 key/同名 descriptor 绑定冲突不得 last-write-wins。

Binding choice 是精确实现选择，Projection 指向当前上下文的 Service slot。同 revision 的重新赋值可归一化；不同选择影响消费者图。同一实现被两个 Binding 选择不自动创建两份实例。Binding assignment 没被消费前无需提前创建目标资源。

业务需要不同配置产物时优先普通 Factory 调用；需要不同受管依赖世界才用 Input/Entry。别让某个 Factory configure 偷读未声明服务 locator。

### K06 — 版本、Contract 与 candidate refs

使用成熟的 npm-compatible `semver` 依赖，锁定可复现版本；测试 0.x、0.0.x、prerelease、union/comparator 和默认 caret refs。不手写半个 SemVer。

Service exact import、range、auto choice site、Binding 要区分。继承的静态 choice site 不能随 load 顺序变化；新 root 要求新 revision 不等于重写旧边。不同消费者的 auto 是独立选择位点。

裸 Contract：唯一合法默认/唯一 family/继承的已定选择，否则歧义。`auto(C)` 接受显式 Runtime policy；没有该策略时给出清晰缺策略错误，不退回字典序。policy 不是越过硬约束的授权。

`C.all` 纳入所有被公开接纳且兼容的 exact revisions，不能按 Family 合并、只选最高版本或 quietly 删掉冲突候选。不能共存则整份 Entry 无解；eager 候选照常参与 Ready。与 direct dependency 命中同节点时共享同 slot。

catalog 是只读 metadata，不创建 Env/实例、不宣称网络或凭据可用。PersistentImplRef 可保存 family/version intent/Contract；CandidateRef 属于具体 collection slot，不能跨已分叉集合使用。resolve(ref) 可在冻结候选和策略上纯查找，但不得变更图或自动改供应商。

### K07 — 普通 Promise，不再隐藏 barrier

`.load()` 只取得预定 slot 并返回普通 Promise。setup Ready 取决于其实际返回结果，不收集调用树里所有 load 再 Promise.all 一次。

必须允许：catch 后降级成功；Helper 内不 await 的后台 load 不拖住 Caller；Promise.race 能正常走 fallback；未等待 load 的结果不重新毒化已成功的消费者。

ALS 只能用于追踪来源和明确授权的日志上下文，不能决定用户是否 await，不能给 Caller 追加强义务、资源归属或隐式取消责任。

`loadAll()` 只是普通可 catch 的批量操作。缺 Input 等规划错误与已存在 slot 的 materialization failure 分开。可 catch 的 lazy failure 与独立 eager 失败义务分开。

结构环允许。对任意用户 Promise 等待环不保证立即、完备识别；不得用短静默期将疑似环直接判成 sticky failure。使用显式可配置 initialization deadline，超时报告 INITIALIZATION_TIMEOUT/对应实际错误及观察信息，不假称已证明 deadlock。用可控测试调度验证真正循环有兜底诊断、非循环预取/race 无误伤。不再引入另一种会暗自等待普通 Promise 的 require/strongLoad。

### K08 — Attempt / Waiter / Slot

逻辑 slot 身份固定；一次实际 setup 是 attempt；每个调用者是 waiter。

同一 slot 同时最多一个尚未结束并清理完的 attempt。成功发布 Ready 实例后不通过 load 偷换对象。并发 waiters join 同一 attempt；一个 caller abort/timeout 只结束自身等待，不取消其他使用者共享的 attempt。

failure 默认 sticky；显式配置可在一轮尝试耗尽后允许 future-load recovery 和 cooldown。每次重试前检查 owner state/signal，先完整清理本次 attempt 已登记资源；rollback 失败不能无视后继续重试。框架 backoff 必须可取消。

owner dispose 禁止新尝试、recovery、Entry 和 dormant materialization。旧 attempt 超时但仍实际运行时，不启动与它重叠的新 attempt。迟到结果不能覆盖新的状态/已关闭 Env；处理 cleanup 并报告。

AbortSignal 不强杀任意 JS。对不合作 setup，调用者可以超时，但关闭状态和报告必须承认未结束资源，不能提前叫完全 Disposed。不设计虚假的一键强杀。

### K09 — cleanup 与 Ready

Ready 意味着该 Env 所有可见 eager slots 已 Ready。Ready parent 的继承 eager 已就绪；本地新增 eager 必须完成。没有声明/真实等待关系的 eager 无启动顺序保证。

关闭先拒绝新工作并广播取消，再等 descendants 和已登记工作结束，然后 dependant-first SCC DAG cleanup；SCC 内逆完成顺序且无更强业务语义。

onDispose 只负责自己创建的资源，不关闭共享依赖。Ready 后运行时才加载的依赖，也要符合最终依赖清理顺序。cleanup 期间不启动新的 dormant 资源。

业务错误与 cleanup 错误都保留；清理错误不覆盖主错误，其他清理仍继续。支持现有 Symbol.asyncDispose，平台不支持时给出正确编译/运行配置而非假类型。

### K10 — BoundEntry：延后依赖、静态授权、owner anchor

Service requires 中的 Entry 不把它未来的 roots 即时纳入 Service 当前图。Runtime 可知道定义，当前 Env 不提前需要 Transaction Input。

先确定 Service slot owner，后生成 BoundEntry handle；继承 Service 时 handle anchor 不变。不得因 handle 绑定“当前 child”而让 Service 必然 fresh。

BoundEntry roots 按显式授予的私有定义域解析，exact 与 range 一致；Contract 发现仍按相应公开策略。公开外部 env.bind 不自动获得 Service-private realm。

App-owned UoW 看不到 RequestEnv Input；可通过 Entry parameters 明确传入，或让 UoW 自己成为 request-local。此推论必须写文档并测试。

worker 由宿主在 root Ready 后显式启动；Service 的 setup 返回初始化好的控制对象，后台循环不作为其永不结束的 setup Promise。普通 run 等待 callback 全寿命，这是正常 JS 行为，不自动变成 owner 的 barrier。

### K11 — override 的 compiled view

保留 API `override(Source, Fake)`。在 Runtime 编译阶段产生明确的 CompiledService：source nominal identity/public Contract membership/scope target + Fake executable requires/setup。不要伪装成另一个原始 source descriptor再进 manifest 冲突校验。

Fake 可比 Source 少依赖、多依赖、依赖不同 private helper；必须检查提供给消费者的接口兼容，Runtime 不能假装 TS 类型是运行时行为证明。

source 只出现一次 public candidate；Fake 作为 override 来源不需要 admitted、不自动独立公开。若用户另行明确 admitted Fake，作为独立候选出现是预期，单独测试。

exact/range/裸Contract/auto/all/Binding/refs/fresh/share/check 均使用同一 compiled view。nested override、重复 source、self/cycle、failure/eager 策略保留或替换规则在一页决策表中说明，禁止按调用路径随机处理。

### K12 — 预检与 explain

`check()`/`explain()` 只规划，不执行 setup，不发布 Env，不留下 owner anchor 或泄漏临时 slots。实参检查与仅形状检查结果应区分；没有实际可解 Binding 时不能宣称全部署已验证。

至少输出：reuse/new/fork 的 Service 数、Input/synthetic 数、待启动 eager 数、候选选择、缺失输入、不可满足约束，以及每个分叉的 cause/path。

例如解释 DatabasePool 为什么经 RequestAwareLogger 依赖 CurrentRequest，导致 per-request 重建。区分“新引入”和“已存在节点被分叉”，不要混成一个含糊数字。

无法解析的候选可以回溯；policy TypeError、无效 descriptor、内部 bug 不可吞为 UNSAT。搜索预算耗尽是 budget error，不是无解证明。错误码 union、实际 throw 和诊断 schema 保持一致；不依赖 owner id 的字符串前缀判断状态。

## 8. Hyla-mini 应用验收：不是假后端和 console demo

路径可以沿用现有 monorepo，建议 `apps/hyla-mini` 与少量应用/adapter packages。不要为了示例创造十几层 wrapper。

### H01 — 最小数据模型

实现足以支持测试的 Site、Post、Category、Tag、导航/标题配置与渲染配方。不要求完整产品。

Post 至少有 stable id、tenantId、slug、正文、发布/私有状态、分类/标签与稳定修订信息。可用少量 `zh-CN`/`en` fixture验证语言是普通业务数据/参数，但不实现通用多语言 ORM 容器或 UI 国际化平台。

给定 fixture，输出应可规范化比较。时间、随机 id、排序、locale 回退等由 fixture或明确策略控制，不能为了比较结果删掉权限/主题/语言的实质差异。

### H02 — 真实 PostgreSQL

使用真实 PostgreSQL 与正常 client/pool。提供幂等 seed/migration、隔离测试 DB/schema和清理。使用当前环境中可用的 Docker/Podman、已授权测试 URL 或本地临时 cluster；不可使用生产库或不经确认的外部数据。

不允许用内存 Map、SQLite、pg-mem 或 mock server 代替这项必跑验收。无法运行时保留实现与可重跑脚本，状态必须 BLOCKED，不能跳过后宣称 COMPLETE。

租户查询携带 tenant 约束；事务在同一 leased client 上完成；测试 rollback 和并行事务不串状态。无必要时不要每租户建立独立连接池：shared pool 位于 app/data-source 层，site 持有租户化的仓储能力。

### H03 — 真实文件系统与布局扩展

文章以 Markdown 及明确 metadata 存储，其他最小数据使用 JSON/YAML。使用真实临时目录完成 create/read/update/delete/scan，不以缓存假装落盘。

实现默认布局与博客布局两个同 Contract layout factory。博客布局能让 primary category 决定文章目录，其他表保留原形式。稳定 record id 放在明确 metadata中；slug/category rename 要测试读写往返，不因文件改名丢 identity。多个分类如何指定 primary 明确即可，不做通用布局规则引擎。

租户根路径隔离，拒绝路径穿越；明确 symlink 策略。写入使用同目录临时文件加安全替换等合适策略，声明测试范围内的并发保证，不宣称拥有数据库式多文件 ACID。禁止危险递归删除不属于测试的路径。

### H04 — 两后端 × 两执行方式

同一套内容/渲染主线完成四格：PG→HTTP、PG→静态文件、FS→HTTP、FS→静态文件。

动态侧真实启动本地临时端口HTTP server并请求页面；静态侧实际写 HTML/必要 JSON 到独立输出目录，再读取/服务它。不是同一个函数调用换个字符串标签。

四种模式使用相同 renderer/主题/配方实现，renderer 不被迫依赖 HTTP Request。相同 fixture 的公开内容和必要页面结构一致；私有文章/草稿不因静态导出而泄漏。静态输出不能含运行期的 tenant credential/内部 refs。

### H05 — 三配方共享一组工厂

使用真实 unified/remark 处理链。至少有正文、评论、预览三份配方，其插件顺序/选项有可观察差异，共享同一组 Factory Service slots。

每个阶段用领域 Contract 描述；Syna 不理解 MarkdownStage。选择由 JSON-safe recipe保存。检查插件阶段类型、配置 schema/default、重复插件 semantics；不要忽略 unified 对重复 `.use()` 的行为。

工厂 configure/processor产物不同不自动创建 Env。测试工厂初始化计数、配置产物计数和并发输出，证明没有跨配方或跨租户 mutable state。

对于会输出 HTML 的测试配方，提供明确的可信/不可信输入处理：评论等不可信内容经过正确位置的 sanitizer，不允许后续插件重新注入未清理内容。不要把这一业务安全策略放进 Syna core。

### H06 — 工厂依赖约束与启动预检

Hyla 的共享渲染 Factory 只依赖 RenderInfrastructureEntry 已公开提供的基础能力；Site/Request 事实走 configure/render 参数。该限制是 Hyla 插件协议，不是所有 Syna Service 的全局规则。

启动监听前对 RenderInfrastructureEntry（包含相应 C.all）做实际 check。增加违规插件工厂依赖 CurrentRequest 的 fixture；必须在 startup/preflight 给出路径并拒绝该新部署，而不是等某租户首个请求才炸。

另加并发插件协议测试检查闭包污染；check 不可能证明任意 JS 不读全局变量，不要声称它能。

### H07 — 引用与配方可持久化

recipe 保存格式版本、阶段顺序、occurrence key、PersistentImplRef、options版本和值。round-trip serialize/parse 后仍能构建相同行为。底层 exposed revisions如实可查询，普通导出名不带版本。

至少一次测试同 Family 多 revision + 用户引用范围，以及一次新 Runtime 中兼容升级后解析到新版本。没有目标 Family 时明确失败，不自动换供应商。记录本次实际解析版本用于诊断，不偷改用户保存意图。

不实现完整迁移框架；需要 breaking options 时给出版本/拒绝或最小显式迁移示例，不能承诺任何版本“无痛”。

### H08 — 两租户、域名和隔离

两个站点使用不同配置/主题参数/配方与数据，可复用相同 factory slots。至少一个站点绑定两个域名；先由受控域名表解析 tenantId，再查 SiteEnv，不为同站点域名别名复制整个数据资源。

使用相同 post slug 测试 tenant A/B 输出不同且正确。未知域名拒绝，不根据未经映射的 Host/path 访问文件/表。代理头信任规则明确，仅有可信代理时才使用 forwarded host。

tenant/locale/content visibility等会影响输出时进入应用缓存键；Syna plan cache 不缓存页面或授权结果。必须测试无跨租户、无匿名/登录状态串缓存。

### H09 — auth 可替换，授权不消失

定义一个最小 Hyla Auth Contract，用两个真实执行的本地测试实现替换（例如自部署会话与平台签名 token/mock IdP）。无需外部 OAuth 账号；测试认证适配器不得被文档当成生产安全实现。

内容/渲染消费者不因 auth 实现替换改代码。测试匿名只能读公开内容，A 身份不能读 B 受限内容。认证与 tenant 授权分开；不能通过“注入用户名字符串”跳过全部权限路径。

### H10 — SiteEnv 是工作集，不是租户存在

在 Hyla 层实现 SiteEnvironmentManager 普通 Service。Syna core 不新增 TenantScope/LRU租户对象。

缓存键至少区分 Runtime 身份、TenantId、SiteConfigRevision。按需创建；并发首次获取同一键 single-flight。请求/构建/明确后台使用者持 lease，release 幂等，不负计数。空闲 TTL 与容量限制可配置；不可驱逐有活跃 lease 的 Env，不可关闭共享 app pool。

当前持续有流量的租户更新配置：新请求必须进入新配置版本，旧请求继续合法完成并释放旧环境。驱逐不能代替版本失效。旧配置不得在 manager 中无限积累。

所有环境都在用时，要有限排队/背压/明确拒绝，不靠强关活跃租户腾空间。创建失败不能留 poison single-flight promise；设置有界重试/backoff避免风暴。关闭期间不再 acquire新实例；等待或明确报告未释放 lease。

Env 被驱逐不丢唯一业务事实；数据、配方、配置版本存在后端或明确配置仓库。sticky failure 是否可恢复仍由 Service policy 决定，不能宣称靠驱逐解决 app-level故障。

### H11 — 规模与配置热场景

准备大量租户记录/标识，但只让少量活跃；证明未访问租户没有 Env。至少测试热点集中、轮换访问、在途构建、冷创建失败、配置修改下持续流量、关闭时并发 acquire/release。

观测 active/idle/creating/draining Env、lease数、eviction、共享 pool/factory 数。证明容量有界而不是每租户永久保存 slotsByNode。

### H12 — Request 分叉预算

应用验收使用 explain：分别输出 inherited/new/forked Service数量、Input/synthetic数量、eager数量及 cause。

为 RequestEntry 写预算（默认以本地 Service ≤10作为初始目标，可在看到真实初版需求前调整并记录）；共享 DatabasePool、插件Factory、基础编译器不得在每个请求中新建/分叉。预算必须区分轻量节点数与资源成本。

添加违规基础设施 Service传递依赖 CurrentRequest 的 fixture，解释并阻止预算违例。不能通过漏记 synthetic/Input 或移动计数口径让表好看。

### H13 — 正常启动与 worker

root Env Ready 后，由宿主加载控制 Service并启动受控 worker Entry。worker初始化与工作循环分开；退出时收到停止通知、释放 child再关闭共享资源。

测试 setup 中试图用未 Ready owner开Entry被明确拒绝，文档说明替代方式。禁止以“支持 eager worker”为由偷偷恢复 Prepared或假 Ready。

## 9. 反例验收清单：必须是代码，不只是审计 prose

每项映射到测试路径和结果。至少覆盖：

- R01：Binding.to 在 0.2、0.0.5 和普通2.x范围内可解析；默认范围不会不合理地放宽到更低已发布版本。
- R02：setup catch lazy backend failure后返回 degraded，consumer Ready；backend eager时另行验证Env失败原因。
- R03：Ready Helper执行自己处理拒绝的后台load，Caller不被追加barrier或失败。
- R04：结构 A↔B合法；运行期相互调用合法；真正 pending循环有配置deadline诊断；race fallback和合法预取不误报。
- R05：Input payload是Promise/thenable/undefined/函数时read保留identity；ServiceRef不暴露then，Promise.resolve(ref)不启动。
- R06：Real需要config而Fake不需要；Fake新增依赖；全部解析路径一致，source不重复、scope目标有效。
- R07：Service-owned private Entry的exact和range都可用；外部相同descriptor没有private authority时拒绝；不泄漏private Contract实现。
- R08：owner-bound entry继承后仍绑定同owner；App-owned UoW看不到request Input；显式传参可用；handle本身不引起无意义fresh。
- R09：retry/backoff被owner关闭取消；下一次load恢复只启动一轮；旧attempt晚返回/cleanup失败不造成重叠或假Ready。
- R10：caller取消自己的等待不取消共享parent初始化；owner停止信号先到达等它退出的child。
- R11：callback与dispose同时失败保留两者，清理不因首个错误跳过其他资源；cleanup不新开dormant slot。
- R12：parent-only Binding flip-back新建普通实例；parent当前可见的祖先owner slot仍复用。
- R13：unique Family中间暂不活动后重新出现仍保持anchor/明确冲突；不能丢anchor创建第二个；siblings无共同anchor可独立。
- R14：C.all 与 direct相同实现同slot，多版本不折叠，slot变更传播到collection与consumer，eager与lazy各守自己政策。
- R15：同revision自动选择点在lineage稳定；不同auto边可独立；裸多family歧义与auto缺policy清晰；policy bug不吞为unsat。
- R16：Binding same resolved choice no-op；Input same payload explicit reprovision fork；遗漏参数与undefined分开；冲突参数拒绝。
- R17：缓存关闭/开启/频繁evict结果相同；public/private realm不能cache串权限；多个parent相同shape但具体slot不同不能串实例。
- R18：selector/BoundEntry/request churn不按Env/slot id不断增长；CandidateRef仍按所属collection隔离。
- R19：SCC fork与dispose；simple DAG late-loaded dependency仍按依赖者先关闭；普通图与reference planner差分。
- R20：service导出名稳定、package version自动注入、descriptor apiVersion不随无关package major改变；重复物理descriptor按正确规则归一化或诊断。

测试以public API为主。必须有控制Promise/latch/假时钟调度的交错用例；不是全部靠sleep赌时序。少量真实deadline用独立进程兜底，不让整套CI静默挂死。随机/属性测试记录seed、图、操作序列并可重放。

保留一个简单、慢速的parent-only reference planner，不能调用production复用算法来验证它自己。有限图穷举只声称覆盖相应子模型，不以用例数量证明整个Syna无漏洞。

## 10. 性能与工作集验收

P01：同机记录Node/CPU/OS、依赖版本、样本数、预热、GC设置和完整分位数。拆开cold-plan、warm-plan、new-slot allocation、materialization、dispose，不只给一次总耗时。

P02：最少覆盖100/300 service常见图、真实Binding/auto/all/BoundEntry、两种后端请求（数据库时间单独报告）、SCC、不同Input反向闭包、private range、override和cache churn。不要只测全依赖CurrentRequest的一条链或用空Entry堆“深度”。

P03：默认初始微基准预算：记录基准机上300-node代表性warm Entry enter+dispose（空setup、不含网络）p95≤2ms；同时记录v0.4同机可比较baseline。该值是本轮目标不是跨机器保证。应用请求自身另报端到端数据，不能套用微基准预算。

P04：至少10,000次selector/Entry依赖请求churn，检查plan/cache/registry/realm/Env索引不会随请求线性增长；另有大量不同shape的LRU压力。报告counts与evictions，不只heap一个数字。

P05：大量租户identifier、有限并发active leases的工作集测试；热点/长尾/配置版本频繁更新后，Env数量、pending creations、draining与idle数据有界。使用多段heap趋势与GC后样本，不用单次负增长宣布“零泄漏”。所有lease活跃时验证背压，而不是超限关掉。

P06：缓存key优先简单稳定结构identity；不要每条template长期持有巨型拼接字符串或短命input。可用hash但须collision处理。先证明缓存不改语义，再优化。

P07：预算在初版application/benchmark建立后、正式优化前锁定到可机读配置。若平台噪音或宿主能力导致不可达，提供证据、状态为性能未达标/阻塞，不能事后偷偷抬阈值或删除场景。

## 11. 可维护性与质量底线

- TypeScript strict；公共边界无随意any，内部不可避免的type erasure集中、注释不变量并测试；禁止as unknown as到处抹掉类型错误。
- 尽量无巨型Runtime类。以DefinitionCompiler、Candidate/Realm resolver、Planner、Slot reuse、Materializer/Attempt、EnvLifecycle、ImplementationView为职责边界；不需要严格按这些名字建目录。
- 类型和模块边界阻止Planner执行setup、Materializer改版本、cache捕获Env、diagnostics改变业务成败。
- 抽公共candidate ref/normalization/metadata逻辑，selector与all不复制多份60行逻辑。
- 不用字符串前缀/隐藏`__contract`字段+强转承载内部状态。区分public descriptors与internal compiled records。
- 采用成熟基础库，不自写SemVer/YAML/JSON Schema替代轮子；也不为很小任务引入庞大框架。
- 代码/注释/错误名使用统一清楚的英文；设计、迁移、用户指南可中文。不要写自夸式文档或把“完美/证明无bug”当产品词。
- 重大模块保持易审查；若某文件很长，必须因真实单一职责，而不是以“测试通过”辩护。不要为了行数指标机械搬函数。
- 只选一种工作区包管理器与lockfile，优先沿用基线；不要为了喜好全仓改包管理器。
- 修复文档中的共享资源误关闭示例：Service不能onDispose其并未拥有的dependency。

## 12. 文档、证据与发布验收

必须有一个实际可执行的总验收入口：

```sh
node scripts/verify-v05.mjs --release
```

你负责实现这个入口。它是透明编排器，不是手写“成功”的报告生成器。应能分别运行开发验证与release验证，release不能递归调用自身形成循环。

### G0 工作区验证

从源码构建后运行type tests、unit/regression、真实PostgreSQL/FS集成、Hyla-mini应用矩阵、性能/工作集测试。输出每个子命令、exit code、开始结束时间、pass/fail/skip数及日志路径。必须等待命令实际退出。

### G1 交付验证

生成source zip/tar.gz：包含src、tests、fixtures、lockfile、scripts、docs、必要的测试部署配置。排除node_modules、所有业务数据/密钥、重复旧归档、无关dist、绝对本机路径。可发布package tarball单独包含构建dist。

由最终源码归档解压到新的空目录：按锁定依赖安装、重新编译、运行必跑核心与应用集成测试、执行demo，再打实际package tarball并在独立consumer项目安装，验证自动package version、类型提示对应的编译无错误以及最小运行结果。不能使用原工作目录的dist或node_modules蒙混过关。

归档生成/最终证据避免循环哈希：记录被测源码/lockfile的fingerprint；生成归档后记录archive hash，归档重验报告可作为sidecar引用同一hash；不要要求把包含自身hash的最终报告又打进同一归档。源码修改后，相关证据必须失效并重跑。

外发README、benchmark JSON、sha文件与归档同源。JSON非空、可parse且满足schema；文件清单有src/tests，解包安全且完整。Git provenance只写真实信息：真实base commit、dirty状态、source digest；没有可验证commit就不虚构。未提交diff应纳入source digest说明。

### 最低文档产物

- README：真实安装/开发/四格demo/停止清理指令。
- API_REFERENCE：与当前代码一致，例子能typecheck。
- SEMANTIC_CHANGES_V05：原v0保留项与本轮修订；parent-only、普通Promise、Ready-anchor边界、C.all、Input.read、权限来源。
- MIGRATION_V04_TO_V05：弃用/修正表及例子；旧错误不是静默兼容目标。
- HYLA_MINI：分层、数据模型、site工作集、recipe/auth/cache权限边界与明确非目标。
- PLUGIN_AUTHORING：共享Factory允许依赖什么，输入从哪里来，产物生命周期、并发安全、startup check方式。
- ARCHITECTURE：实际模块依赖，不虚称已实现Prepared等排除项。
- AUDIT：实际finding、复现、修复、测试链接、争议处理、剩余风险。
- VALIDATION/benchmark/working-set原始结果；机器可读release manifest及SHA256SUMS。

### 验收状态

`COMPLETE`：本任务必需的测试、真实后端、核心应用矩阵、预算、独立审查和归档重建均已实际完成，无未解决的已确认阻断性问题。

`PARTIAL`：有代码和已验证部分，但任务内的必要项目仍未完成。明确剩余项，不把局部通过叫全通过。

`BLOCKED`：真正外部条件阻止必需项目运行，列出命令、错误、已经尝试的安全替代与恢复条件。缺PostgreSQL不能用skip把COMPLETE做出来。

重大/高优先级findings以是否破坏明确不变量、租户/资源安全、主路径语义或交付可信度判断，不靠起一个较低severity名字免责。小型非阻断改进可以列入known limits；不能要求无限“零任何意见”。

## 13. 反驳与防守的具体做法

独立审计至少覆盖三条线：

1. **Promise/生命周期**：catch、Helper、race、late resolution、取消交错、cleanup失败、worker关闭。
2. **应用/权限/资源**：双租户、私有range、override、all工厂、site lease/config race、pool是否共享且只关闭一次。
3. **缓存/交付/DX**：cached vs uncached差分、长churn、完整归档重建、真实type consumer、弃用路径。

reviewer每条finding必须提供：触发条件、期望与依据、实际结果、最小程序/测试、严重性与范围。实施者的defense必须用测试或清楚推导回应，不用“这是feature”重命名症状。无法复现的标记不确定，不删报告。

修复后用原probe复验，再加一个附近反例和一个合法对照。审计过程中改变语义必须回到DECISIONS/MIGRATION，不让测试悄悄代替需求。

最后让新的reviewer从最终候选源码/归档出发检查，不预先喂“已无漏洞”的结论。任何生成后的源码修改都使受影响review过期。

## 14. goal 执行与上下文续接

这是长任务，你应持续实施，而不是每回合末尾问“是否继续”。goal的结束依据是实际验收，不是计划写完或某个子agent的口头PASS。

每个阶段完成后更新STATE，向用户输出很短的事实性进展：哪条用例已跑通、哪条失败、接下来处理哪个根因。将关键命令和退出摘要展示在会话中，使goal评估器有实际证据；不要把完整巨大日志反复塞回主上下文。

可保留小而持续更新的context handoff，不重复加载全部历史RFC。避免多轮纯分析没有工具产物，也不要让失去进展的后台shell/subagent无限挂起。使用受控超时、清理自己的进程并保存失败证据。

遇到必须用户介入的外部阻塞，先完成其余可做部分；输出可恢复的STATE与BLOCKED，不生成COMPLETE。审计者不可用时如实标记，不能虚构多个AI的签字。

## 15. 最终回答应是什么

只有工作完成并实际验证后，给用户：

- 当前任务状态与精确版本/源码fingerprint。
- 真实源码、安装包和报告的本地路径、大小、sha256；文件必须存在且已检查内容。
- 从空目录开始运行Hyla-mini、四格验收、全部测试和benchmark的命令。
- 实际测试/集成/性能/工作集数字，清楚标注未跑/skip/硬件范围。
- 本轮明确改变的语义、兼容接口、已解决finding、已知限制。
- 明确未修改远程仓库/未发布npm，除非用户另行授权并实际执行过。

不写“绝对完美”“不可能再有漏洞”“已机械证明整个框架”。不要只交报告，没有源码。不要只交源码，缺主应用和测试。

**现在开始：先检查当前项目和环境，建立最小验收账本，尽快把Hyla-mini第一条真实纵向路径写出来。再依照本任务书推进修复、独立反驳和最终归档重建。**
