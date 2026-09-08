# Syna 1.0.0-rc.5 测试有效性与内部质量：实施任务书

> 本轮**不改任何生产行为**。第三轮独立审计（rc.4，提交 `b691067`）没有找到需要修改生产代码的缺陷；它找到的是**测试没有守住它们声称守住的不变式**，以及文档与实际实现不符。
> 本轮有两个互相独立、互为验证的部分：
>
> - **A 部分（先做）**：让测试真正证明承诺——用变异实验验证断言的有效性，修正文档与覆盖表述。
> - **B 部分（后做）**：内部质量重构——拆分 `materializer.ts`、重排测试、合并 gate 脚本。
>
> 顺序不可交换。A 部分修好的测试就是 B 部分"重构不改行为"的网；用一张自己都承认漏检的网去接一次重构，等于没有网。

## 0. 任务、权限与完成含义

对象：`github.com/synajs/syna` 的 `main`（当前 `1.0.0-rc.4`，`b691067`）。目标版本 `1.0.0-rc.5`。

审计材料在 `work/rc5/audit/`（用户放入：`README_ZH.md`、`probes/*`、`evidence/*.json`，含两个变异补丁与它们的杀死记录）。

交付：A 部分的测试与文档修正；B 部分的重构；`docs/SEMANTIC_CHANGES_RC5.md`（只登记文档与测试变化，不含语义修订）；`CHANGELOG.md`；gate 从最终归档重建后的真实摘要。

授权范围同前：本地开发与测试，不发布、不打 tag、不推送、不 force push、不动全局设置。

完成不是"全绿"，而是：**A 部分的两个变异被修订后的测试杀死；B 部分前后 `api-inventory`、planner 差分、explain/inspect 快照、benchmark 全部不变；生产行为一行未改。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md` > 审计报告 > 现有代码。

**本轮不改生产行为。**A 部分只动测试与文档；B 部分只搬运和拆分实现，不改变任何可观察行为。若某项修正看起来需要改生产代码，停下报告——那说明它不是测试问题。

发现新的生产缺陷：记入 `docs/DEFERRED.md` 并报告，不在本轮修。

## 2. A 部分：让测试证明它声称证明的东西

### 2.0 前提：eager 的两个时间对象（先纠正表述，再改测试）

第三轮审计与我方复核已经一致确认：**rc.4 的 eager 路径没有缺陷。**内部 eager waiter 在 `loadTimeoutMs` 处到期并触发 owner abort（实测 60 ms 配置下约 80 ms 触发 abort），公开的 `enter()` 随后等待那个半启动 Env 的**有界关闭**才拒绝，携带 `ENTRY_ACTIVATION_FAILED` / cause `LOAD_TIMEOUT`。这是 `enterFrom` 在抛出前 `await env.dispose()` 的既有结构化行为。

`work/tasks/SYNA_RC4_EXECUTION_PROMPT.md` §3 的那句"eager activation：`enter()` 必须在期限内以 `ENTRY_ACTIVATION_FAILED` 结算"**写得过头**，把两个不同的完成时刻当成了一个。rc.4 的测试标题（"within the load timeout plus the close"）比那句任务书准确。

要做的：在 `docs/SEMANTIC_MODEL.md` §11 明确写下两个保证，并让测试分别验证：

1. **内部 eager waiter** 按 `loadTimeoutMs` 结束，并启动 activation 失败关闭；
2. **公开 `enter()`** 在所需的有界关闭完成后拒绝，不无限等待实际资源释放。

**明确不做**：不把 `enter()` 改成在 load timeout 处直接抛错、把关闭留到后台。那是语义变更，需要单独批准错误发布与后台清理的边界，不属于本轮。

### 2.1 两个必须被杀死的变异

审计在隔离的 compiled 副本上注入了两处错误实现，rc.4 的测试**没有发现它们**。修订后的测试必须能杀死它们。

**M1 —— 重入观察者提前成功。**把 `EnvImpl` 与 `RuntimeImpl` 的两处 `joinClose()` 改为 `await null; return`：重入者立刻成功，既不等待关闭也拿不到 cleanup failure，而真正的关闭照常进行。结果：五个 rc.4 测试文件 **55/55 通过**。

漏检原因：`rc4-close-invariants.test.mjs:78-85` 对外层只检查"不是 resolved"，对内层只 `await codeOf(holder.inner)` 而**从不断言它的结果**；`cleanup 只跑一次`不能证明内层观察到了正确结果。

修订要求（对 §3 矩阵的每一格）：

- cleanup 闸门放行**之前**，内外观察者都不得结算，Env 不得提前 `disposed`；
- 放行后抛错时，内外观察者**都拒绝**，且都包含同一个底层 cleanup failure（父级与 Runtime 允许多一层聚合包装，不要求错误对象相同）；
- 正常完成时两者都成功；
- **不得**因此引入跨渠道去重要求（rc.4 §2.1 禁止一继续有效）。

**M2 —— deadline 四倍。**把 DeadlineQueue 入队时间改为 `deadlineMs * 4`，错误详情仍报原配置值。结果：`rc4-waiter-termination.test.mjs` **8/8 通过**。

漏检原因：40 ms 配置的两项只要求 `35 ≤ elapsed < 400`，eager 那项只要求 `elapsed < 1000`；160 ms 与 200 ms 都落在窗口内。

修订要求：

- 用**受控时钟或阶段观测**分别验证三件事：内部 deadline 触发的时刻、回滚等待的边界、公开 Promise 的最终结果与 cause；
- 另**保留**一条有明确容差的端到端墙钟检查（失去它就失去"真的会在期限后放弃"的端到端证据）；
- **不得**把 `< 1000` 草率改成 `< 60`——那会错杀合法的结构化回滚，并制造新的墙钟抖动。

**验收方式**：把两个变异补丁收进 `work/rc5/mutations/`，并提供一个**手动**脚本（不进 gate 的必跑步骤）在隔离副本上应用它们并跑相关测试，断言**测试失败**。gate 里只跑一步：断言该脚本存在且其记录的最近一次运行结果是"两个变异均被杀死"。不要把完整 mutation 引擎塞进每次 CI。

### 2.2 其余三处漏检

| 项 | 现状 | 要求 |
|---|---|---|
| `onEvent` 重入测试 | 用的是正常 Ready、正常 cleanup 的服务，根本不产生诊断事件；实测 `callbackCalls = 0` | 强制产生至少一个目标诊断事件；**先断言回调确实发生**，再检查重入结果 |
| `rc4-retention` 的 "after runtime.dispose(): same four paths" | 标题说四条，实际只测 rollback 与 Ready cleanup 两条 | 补齐另两条，或改标题为实测范围。另：固定 GC 轮数不是语言保证，说明为什么这个轮数足够 |
| `rc4-cleanup-phase` 的 `sleep(5)` / `sleep(20)` | 用睡眠假定阶段已到位 | 换成进入 cleanup / 进入阶段的闸门；测试自身加独立 watchdog 防永久挂住，**但不得把 watchdog 当成语义期限** |

另加一项：`rc4-waiter-termination` 的 "no overlap after cancelled waiter" 后续五个 `load()` 都带着已 abort 的 signal，可能在触及共享 attempt 之前就被拒绝。补一个**真正活跃**的 waiter：保持 rollback 闸门不放行，断言它加入同一个 attempt、setup 数不变、且能自行超时或取消。

### 2.3 应用测试的同类过宽上界

`apps/multitenant-blog/tests/rc4-acquire-deadline.test.mjs`：40 ms 配置允许 `< 400`（第 76、161 行）、80 ms 配置允许 `< 600`（第 184 行）、300 ms disposal 允许 `< 1000`。按 §2.1 M2 的同一原则收紧：阶段观测或受控时钟证明期限本身，墙钟只留有容差的上界。

审计方明确说明它**没有**本地执行这套集成测试，因此这是按同一原则的预防性收紧，不是"A4 未修好"的指控。

### 2.4 文档与覆盖表述

| 项 | 修正 |
|---|---|
| `docs/SEMANTIC_CHANGES_RC4.md §3.2` | 编号列表仍描述早期候选方案（"先创建并发布 Promise"）；实际实现是 `disposeEnv()` 先写 entered guard、重入经一个微任务后 `joinClose()`。`STATE.md` 与 runtime 注释是准确版本，同步到此处 |
| `docs/SEMANTIC_MODEL.md §11` | rollback 阶段的 waiter 到期**不**产生 `attempt-overdue`，其后紧跟的 "Such an attempt is overdue" 衔接不清；明确它只指 raw setup 仍 pending 的情形。另加 §2.0 的两个 eager 保证 |
| 覆盖表述 | rc.4 简报的"5 个调用点 × 6 种形状"读作 30 格，真实矩阵是 Ready 6 + rollback 6 + discarded-late-success 3 + late-settlement 3 + unreachable 1。以真实矩阵为准，`docs/` 与 `work/` 中的相应表述一并更正 |
| `work/tasks/SYNA_RC4_EXECUTION_PROMPT.md` | 不改动历史任务书；在 `docs/SEMANTIC_CHANGES_RC5.md` 中记录 §3 那句的歧义与本轮的纠正 |

### 2.5 A 部分的边界

- 不改生产代码。
- 不引入新的公开面（`api-inventory` 零变化）。
- 不恢复任何被 rc.4 §2.1 禁止的判据（跨渠道去重、精确 timer 计数）。
- 不把断言窗口无限收紧来"解决"漏检——漏检的解法是换判据，不是缩毫秒。

## 3. A 部分的矩阵（在现有基础上补，不重写）

**M1 覆盖**：审计已验证的八种路径——同 Env、`Symbol.asyncDispose`、child→parent、parent→child、root→root、root→Runtime、Runtime→Runtime、Runtime→child——每格按 §2.1 的四条要求断言，其中"放行前两者都 pending"是杀死 M1 的关键判据。

**M2 覆盖**：lazy 首个 waiter、raw 拒绝后加入的 waiter、eager 内部 waiter、eager 公开 `enter()`，各自的时刻分别验证；raw 本身 pending 的对照组。

**其余**：`onEvent` 真实触发；retention 四条路径；cleanup-phase 的闸门化；活跃 waiter 的 no-overlap；应用测试三处上界。

## 4. B 部分：内部质量（A 部分全绿之后再开始）

**前提**：A 部分的所有修订已合并且全绿，两个变异已被杀死。B 部分的每一个 commit 都以此为网。

### 4.1 拆分 `materializer.ts`（1720 行）

按职责拆成若干模块，`materializer.ts` 只保留编排：attempt 与 sequence、waiter 与 deadline 队列、cleanup 阶段、账本与迟到结算、销毁调度。具体切法由你在 Phase A 提出。

**判据**：拆分前后 `api-inventory` 零变化、planner 差分与 explain/inspect 快照逐字不变、benchmark 同机交替 ±10% 且 dispose 相关行不退化、全部测试（含 A 部分新修订的）不改一个字符地通过。**任何需要修改测试才能通过的拆分，都不是纯拆分**——停下报告。

### 4.2 测试按行为域重排（42 文件、11172 行）

现在的文件名按审计轮次组织（`v04-*`、`v05-audit-*`、`v07-s7-*`、`rc4-*`），想知道"dispose 保证什么"要翻五个文件。重排为 `planning/`、`materialization/`、`disposal/`、`errors/`、`refs/`、`inventory/`、`property/`。

- 审计编号保留为测试标题的后缀（如 `[F-PL-02]`、`[N2a]`），保证可追溯；
- 新增 `packages/core/tests/README.md` 给出"旧文件 → 新位置"的映射表；
- 测试内容一个字符不改（只搬运与改文件名）；
- gate 的步骤清单同步。

### 4.3 合并 gate 脚本

`scripts/verify-v05/v06/v07/v08.mjs` 与 `verify-release.mjs` 并存，重复率高。合成一个 `verify-release.mjs` + 每版一份 JSON 步骤清单（历史版本的清单保留，供复现旧发布）。旧脚本从 git 历史可复现，删除。

### 4.4 顺带的两项（低风险）

- `descriptors.ts`（952 行）拆成 `descriptors/` 目录并由 `index.ts` 统一导出——对 `.d.ts` 使用者零影响，`api-inventory` 必须零变化；
- `docs/VALIDATION.md` 重新纳入源码归档（仍排除出指纹）——rc.1 时排除得过头了，拿到 tar.gz 的人会少一份最有用的文档。

## 5. 执行方式

### Phase A：方案（报告点，不停顿）

1. 跑审计的两个变异，确认 rc.4 的测试确实放行它们（`work/rc5/BASELINE.md`）。
2. 给出 A 部分每一项的修订方案与判据，特别是 M2 的受控时钟方案。
3. 给出 B 部分 `materializer.ts` 的切法与模块边界。
4. 汇总后直接继续。只有两种情况停下：某项修正需要改生产代码；或拆分无法在不改测试的前提下完成。

### Phase B：A 部分

§2.1 → §2.2 → §2.3 → §2.4，各一个 commit；每个 commit 后跑变异脚本确认相应变异已被杀死。

### Phase C：B 部分

§4.1 → §4.2 → §4.3 → §4.4，各一个 commit；每个 commit 后跑完整核心测试 + planner 差分 + 快照，确认零行为变化。

### Phase D：文档与交付

`docs/SEMANTIC_CHANGES_RC5.md`（只有"澄清"与"测试有效性"两类，没有"修订"）；`CHANGELOG.md`；`HISTORY.md` 记录本轮由第三轮独立审计的变异实验驱动；版本 `1.0.0-rc.5`。

### Phase E：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；两个变异被杀死；`api-inventory` 与 rc.4 记录零差异；planner 差分与快照逐字不变；benchmark 与 rc.4 同机交替 ±10%；`any` 不增；gate 从最终归档重建；输出真实摘要。

## 6. 验收项

| # | 验收 |
|---|---|
| A01 | 生产行为零变化：`packages/core/src` 的 diff 只包含 §4.1／§4.4 的纯搬运；`api-inventory` 0 added / 0 removed / 0 changed；planner 差分与快照逐字不变 |
| A02 | M1 被杀死：变异脚本在隔离副本上应用 M1 后，修订的测试**失败**；八种路径每格都断言了放行前两者 pending、放行后两者拒绝 |
| A03 | M2 被杀死：应用 `deadlineMs * 4` 后修订的测试**失败**；内部 deadline、回滚边界、公开结果三者分别验证；端到端墙钟带容差的检查仍在 |
| A04 | `onEvent` 测试断言回调确实发生（`callbackCalls > 0`）；retention 覆盖与标题一致；cleanup-phase 无 `sleep` 假定；活跃 waiter 的 no-overlap 有测试 |
| A05 | 应用测试三处上界按同一原则收紧；A4 的行为未变（其原有断言仍通过） |
| A06 | §2.4 的四项文档修正到位；覆盖表述与真实矩阵一致 |
| A07 | B 部分：`materializer.ts` 拆分后测试**一个字符未改**即通过；测试重排后有 `README.md` 映射表且审计编号可追溯；gate 脚本合并且历史清单保留 |
| A08 | benchmark ±10%、dispose 相关行不退化、`any` 不增、gate 从归档重建 COMPLETE、provenance dirty=false；`docs/VALIDATION.md` 在归档中 |

## 7. 禁止事项

- 不改任何生产行为；不改公开名字、语义、默认值。
- 不把 `enter()` 改成在 load timeout 处直接抛错（§2.0）。
- 不恢复跨渠道"合计恰好一次"的判据；不用精确 timer 数量断言并发或串行。
- 不靠收紧毫秒窗口来"修"漏检；换判据，不缩阈值。
- 不把完整 mutation 引擎放进每次 CI。
- **B 部分不得在 A 部分全绿之前开始**；拆分若需要改测试才能通过，停下报告。
- 不修本轮新发现的生产缺陷（若有）——记入 `DEFERRED.md`。
- 不打 tag、不推送、不发布；不以"已完成"的文字代替证据。

若因外部条件阻塞，完成其余部分，记录 `work/rc5/STATE.md`，报告 BLOCKED 并暂停。
