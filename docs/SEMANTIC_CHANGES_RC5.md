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
（`rc4-deadline-clock.test.mjs`）。

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
| M1 重入观察者提前成功 | `rc4-close-invariants.test.mjs` 对内层观察者只 `await`、不断言；"cleanup 只跑一次"对两种实现都成立 | 八条重入路径 × {cleanup 失败 / 成功}：闸门放行**前**内外都未结算且 Env 未 `disposed`，放行后都被同一次关闭答复，且都含同一个底层 cleanup 失败一次 |
| M2 期限四倍 | 40 ms 期限只要求 `35 ≤ elapsed < 400`，eager 只要求 `< 1000` | `rc4-deadline-clock.test.mjs`：受控时钟推进到期限前一毫秒（什么都没发生）与期限那一刻（等待已结束）；eager 分别验证内部期限、有界关闭的边界、公开 Promise 的结果与 cause。端到端墙钟检查保留在 `rc4-waiter-termination.test.mjs`，容差写明（5 ms 定时器提前量、250 ms 调度） |
| `onEvent` 重入 | 服务健康、cleanup 静默，回调实测进入 0 次，该用例什么也没断言 | 先制造真实的 `attempt-abandoned`，**先断言回调发生**，再断言它重入的那次关闭以同一个失败答复它 |
| `rc4-retention` 的四条路径 | 标题说四条，实测两条 | 四条各一个 Service（挂起的 setup、Ready slot 的清理、失败 setup 的 rollback、关闭后才结算的 attempt），账本读作 `abandoned` / `abandoned` / `rolling-back` / `settling`；并写明固定 GC 轮数为什么够，以及为什么循环里不能调用 `deref()` |
| `rc4-cleanup-phase` 的 `sleep` | 用睡眠假定阶段已到位 | 换成阶段闸门：attempt 已开始（`setup()` 跑了）、关闭已进入（停止信号到达 setup）、阶段已到达挂住的那一步、账本已清空。每个用例带独立 watchdog，不作任何断言 |
| no-overlap 的活跃 waiter | 后续五个 `load()` 都带已 abort 的 signal，在触及共享 attempt 前就被拒绝 | 补一个真正在等的 waiter：它加入同一个 attempt、setup 数不变、在 rollback 仍未放行时按自己的期限离开 |
| 应用的三处上界（A4） | `< 400` / `< 600` / `< 1000`，且没有下界 | 单调时钟上的上下界对（配置值 −5 ms，配置值 +250 ms），加上一条**改变判据**的新用例：同一场景在 60 ms 与 360 ms 两种配置下各跑一次，断言两次等待之差就是两个配置之差 |

本轮新增的判据里，没有任何一条是 rc.4 §2.1 禁止的：没有要求同一错误在 `dispose()` 与诊断事件中合计恰好
一次（`rc3-close-paths.test.mjs:141-173` 断言的合计 2 仍然成立），也没有用精确 timer 数量断言并发或串行。

## 3. 内部质量（无行为变化）

见 §4 之后各节：`materializer.ts` 的拆分、测试按行为域重排、gate 脚本合并、`descriptors.ts` 拆目录、
`docs/VALIDATION.md` 重新纳入源码归档。每一项的判据都是"测试一个字符未改即通过"。

## 4. 公开面

`api-inventory` 与 1.0.0-rc.4 的记录逐项相同：0 added / 0 removed / 0 changed / 0 re-documented。
`docs/API_STABILITY.md` 的冻结面不变，本轮不登记任何例外。
