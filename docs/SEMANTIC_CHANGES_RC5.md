# 1.0.0-rc.5 语义与文档变更

> **本轮没有"修订"这一类。**生产行为一行未改：`packages/core/src` 的 diff 只包含纯搬运，`api-inventory`
> 与 1.0.0-rc.4 的记录逐项相同（0 added / 0 removed / 0 changed），planner 差分与 explain/inspect 快照逐字不变。
> 本文只有两类条目：**澄清**（文档说的与实现做的不一致，改文档）与**测试有效性**（测试没有守住它声称守住的
> 不变式，改测试）。
>
> 触发本轮的是第三次独立复核（`work/rc5/README_ZH.md`）。它没有找到生产缺陷；它用两个注入到隔离副本里的
> 错误实现证明了 rc.4 的测试放行它们。两个变异与它们在 rc.4 上的存活记录在 `work/rc5/BASELINE.md`。

## 1. 澄清

### 1.1 eager 激活有两个时刻，不是一个（§11、`API_REFERENCE.md`）

`SEMANTIC_MODEL.md` §11 原来把 eager 激活失败写成一句话："`enter()` 是每个 eager attempt 的等待者：
超过 load timeout 就以 `ENTRY_ACTIVATION_FAILED` / cause `LOAD_TIMEOUT` 失败，回滚关闭新 Env。"这句话
把两个不同的完成时刻当成了一个：

1. **内部等待**按 `loadTimeoutMs` 结束——和任何一次 `load()` 等待一样——并在那一刻启动半启动 Env 的关闭；
2. **公开的 `enter()`** 在那次关闭结束之后才拒绝。它等的是一次**有界**关闭（§13），不是资源本身：挂住的
   rollback 照常在宽限期被放弃，它的迟到成功被这次关闭丢弃，`enter()` 返回时 Env 已不在活动登记表里。

所以 `enter()` 的保证不是 `loadTimeoutMs`，而是"`loadTimeoutMs` 之后再加一次有界关闭"，两段各由自己的
上限约束。独立复核用受控时钟逐毫秒记录了这两个时刻（60 ms 期限、2000 ms 宽限 → abort 在 60，`enter()`
在 2060；把宽限改成 40 → abort 仍在 60，`enter()` 在 100），本轮把同样的观测做成了测试
（`materialization/deadline-clock.test.mjs`）。

`work/tasks/SYNA_RC4_EXECUTION_PROMPT.md` §3 的那句"eager activation：`enter()` 必须在期限内以
`ENTRY_ACTIVATION_FAILED` 结算"按字面读要求公开 Promise 在 `loadTimeoutMs` 内结算，与同一份任务书要求的
"结构化清理之后再报错"不能同时成立。历史任务书不改动；此处记录这个歧义，并以现行 §11/§13 为准。
rc.4 的测试标题（"within the load timeout plus the close"）本来就比那句任务书准确。

**明确没有做**：没有把 `enter()` 改成在 load timeout 处直接抛错、把关闭留到后台。那是语义变更，需要单独
批准错误发布与后台清理的边界。

### 1.2 rollback 期间到期的等待不产生 `attempt-overdue`（§11）

§11 原文把两种情形写在一起，随后一句 "Such an attempt is *overdue*" 的指代不清，读起来像是在说前一句的
rollback 情形。现在分开写：setup 本身仍挂起时到期的等待使 attempt *overdue*（`overdueMs`、账本 `overdue`、
`attempt-overdue` 报告一次）；setup 已结算、rollback 仍在跑时到期的等待**不**是其中任何一件——超时的不是
setup 而是它的 rollback——只有那一次等待结束，`LOAD_TIMEOUT.details.note` 说明是哪一种。实现从 rc.4 起
就是这样，改的只是这段话。

### 1.3 N2 的实现写法（`SEMANTIC_CHANGES_RC4.md` §3.2）

rc.4 那份文档的编号列表描述的是早期候选方案——"`EnvImpl.dispose()` 先建立并发布本次关闭的 Promise，
再同步进入 `disposeEnv()`"。实际实现不是这一种：`disposeEnv()` 在广播之前写入"已进入"标记
（`env.closing`），`EnvImpl.dispose()` 保持 rc.3 的那一行 `??=` 不变；重入者由 `disposeEnv()` 交给
`joinClose()`，先让出一个微任务再 `await this.disposePromise`，那时外层的 `??=` 已经把真正那条关闭的
Promise 写进字段。`work/rc4/STATE.md` 与 `runtime.ts` 的注释一直是准确版本，本轮把文档同步过去，并说明
guard 留在 `disposeEnv()` 的理由（窗口在那里：跑用户 abort 监听器的是 `disposeEnv()`）。

### 1.4 覆盖表述按真实矩阵

"四个调用点 × 六种阶段形状"读起来是 24 格，实际不是笛卡尔积。真实矩阵按调用点分别计数：Ready slot 的
清理 6 种形状、attempt rollback 6 种、被丢弃的迟到成功 3 种、迟到结算 3 种、unreachable 通道 1 种，
共 19 格，`work/rc4/MATRIX.md` 一直是逐格列出的。文档改为按矩阵表述。

## 2. 测试有效性

两个变异（`work/rc5/mutations/`，`node scripts/mutation-audit.mjs`）是本轮的判据。它们在 rc.4 上分别以
55/55 与 8/8 存活；修订后的测试杀死它们。gate 只读那份运行记录，并校验它是从当前这棵树的源码与测试产生的。

| 项 | rc.4 的缺口 | rc.5 的判据 |
|---|---|---|
| M1 重入观察者提前成功 | `disposal/close-reentry.test.mjs` 对内层观察者只 `await`、不断言；"cleanup 只跑一次"对两种实现都成立 | 八条重入路径 × {cleanup 失败 / 成功}：闸门放行**前**内外都未结算且 Env 未 `disposed`，放行后都被同一次关闭答复，且都含同一个底层 cleanup 失败一次 |
| M2 期限四倍 | 40 ms 期限只要求 `35 ≤ elapsed < 400`，eager 只要求 `< 1000` | `materialization/deadline-clock.test.mjs`：受控时钟推进到期限前一毫秒（什么都没发生）与期限那一刻（等待已结束）；eager 分别验证内部期限、有界关闭的边界、公开 Promise 的结果与 cause。端到端墙钟检查保留在 `materialization/waiter-termination.test.mjs`，容差写明（5 ms 定时器提前量、250 ms 调度） |
| `onEvent` 重入 | 服务健康、cleanup 静默，回调实测进入 0 次，该用例什么也没断言 | 先制造真实的 `attempt-abandoned`，**先断言回调发生**，再断言它重入的那次关闭以同一个失败答复它 |
| `disposal/retention` 的四条路径 | 标题说四条，实测两条 | 四条各一个 Service（挂起的 setup、Ready slot 的清理、失败 setup 的 rollback、关闭后才结算的 attempt），账本读作 `abandoned` / `abandoned` / `rolling-back` / `settling`；并写明固定 GC 轮数为什么够，以及为什么循环里不能调用 `deref()` |
| `disposal/cleanup-phase` 的 `sleep` | 用睡眠假定阶段已到位 | 换成阶段闸门：attempt 已开始（`setup()` 跑了）、关闭已进入（停止信号到达 setup）、阶段已到达挂住的那一步、账本已清空。每个用例带独立 watchdog，不作任何断言 |
| no-overlap 的活跃 waiter | 后续五个 `load()` 都带已 abort 的 signal，在触及共享 attempt 前就被拒绝 | 补一个真正在等的 waiter：它加入同一个 attempt、setup 数不变、在 rollback 仍未放行时按自己的期限离开 |
| 应用的三处上界（A4） | `< 400` / `< 600` / `< 1000`，且没有下界 | 单调时钟上的上下界对（配置值 −5 ms，配置值 +250 ms），加上一条**改变判据**的新用例：同一场景在 60 ms 与 360 ms 两种配置下各跑一次，断言两次等待之差就是两个配置之差 |
| 结局由垃圾回收决定的断言（示例 07 第 4 幕、`disposal/bounded-close` F-PL-01、`disposal/state-and-ledger` 用例 2、`materialization/waiters-and-cancellation` K08、`errors/env-state` site 6） | 这些用例的挂起 setup 停在谁都不再引用的 Promise 上。运行时可以证明这样的 attempt 永不结算，于是以 `attempt-unreachable` 关掉它：cleanup 运行、账本清空、slot 变 `disposed`、关闭立即返回。断言写的却是另一种结局（等满宽限期、账本里留着 `abandoned`）；`state-and-ledger` 的文件头还写着“这里没有任何断言依赖 GC”。rc.4 起就是这个形状，`--release` 在从归档解包出来的那棵树上真的撞上了一次（`rebuild-examples`：`close took 2 ms`） | 每个用例把自己挂起 setup 的 resolver 留在手里：attempt 始终可结算，断言的结局就是用例真正制造的那个。另一种结局本来就有确定性的用例（`materialization/waiter-deadline.test.mjs` 在 `--expose-gc` 子进程里强制回收）。判据是“每 10 ms 强制一次 full GC”下整棵核心测试树（338）、应用生命周期用例（65）、七个示例与 blog 演示全绿（`work/rc5/evidence/gc-pressure.md`）；示例打印的那一行与 gate 对它的期望一字未改 |

本轮新增的判据里，没有任何一条是 rc.4 §2.1 禁止的：没有要求同一错误在 `dispose()` 与诊断事件中合计恰好
一次（`disposal/close-paths.test.mjs:141-173` 断言的合计 2 仍然成立），也没有用精确 timer 数量断言并发或串行。

## 3. 内部质量（无行为变化）

每一项的判据都是"测试不改即通过"。`packages/core/src` 的 diff 只包含搬运：函数体一字未动，改的是它们所在的
文件、`this.` 前缀与显式参数。

### 3.1 `materializer.ts` 拆成它所编排的五个关注点

1720 行 → 601 行 + 五个模块，**测试一个字符未改**：

| 模块 | 行数 | 内容 |
|---|---:|---|
| `internal/attempt.ts` | 189 | 一次 `setup()` 执行：`Attempt`、raw 阶段的结束形态、观察这个结束的 race、被登记的 attempt 放掉的句柄（`releaseSlot` / `releaseRaw`） |
| `internal/cleanup-phase.ts` | 144 | `CleanupPhase` 任务本身、cleanup 的执行、把阶段已确定的失败归给等待它的那次关闭 |
| `internal/deadline-queue.ts` | 305 | 进程级 `DeadlineQueue` 与 `Waiters`：一个调用者自己的 Promise、它在当前 attempt 上的期限、到期时的报告 |
| `internal/attempt-ledger.ts` | 409 | 账本：记录、对用户 raw Promise 的终结监视、迟到关闭、unreachable 诊断、放弃时的报告 |
| `internal/slot-disposal.ts` | 202 | 有界关闭对一组 slot 做的事：先给在跑的 attempt 宽限期，再按 SCC 缩图依赖者优先关闭 Ready 的 |

`materializer.ts` 留下把它们串起来的那条序列：`load()` 变成一次等待，等待加入一个 attempt，失败的 attempt
变成 rollback，rollback 决定序列重试还是终结。

**这些模块放在 `internal/` 而不是自己的目录里，是有原因的**：四个测试用列目录的方式扫描 `dist` 与
`dist/internal` 找抛出点和已删除的名字；放进子目录会让它们**悄悄不再覆盖**被搬走的代码，而其中一个会直接
因为读到目录而失败。同样的理由，两处 `Syna internal invariant` 留在 `materializer.ts`——它们在该文件与
`runtime.js` 中的出现次数是被断言的。

### 3.2 测试按行为域重排

43 个按审计轮次命名的文件（`v04-*`、`v05-audit-*`、`v07-s7-*`、`rc4-*`）变成七个按断言内容命名的目录：
`planning/`、`materialization/`、`disposal/`、`errors/`、`refs/`、`inventory/`、`property/`。审计编号留在
测试标题里（`F-PL-01 …`、`N2 …`、`R17 …`、`A03 …`），`packages/core/tests/README.md` 是旧→新的映射表。
除了搬运带来的两处机械后果——到 `../../dist` 的相对路径深度，以及五个文件里按旧名交叉引用别的用例的注释
——内容未改。

### 3.3 gate 脚本合并

`verify-v05/v06/v07/v08.mjs` 是彼此的副本，删除。每个已发布版本一份
`scripts/release-profiles/<version>.json`：从该版本自己的 manifest 里抽出的记录——每一步及其真实命令行、
commit、源码指纹、状态。当前版本的 profile 还带着 gate 读取的常量（benchmark 基线与提交、`any` 预算、
inventory 记录与登记的增量、mutation 记录）和步骤清单；每次运行的最后一步 `release-profile` 把实际记录的
步骤与清单比对——**悄悄不再运行某一步的 gate 是 gate 的缺陷，只有清单看得见它**。

### 3.4 `docs/VALIDATION.md` 重新纳入归档

仍然排除出指纹（它由运行自己的 manifest 生成，运行时还不存在），但重新放进 tar.gz：rc.1 一并排除得过头，
拿到归档的人少了唯一一份说明"验证了什么"的文档。归档里的那份是上一次运行的，落后一个发布；同一个归档里的
`validation/<version>-release/manifest.json` 才是本次运行自己的记录。

### 3.5 停下报告：`descriptors.ts` 不拆

任务书 §4.4 要求把 `descriptors.ts`（952 行）拆成目录，判据是"对 `.d.ts` 使用者零影响"。**这一项没有做，
因为它不满足那条判据。**做出来的版本（七个模块、`api-inventory` 逐项相同 374/374）让四个测试失败：

| 测试 | 它读的东西 |
|---|---|
| `packages/core/tests/refs/slot-state.test.mjs:30` | `dist/descriptors.d.ts` 里 `SlotState` 的七个成员 |
| `packages/core/tests/disposal/state-and-ledger.test.mjs:252` | 同一文件里 `EnvInspection.abandonedAttempts` 的声明 |
| `packages/core/tests/inventory/expired-forms-0.7.test.mjs:52` | 同一文件里 `ServiceRef<T>` 的形状 |
| `packages/core/tests/inventory/expired-forms-0.7.test.mjs:308` | 同一文件里 `RuntimeLimits` 记录的默认值 |

它们不是过时的断言，而正是"零影响"的检验：TypeScript 的声明输出跟随模块结构，拆开之后这些公开声明就不在
`descriptors.d.ts` 里了。让测试改去别处找，等于把判据换掉再宣布满足它。按 §7"拆分若需要改测试才能通过，
停下报告"，此项撤回；`descriptors.ts` 保持原样。

## 4. 公开面

`api-inventory` 与 1.0.0-rc.4 的记录逐项相同：0 added / 0 removed / 0 changed / 0 re-documented。
`docs/API_STABILITY.md` 的冻结面不变，本轮不登记任何例外。
