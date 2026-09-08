# Syna 1.0.0-rc.4 清理阶段与关闭不变式：实施任务书

> 本轮的核心结论一句话：
>
> **把 cleanup / rollback 建成可独立观察、可脱离 Env 的内部任务；保持调用者期限与资源清理寿命分离；在执行用户回调之前发布完整的关闭状态；按现行渠道契约归集错误。未完成的清理不得启动重叠 attempt，但也不得困住所有 waiter、隐藏已知错误或保留无关的 Env 图。**
>
> 这是要求你实际修改代码、运行测试并交付证据的任务。**本任务书规定要达到的保证，不规定实现答案**——尤其不预先要求"给 rollback 再加一个 timer"。
> 不重构（`materializer.ts` 的拆分推到 rc.5），不改名，不加公开选项，公开面变化仅限 §2.0。

## 0. 来源、任务与完成含义

对象：`github.com/synajs/syna` 的 `main`（当前 `1.0.0-rc.3`，`9c57269`）。目标版本 `1.0.0-rc.4`。

本轮清单来自三方交叉复核，全部由至少两方在按锁文件从源码重建的环境中独立复现：

| 编号 | 问题 | 根因归属 |
|---|---|---|
| N1 | 同一清理阶段内，已确定的 cleanup 失败被后续挂住的 cleanup 藏住，可能永不报告 | B |
| N2 | abort 回调重入 `dispose()`，两条关闭流程竞争同一组 slot，外层提前宣布成功；cleanup 抛错时该失败被**彻底吞掉** | A |
| N3 | 父级 abort 时子 Env 尚未标记，回调可启动关闭集合内的 dormant 服务，并撑破关闭时间上界 | A |
| N4 | 挂起的调用帧强持 `slot`/`owner` → 整张 Env 图与无关 Input 被保留。两条路径：P2 rollback pending、P4 late cleanup pending | B |
| N5 | raw setup 已失败而 rollback 挂住时，waiter 永不结算、无 `LOAD_TIMEOUT`、无事件；**eager activation 同样被挂住** | B |
| A4 | `acquireTimeoutMs` 不覆盖 `create()` 与 `record.creation`；卡在创建中的调用者要等创建返回才拿到 `SITE_MANAGER_CLOSED` | 应用 |
| G1 | `close-matrix.test.mjs:249` 与 `:263` 是零容差的墙钟下界断言，云端 gate 因 40 ms 预算实测 39 ms 而 PARTIAL | 门禁 |
| D2 | §13 关于"剩余保留期由 setup Promise 可达性决定"的表述，在 raw 已结算后不再准确；§11 缺"当前 attempt 终结"的定义 | 文档 |

两条根因：

- **A：Runtime 在自己的不变式只建立一半时同步执行用户代码。**N2 缺"这次关闭的 Promise 已存在"，N3 缺"整棵子树已拒绝新工作"。三处改动缺一不可（见 §2.2）。
- **B：清理阶段只有整体结果，没有过程可见性，也没有独立于调用帧的生命周期。**N1、N4、N5 同源但**要求不同**，一个措施不能自动满足三项（见 §2.3 的反例）。

交付：源码修复；回归测试与验收矩阵（§3）；属性测试（§4）；`docs/SEMANTIC_MODEL.md` §11/§13 澄清；`docs/SEMANTIC_CHANGES_RC4.md`；`docs/API_REFERENCE.md`、`docs/MULTITENANT_BLOG.md` 同步；`CHANGELOG.md`；`docs/HISTORY.md` 记录本轮来自三方交叉复核；gate 从最终归档重建后的真实摘要。

授权范围同前：本地开发与测试，不发布、不打 tag、不推送、不 force push、不动全局设置。

完成不是"探针翻绿"，而是：**八项各有回归测试与矩阵覆盖；§2.1 的两条禁止判据没有被违反；规划层零变化；公开面除 §2.0 外逐项相同。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md` > 三方复核结论 > 现有代码。

规划层（`entry-planner`、`graph-builder`、`definition-compiler`、`plan-cache`）一行不改；reference planner 差分与 explain/inspect 快照逐字不变。

发现第九个问题：记入 `docs/DEFERRED.md`，不顺手修。某项修复必须改公开名字：停下报告。某项修复必须修订 §11/§13 的实质规则（不只是澄清）：停下报告，说明为什么无法在现行规范内达成。

## 2. 裁定与规格

### 2.0 公开面

**默认为零变化。**若某项保证确实需要新的判别值（例如事件的 `phase`、账本的 `state`），Phase A 给出最小必要增量与理由，inventory diff 必须恰好等于该增量并登记进 `docs/API_STABILITY.md`。不新增事件类型、不新增字段、不新增选项、不改任何名字。能用现有值如实表达就不加。

### 2.1 两条被纠正的验收判据（禁止条款）

三方复核纠正了根因报告中的两条验收建议。它们如果被采纳，会逼实现删掉现在正确的行为：

**禁止一：不得要求同一错误在 `dispose()` 与诊断事件中"合计恰好一次"。**
`packages/core/tests/rc3-close-paths.test.mjs:141-173` 明确断言同一个 cleanup 错误在 `dispose()` 的 `AggregateError` 中出现一次、在 `attempt-succeeded-late.cleanupErrors` 中出现一次、仍在等待的 waiter 再得到一次。这是**不同观察者的合法报告**，不是重复。

正确的判据是四条，逐条测：

1. 关闭的错误集合**内部**不重复；
2. 对应事件不重复发射；
3. waiter 自己的结果（`LOAD_CANCELLED`、`LOAD_TIMEOUT`、业务失败）**不决定**关闭是否报告；
4. 已经确定的错误不因同阶段后续工作挂起而消失。

错误的身份按**一次 cleanup 执行的失败**识别，不按 `Error` 对象去重——两个 cleanup 合法地抛出同一个 `Error` 对象仍是两次失败。

**禁止二：不得用精确的 timer 数量断言并发或串行。**
"五个独立 cleanup 只耗一轮 grace"说的是并行耗时，不是物理 timer 数量。复核方对 rc.3 做过只观测 timer 构造的插桩：5 个独立 Ready slot 产生 5 个并发 arm 的 timer，3 条依赖链产生 3 个依次 arm 的 timer。用精确数量锁死既不成立，也会挡住将来合法的共享计时器优化。

应当验证的是**预算归属与启用的先后关系**：每个 slot 的清理阶段各自消费一份预算；链内的后继在前驱结束或被放弃之后才开始；链间可交错。

### 2.2 N2 + N3：用户回调之前发布完整关闭状态（根因 A）

要达到的保证：

1. **任何用户代码（含 abort 监听器）执行之前，这次关闭已经可被观察到**：同一 Env 的并发或同步重入 `dispose()` 加入同一次关闭，观察到一致的结果；不存在"外层提前 fulfilled 而失败被另一条无人 await 的流程吞掉"。
2. **广播取消之前，整个关闭集合已经封闭**：父级 abort 时，其所有后代已处于拒绝新工作的状态；abort 回调无法在关闭集合内启动任何 dormant slot（不是"`load()` 被拒"，而是 `setup()` 根本不执行）。
3. `runtime.dispose()` 的多 root 场景同样满足前两条。
4. **不得修过头**：只关闭一棵树时，另一棵 root 中的 `load()` 必须仍然允许。

已知需要动的三处（复核方已在 `dist` 副本上验证过候选修复行为中性）：`EnvImpl.dispose()` 与 `RuntimeImpl.dispose()` 先建立并发布本次关闭的 Promise 再进入关闭流程；`broadcastClosing` 由"标记与 abort 同一趟深度优先"拆成先标记整棵子树、再统一 abort；`runtime.dispose()` 的 root 循环换成一次覆盖全部 root 的广播。**三处缺一不可**——只修前者时 N3 照样复现，只改 `broadcastClosing` 不改 root 循环时多 root 场景照样复现。

不要把整段关闭推迟到微任务：那会留下"调用 `dispose()` 后仍能 `enter()`／启动新工作"的窗口。同步入口与预先发布必须一起做。

给 abort 外面加 `try/catch` **不是**本项的修复——异常隔离与重入安全是两回事。（补充事实：abort 监听器抛错不会打断广播递归，按 Node EventTarget 语义变成 `uncaughtException`，这不是关闭路径的缺陷。）

### 2.3 N1 + N4 + N5：清理阶段的可见性、寿命与期限（根因 B）

三项同源，**要求不同**，必须分别达成：

| | 缺少的保证 |
|---|---|
| N1 | 已经确定的失败，不能等整个阶段结束后才可见 |
| N4 | 未结束的阶段不能因此强持无关的 Env 图 |
| N5 | 调用者的等待不能失去规定的超时出口 |

复核方给的反例证明"一个预算不能包三项"：`loadTimeoutMs=100`、`disposalGraceMs=2000`、raw 在 10 ms 失败——即使 rollback 在 2000 ms 后被放弃，调用者仍要等到约 2010 ms，100 ms 的 `LOAD_TIMEOUT` 承诺依然没兑现。同理，给整个 cleanup Promise 加预算，也不会暴露预算内早已发生、被后续挂起隐藏的错误。

**N1 的保证。**清理阶段的结果必须逐个 cleanup 可观察：某个 cleanup 结算的一刻，其结果即已确定并可被关闭路径消费。关闭停止等待一个阶段时，该阶段**已确定**的失败仍属于关闭，进入 `dispose()` 的错误集合；未开始或未结束的部分转入账本；迟到结算只报告**之后新增**的错误。同一形状存在于四个调用点（Ready slot 的清理、attempt 的 rollback、`closeUnsettled` 的迟到清理、unreachable 通道），四处同处理。

**N4 的保证。**任何仍然挂起的 continuation 都不得可达 `EnvImpl`、`plan`、`inputSlots`、`slotsByNode`；账本条目、`FinalizationRegistry` held value、事件回调、错误对象、deadline waiter 同样。判据：`slot.ownerEnv` 是强引用，因此"任何跨 `await` 强持 slot"等价于"强持整张 Env 图"——按这条判据扫过全部 `await`。

复核方用一个纯 JavaScript 的可达性对照实验证明：**一个只接收最小清理记录（cleanup 列表、字符串身份、必要的 WeakRef）的独立任务可以继续 `await` 而不保留 Env**。因此"只要还在 `await`，帧就一定持有 `slot`/`owner`"不成立，"唯一出路是给 rollback 加预算并放弃"也不成立。

实现注意（这一点代码审查看不出来，只能用 `WeakRef` + `--expose-gc` 验收）：`const x = …; const ref = new WeakRef(x); await …` 之后即使不再使用 `x`，挂起帧仍会保存它；必须在取值后让它离开作用域（例如放进立即执行的作用域里取完即弃）。

**N5 的保证。**只要 waiter 仍在等待当前 attempt 终结，就不能仅因 raw 已结算而解除它的期限保护；raw 结算之后加入的 waiter 同样要获得期限。到期时只有那个 waiter 得到 `LOAD_TIMEOUT`，清理继续。这必须同时覆盖 **lazy `load()`** 与 **eager activation**（`enter()` 本身现在会被挂住，180 ms 后仍 pending 且无事件）。

**不得引入的东西：**不要在健康 owner 下新增"cleanup 也必须在 `disposalGraceMs` 后被判终局"的全局政策；不要顺手改动文档已明确豁免的 backoff 规则；不要把"raw 已结算而清理未结束"照搬 raw-setup 的 overdue／unreachable 流程——那是不同阶段，诊断与可达性处理都不同。

**必须保持的既有语义：**未结束的 rollback 不得启动重叠 attempt；rollback 在期限内成功时，同 sequence 的重试规则不变；rollback 确定失败时，既有的 `AggregateError`（setup + cleanup）与其后的 `ROLLBACK_FAILED` 规则不变。若你的方案会改变这三条中的任何一条，那属于实质语义修订，停下报告。

### 2.4 A4：调用者期限覆盖完整 acquire（参考应用）

期限现在只覆盖 `readConfigWithin` 与 `reserveCapacity`；`await create(record, config)` 内部的三个 `await` 与 `await record.creation` 都在外面，`shutdown()` 也唤不醒卡在其中的调用者。而 `docs/MULTITENANT_BLOG.md:55` 承诺"整个 acquire 共用一个截止时间"、`:70` 建立了"关闭时结束在途调用者等待"的规则。

要达到的保证：一个 acquirer 的**同一个绝对 deadline** 与关闭通知覆盖配置读取、容量等待、创建、`context/auth` 初始化、加入共享 `record.creation` 的等待。

**责任分工（这是本项最容易做错的地方）：**共享的 creation 负责完成创建、保有资源、处理迟到的 Env；每个 acquirer 用自己的 deadline 等待它。**不得**把某一个 acquirer 的期限变成共享 creation 的期限：第一位调用者超时，不能让仍在等待的第二位一起失败，也不能让共享 creation 因这次超时进入租户创建 backoff。不得只加 `Promise.race()` 就把迟到的 Env 丢掉——创建任务及其资源必须始终有明确的持有者。

不新增设置项，沿用现有错误类型。`await record.disposal`（`manager.ts:445`）同类，一并纳入：限制的是**调用者等待它的时间**，不是停止必要的资源清理。

**明确不是缺陷、不要"修"：**`shutdown()` 总耗时超过 `shutdownTimeoutMs`。`docs/MULTITENANT_BLOG.md:71` 规定收尾是"等 lease 到 `shutdownTimeoutMs` → 报告未归还的 lease → 并发关闭 Env"，后半段由 Runtime 宽限期兜底，文档还建议调大 `disposalGraceMs`。

### 2.5 G1：门禁计时断言

`close-matrix.test.mjs:249`（`wideElapsed >= graceMs`）与 `:263`（`deepElapsed >= graceMs * 3`）是全仓仅有的两条零容差墙钟下界断言，其余同类断言都留了余量。拆成两条各证各的：

1. **结构性、确定性**——在测试文件内拦截定时器构造（house style 已有先例），按 §2.1 禁止二的方式断言预算归属与启用先后关系；顺序用受控闸门断言，不看墙钟。
2. **墙钟**——保留上界；若仍要下界，给明确容差并注明理由，用单调时钟而不是 `Date.now()`。这条必须保留，否则失去"真的会在预算后放弃"的端到端证据。

在 `SEMANTIC_CHANGES_RC4.md` 说明改完之后这两条各能证明什么、不能证明什么。不要把某个具体容差写成普遍定理。

### 2.6 D2：文档澄清

- §13：raw setup 结算之后，剩余保留期由**实际的清理工作及必要记录**决定，不能继续笼统地说"只由 setup Promise 的可达性决定"。
- §13：关闭停止等待的是一个**阶段**，阶段内已确定的失败仍属于关闭（配合 N1）。
- §11：定义"当前 attempt 的终结"，说明 waiter 等待的是它而不是 raw 的结算（配合 N5）。
- §13：明确 `settling` 条目可以长期存在而不违反有界关闭——有预算的是 Runtime 的**等待**，不是任务本身；账本诚实记录未释放的工作是正确行为。（这一条只改文档，不改行为。）

## 3. 验收矩阵

`work/rc4/ROOT_CAUSE.md` 与三方复核报告中的矩阵是起点，Phase A 合并成一份并补齐下列维度：

**N1**：四个调用点 × {先错后挂 / 先挂后错（断言后者在放行前一次也没跑过）/ 两错一挂 / 一错一挂一错 / 全在预算内 / 全挂住}；失败发生在关闭之前、关闭等待之内、该阶段预算之后三种时点分别归属正确；跨格不变式按 §2.1 的四条判据，不用跨渠道去重。

**N2/N3**：{监听器位置：同一 Env / 父 Env / 兄弟 Env / Runtime 层 / `onEvent`} × {重入 `dispose()` / 启动 dormant slot}；每格补"cleanup 抛错时调用者 `await` 到的 Promise 一定拒绝"；多 root；`Symbol.asyncDispose`；`enterFrom` 激活失败路径中的 `await env.dispose()`；反向断言"只关一棵树时另一棵 root 的 `load()` 仍允许"；监听器创建的子 Env 不漏出关闭集合。

**N4**：四条保留路径分别验收——raw setup pending、rollback pending、Ready cleanup pending、late cleanup pending；每条都用对照组 + 无关 Input + `WeakRef` + `--expose-gc` + 跨宏任务多轮 GC；另加一条正对照：用户自己捕获了 Env／payload 时**应当**保留（区分框架保留与用户保留）。

**N5**：lazy `load()`；raw 拒绝之后才加入的 waiter；**eager activation**（`enter()` 必须在期限内以 `ENTRY_ACTIVATION_FAILED` 结算）；对照组（raw 本身 pending 时 `LOAD_TIMEOUT` 正常）；cleanup 在期限内成功时同 sequence 重试照常；cleanup 快速失败时 `AggregateError` 与其后的 `ROLLBACK_FAILED` 不变；清理 pending 期间 waiter 可以退出但**不得**启动重叠 attempt。

**A4**：三个卡点（`enter()`、`context.load()`、`auth.load()`）各卡一次；`record.creation` 与 `record.disposal`；第一个 caller 超时而第二个仍在等待；全部 caller 离开；到期后 record 的归宿（仍完成并可复用，或被关闭——两种都要断言，避免修出泄漏 record）；期限与 `invalidate()` 竞争；`shutdown()` 发生在 `enter()`、校验失败、`record.disposal` 中途。

**G1**：改造后的两条断言；CI 连续多次稳定，不靠重跑碰绿。

## 4. 属性测试（按裁剪后的形状收进 gate）

**收**：随机图的顺序与归集检查——固定种子；判据来自独立的可达性与组件约束，**不得**把被测的 SCC 调度器复制一份当 oracle；错误按"一次 cleanup 执行的失败"识别；失败时打印种子、图 JSON 与操作轨迹。可随机的维度：图结构、SCC、从未物化的中间节点、owner 边界、每个 slot 的多个 cleanup、成功／抛错组合、注册顺序、调用次数。参考成本：200 张图（6–14 service、25% 边密度）的顺序 + 抛错检查约 66 ms。

**不收**：把"随机挂住"放进同一循环——118/200 张图会真实支付宽限期，实测约 3.4 秒，且会把 gate 变成计时敏感的东西。改为十几个闸门驱动的确定场景。

**必须确定构造、不得依赖随机**：N1 的先错后挂、N2/N3 的同步回调重入、raw 已结算而 rollback 未结算、截止前后一轮微任务、waiter 加入／取消、关闭与失败的归属切换、一个 caller 离开而共享 creation 仍为他人服务。

**GC 保留性**继续作为独立的目标测试，不并入属性测试。

## 5. 执行方式

### Phase A：合并矩阵与最小增量（报告点，不停顿）

1. 复现基线：把两轮报告里的探针跑一遍，记录 `work/rc4/BASELINE.md`。
2. 合并出一份验收矩阵（§3 + 两份报告），标出每格的来源。
3. 给出 §2.0 的最小公开面增量与理由（可能为零）。
4. 给出 N4/N5 的方案说明：如何在**不改变 §2.3 末尾那三条既有语义**的前提下达成三项保证；明确说明你选择的组织方式，以及为什么它不需要新增全局 rollback 超时政策。
5. 汇总后直接继续。只有三种情况停下：必须改公开名字；必须实质修订 §11/§13；必须改变 §2.3 末尾列出的既有语义中的任何一条。

### Phase B：根因 A（N2 + N3）

三处改动一个 commit 或三个连续 commit，带 §3 的 N2/N3 矩阵。

### Phase C：根因 B（N1 + N4 + N5）

按你在 Phase A 给出的方案实施；N1 的四个调用点、N4 的四条路径、N5 的两种入口分别带测试。

### Phase D：A4

带 §3 的 A4 矩阵。

### Phase E：G1、属性测试、文档

G1 的两条断言改造；§4 的属性测试进 gate；§2.6 的文档澄清；`SEMANTIC_CHANGES_RC4.md`（N1/N4/N5 为"修到承诺的位置"，N2/N3 为"不变式修正"，D2 为"澄清"，含改写测试清单）；`API_REFERENCE`、`MULTITENANT_BLOG` 同步；`API_STABILITY` 记录（若有增量）；`HISTORY` 记录本轮来自三方交叉复核；`CHANGELOG`；版本 `1.0.0-rc.4`。

### Phase F：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；两轮报告的全部探针以**翻转后的正确行为形式**断言（不得原样收进——它们断言的是缺陷）；规划层零变化；inventory diff 恰好等于 §2.0 的增量；benchmark 与 rc.3 同机交替对比 ±10%，dispose 相关行不得退化；`any` 不增；gate 从最终归档重建；输出真实摘要。

**验证环境要求：**候选修复的回归必须在**完整工作区与锁文件环境**下跑，不得以 `dist` 副本 + 复制测试目录的诊断性验证作为放行依据。

## 6. 验收项

| # | 验收 |
|---|---|
| A01 | 规划层四模块 `git diff` 为空；planner 差分与快照逐字不变 |
| A02 | inventory diff 恰好等于 §2.0 记录的增量（可能为零）；有增量则 API_STABILITY 有登记 |
| A03 | N2/N3：§3 的矩阵全绿；abort 回调中重入 `dispose()` 时调用者的 Promise 一定拒绝（cleanup 抛错场景）；abort 回调无法启动关闭集合内的 dormant slot（断言 `setup()` 未执行）；只关一棵树不影响另一棵 root |
| A04 | N1：四个调用点 × 六种组合全绿；§2.1 的四条判据逐条有测试；**没有任何测试要求跨渠道去重** |
| A05 | N4：四条保留路径的对照组验收通过；正对照（用户自持）仍保留；全部 `await` 已按 `slot.ownerEnv` 判据扫过并在报告中列出 |
| A06 | N5：lazy、后加入的 waiter、**eager activation** 三种入口都在期限内结算；§2.3 末尾三条既有语义有测试守护且未改变 |
| A07 | A4：§3 的矩阵全绿；第一个 caller 超时不影响第二个；共享 creation 不因某个 caller 超时而失败或进入 backoff；到期 record 的归宿有断言 |
| A08 | G1：两条断言按 §2.5 改造；**没有任何测试用精确 timer 数量断言并发或串行**；CI 连续三次稳定 |
| A09 | 属性测试按 §4 的形状进 gate；oracle 独立于被测调度器；失败可复现（种子 + 图 + 轨迹） |
| A10 | §2.6 的四条文档澄清到位；`SEMANTIC_CHANGES_RC4.md` 登记完整 |
| A11 | benchmark ±10%、`any` 不增、gate 从最终归档重建 COMPLETE、provenance dirty=false；回归在完整工作区与锁文件环境下验证 |

## 7. 禁止事项

- 不重构：不拆 `materializer.ts`，不重排测试目录，不合并 gate 脚本（rc.5）。
- 不改任何公开名字；不加公开选项；公开面变化仅限 §2.0。
- 不动规划层。
- **不得要求同一错误跨 `dispose()` 与事件"合计恰好一次"**（§2.1 禁止一）。
- **不得用精确 timer 数量断言并发或串行**（§2.1 禁止二）。
- 不新增"健康 owner 下 cleanup 必须在 `disposalGraceMs` 后判终局"的全局政策；不改动已豁免的 backoff 规则。
- 不改变 §2.3 末尾列出的三条既有语义（重叠 attempt、同 sequence 重试、`AggregateError`/`ROLLBACK_FAILED`）；必须改则停下报告。
- 不把 `shutdown()` 总耗时超过 `shutdownTimeoutMs` 当缺陷"修"。
- 不把两轮报告的探针原样收进测试；必须翻转为正确行为断言。
- 不以 `dist` 副本 + 复制测试目录的验证作为放行依据。
- 不打 tag、不推送、不发布；不以"已完成"的文字代替证据。

若因外部条件阻塞，完成其余部分，记录 `work/rc4/STATE.md`，报告 BLOCKED 并暂停。
