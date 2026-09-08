# Syna 1.0.0-rc.4 语义变更说明（SEMANTIC_CHANGES_RC4）

本文记录 1.0.0-rc.4 相对 1.0.0-rc.3 的保留项、澄清项、修订项与实现修正，格式沿用 `docs/SEMANTIC_CHANGES_RC3.md`。本轮来自一次**三方交叉复核**（`docs/HISTORY.md`）：三方在按锁文件从源码重建的环境中各自复现了同一批问题，其中四项在 rc.3 的关闭路径里、一项在参考应用、一项是门禁自身的测量方法；`work/rc4/ROOT_CAUSE.md` 是根因报告，`work/rc4/BASELINE.md` 是复现基线与每个新测试在修复前的读数。仓库里的回归测试是这些探针**翻转后**的形态——它们断言正确行为，不断言缺陷。

**公开面增量为零。**没有新的事件类型、字段、选项，也没有任何名字被改、被加、被删；`node scripts/api-inventory.mjs --diff` 相对 rc.3 的记录是 0 added / 0 removed / 0 changed / 0 doc-only。规划层（`entry-planner`、`graph-builder`、`definition-compiler`、`plan-cache`）一行未动，reference planner 差分与 explain/inspect 快照逐字不变。

两条根因贯穿本轮：

- **A：Runtime 在自己的不变式只建立了一半时同步执行用户代码。**abort 监听器是文档推荐的取消路径，而它运行时"这次关闭的 Promise"尚未发布（N2），"整棵子树已拒绝新工作"尚未成立（N3）。
- **B：一个清理阶段只有整体结果，没有过程中的可见性，也没有独立于调用帧的生命周期。**已确定的失败被同阶段后续挂起藏住（N1），挂起的 `async` 帧强持 `slot`/`owner` 而保留整张 Env 图（N4），等待者在 raw 结算的一刻失去期限保护（N5）。

## 1. 保留

| 项 | 说明 | 证据 |
|---|---|---|
| 有界关闭的结构与顺序 | 后代先关；每个在途 attempt 最多一个 grace；dependant-first 清理，穿越从未启动的中间 slot；被放弃 attempt 的依赖照常按顺序关闭；`env.state` 与账本分离 | `close-matrix`、`lifecycle`、`v05-audit-lifecycle`、`v05-review-lifecycle`、`v07-s2-state-and-ledger`（全部未改） |
| rc.3 的四条关闭承诺 | L1 Ready slot 的 cleanup 是有界关闭的一部分；L2/L2b 关闭等待过的 cleanup 失败恰好一次进入 `dispose()`，与 waiter 的结局无关；L3 账本不保留已关闭的 Env 图 | `rc3-close-paths`（未改，包括 `:141-173` 断言同一错误在 `dispose()` 与事件里合计出现两次——那是两个观察者各自的契约，不是重复） |
| 未结束的 rollback 不启动重叠 attempt | slot 停在 `starting`，`load()` 加入同一 sequence，`assertNoUnsettledAttempt` 不变 | `rc4-waiter-termination`（"a waiter may leave … no overlapping attempt starts behind it"） |
| 同 sequence 的重试规则 | rollback 在预算内结束后，`failure.attempts` / `delayMs` / backoff 不计入等待者期限的规则逐字不变 | `rc4-waiter-termination`（"a rollback that succeeds leaves the retry rules … exactly as they were"）、`v05-attempts`（未改） |
| 回滚失败的终局 | setup 与 cleanup 一起进入 `AggregateError`，其后 `ROLLBACK_FAILED` 拒绝恢复 | `rc4-waiter-termination`（"still an AggregateError of setup and cleanup … final with ROLLBACK_FAILED"）、`v06-t1-errors`（未改） |
| 默认值与限额 | `limits` 默认 30_000 / 2_000 / 10_000 / 512 逐字不变；本轮**没有**为 rollback 引入新的预算或新的 limit | `v07-expired-forms`（未改） |
| 规划层 | plan、复用固定点、lineage anchor、候选回溯、`check()` / `explain()` / `inspect()` 的输出逐字不变 | `reference-planner`、`v06-snapshots`（未改） |

## 2. 澄清（D2，只改文档，不改行为）

1. **§13 的保留期表述。**rc.3 写的是"attempt 的保留期只由 setup Promise 的可达性决定"。raw 结算之后这句不再准确：还没结束的是清理工作本身。改成分两段说——setup 仍挂起时由用户自己的 Promise 决定，结算之后由实际的清理工作及其必要记录（cleanup 函数、身份字符串、弱句柄）决定。
2. **§13 的"关闭停止等待"的粒度。**关闭停止等待的是一个**阶段**，不是单个 cleanup；阶段里已经确定的失败仍属于关闭，只有尚未确定的部分转入账本与迟到报告（配合 §3.1）。
3. **§11 的"当前 attempt 的终结"。**新增定义：attempt 在 `setup()` 结算**且**由该结算引发的清理阶段结束时才终结；等待者等待的是它，不是 raw 的结算（配合 §3.3）。
4. **§13 的 `settling` 条目。**明确一条账本条目可以长期存在而不违反有界关闭：有预算的是 Runtime 的**等待**，不是工作本身；账本诚实记录未释放的工作是正确行为。

## 3. 修订

### 3.1 N1：清理阶段逐个 cleanup 可观察（修到规范承诺的位置）

`runCleanups()` 过去把失败累进局部数组，整段循环跑完才返回；`disposeServiceSlot()` 对整段 Promise 计时。于是"第 1 个 cleanup 已确定失败"与"第 2 个结果未知"被同一个 Promise 的结算状态混成一类：关闭在宽限期结束时放弃，`dispose()` 兑现，那个已经发生的失败要等挂住的 cleanup 结束才随事件出来，永不结束就永不上报。

rc.4 把清理阶段建成一个独立任务（`CleanupPhase`）：每个 cleanup 结算的一刻，它的失败就被记录下来。关闭停止等待该阶段时，**已确定**的失败交给关闭（进入 `dispose()` 的 `AggregateError`），并从阶段里取走；迟到报告因此只列**之后新增**的失败。同一处理施加在四个调用点：Ready slot 的清理、attempt 的 rollback、迟到结算的清理（`closeUnsettled`）、unreachable 通道。

一条边界要说清楚：**迟到结算的清理没有可以承载它的 `dispose()`**。那个 attempt 正是被关闭放弃的那一个，按 §13 "关闭停止等待的东西由事件报告，因为本该承载它的 `dispose()` 按定义已经返回"。这个调用点上 rc.4 改的是阶段的记录方式与弱持有，不是归属。

证据：`rc4-cleanup-phase`。真实矩阵按调用点分别计数，不是笛卡尔积：Ready slot 的清理 6 种阶段形状、attempt rollback 6 种、被丢弃的迟到成功 3 种、迟到结算 3 种、unreachable 通道 1 种，共 19 格（`work/rc4/MATRIX.md` 逐格列出）；另加 §2.1 四条判据逐条一测，加"关闭之前 / 关闭等待之内 / 该阶段预算之后"三个时点的归属。

### 3.2 N2 + N3：用户回调之前发布完整的关闭状态（不变式修正）

`EnvImpl.dispose()` 与 `RuntimeImpl.dispose()` 都写作 `this.disposePromise ??= …`。`??=` 先判空、再求值右侧、最后赋值，而 `disposeEnv()` 在第一个 `await` 之前同步 `abort()`，`AbortController.abort()` 按规范同步执行监听器。rc.3 里没有任何东西在广播之前标记"这次关闭已经开始"，于是监听器重入 `dispose()` 时看到的 `disposePromise` 仍是 `undefined`，起了第二条关闭流程；两条流程竞争同一组 slot，先到的把 slot 置 `disposing`，后到的空手完成并宣布 `disposed`——调用者 await 到的可能正是空手那条，而一个**确定发生的 cleanup 失败会落进没人 await 的那条被彻底吞掉**。

`broadcastClosing()` 过去把"标记"和"abort"放在同一趟深度优先遍历里，abort 在递归**之前**。于是父级的监听器看到的子 Env 仍是 `ready`，可以在正在关闭的集合里点起一个 dormant 服务——`load()` 会被随后到来的标记拒绝，但 `setup()` 已经执行、副作用已经发生、资源已经获取，然后作为迟到结果丢弃；让那个 setup 挂住，本该 0 ms 结束的关闭要多付一整个宽限期，§13 的时间上界被用户代码撑破。`runtime.dispose()` 的 `for (const root of roots) broadcastClosing(root)` 把同一个洞放大到 root 之间。

三处改动，缺一不可（rc.5 更正：此表在 rc.4 发布时描述的是早期候选方案"先创建并发布 Promise"，实际实现是下面这一种——`disposeEnv()` 先写入"已进入"标记，重入者延后一个微任务再 join）：

1. **`disposeEnv()` 在广播之前把这次关闭标记为已进入**（`env.closing = true`，Runtime 同形）。窗口就在这里：跑用户 abort 监听器的是 `disposeEnv()`，不是 `dispose()`。`EnvImpl.dispose()` 与 `RuntimeImpl.dispose()` 保持 rc.3 的那一行 `??=` 不变（形状敏感，见 `work/rc4/STATE.md` 的 benchmark 记录）。
2. **重入者由 `disposeEnv()` 交给 `joinClose()`**：先让出一个微任务，再 `await this.disposePromise`。外层的 `??=` 在右侧求值返回之后赋值，且不再重新判空，因此重入调用留在字段里的那个 Promise 会被真正那条关闭的 Promise 覆盖；等 `joinClose()` 的微任务运行时，字段里已经是后者。重入者因此加入同一次关闭，并得到它的结果——成功就成功，cleanup 失败就拿到同一个失败。
3. `broadcastClosing()` 拆成两趟——先标记整个关闭集合，再统一 abort——并把 `runtime.dispose()` 的 root 循环换成一次覆盖全部 root 的广播。

同步入口保持同步：关闭没有任何一段被推迟到微任务，所以不存在"调用 `dispose()` 之后仍能 `enter()`"的窗口。给 abort 加 `try/catch` **不是**本项的修复（异常隔离与重入安全是两回事）；补充事实：abort 监听器抛错不会打断广播递归，按 Node `EventTarget` 语义变成 `uncaughtException`，这不是关闭路径的缺陷。

一处收紧了错误码：父级关闭时监听器在**已标记**的子 Env 上 `enter()`，现在在规划期就得到 `ENV_CLOSED`，而不是活到一半才发现的 `ENTRY_ACTIVATION_FAILED`。同一场景下更早、更准确的拒绝，没有新增名字。

证据：`rc4-close-invariants`（八条重入路径 × {cleanup 失败 / cleanup 成功}，每格断言放行前内外观察者都未结算、放行后都被同一次关闭答复；另有 {监听器位置} × {启动 dormant slot} 的 N3 矩阵，含多 root、`Symbol.asyncDispose`、`onEvent`、`enterFrom` 激活失败路径、"只关一棵树时另一棵 root 仍可用"的反向断言、监听器造出的 Env 不漏出关闭集合、关闭时间上界不被撑大）。rc.5 补齐了其中"内层观察者的结果"这一格——rc.4 只 await 它而没有断言它，见 `docs/SEMANTIC_CHANGES_RC5.md`。

### 3.3 N5：等待者等待的是当前 attempt 的终结（修到规范承诺的位置）

raw Promise 结算的一刻，`runAttempt` 过去解除**所有**等待者的 deadline，`waiterTimedOut` 还有一道 `rawSettled → return` 的保险，而新加入的等待者根本不 arm 定时器。于是"setup 在 10 ms 已确定失败、它注册的 `onDispose` 挂住"这一种情况下——**不需要任何关闭动作，在完全健康的 Env 上**——调用者的 `load()` 永不结算、不触发 `LOAD_TIMEOUT`、不发任何事件、slot 永远停在 `starting`，后续每个 `load()` 一起挂住；eager 服务同理，`enter()` 永不返回。这与 §11 "The load timeout … ends that wait with `LOAD_TIMEOUT`" 直接冲突。

rc.4 让等待者的期限保护持续到**当前 attempt 终结**（§2 澄清 3），而不是到 raw 结算：rollback 期间加入的等待者同样 arm，到期时只有那一个等待者得到 `LOAD_TIMEOUT`，清理继续，slot 仍不接受重叠 attempt。在 rollback 期间到期的等待**不**把 attempt 记为 overdue、不入账本、不发 `attempt-overdue`——setup 没有超时，它的 rollback 才是——`LOAD_TIMEOUT` 的 `details.note` 如实说明这一点。attempt 终结时解除全部期限，所以重试前的 backoff 仍然不计入等待者的期限（§11）。

**没有**为 rollback 引入全局超时政策，也没有新增 limit：健康 owner 下的清理仍然不被判终局。

证据：`rc4-waiter-termination`（lazy `load()`、raw 拒绝后才加入的等待者、eager activation、控制组、以及 §1 表中三条既有语义的守护测试）。

## 4. 实现修正（N4）

§13 承诺"账本上的 attempt 不持有它所属 Env 的任何东西"。rc.3 为 raw setup 仍挂起的那条路径做到了；另外三条路径里有两条仍然保留整张 Env 图，而且**代码审查看不出来**：挂起的 `async` 帧会保存整个寄存器文件，包括此后不再使用的 `slot` 与 `owner` 参数，而 `slot.ownerEnv` 就是 Env 及其 plan、Input payload、兄弟 slot。

- **rollback pending**：`runAttempt` / `runSequence` 挂在 `await this.runCleanups(...)` 上。rc.4 把 sequence 改成由反应驱动而不是一个 `await` 循环：raw 阶段结束就返回，rollback 作为独立任务继续，sequence 的余下部分挂在这个任务上。任务只持有 cleanup 列表、attempt、身份字符串，以及 slot 与 owner 的句柄——关闭停止等待的一刻，这两个句柄从强引用换成弱引用。
- **late cleanup pending**：`closeUnsettled()` 的 `const slot = this.slotOf(attempt)` 横跨 `await`。rc.4 让整个迟到关闭同样走清理阶段任务，弱持有 slot。
- **关闭结束时切断 `slot.ownerEnv`**：有界关闭完成后，Env 不再是任何人的 owner；仍然活着的 slot（被放弃的 attempt、还在跑的清理阶段、期限尚未到的等待者）不得再通过 `slot.ownerEnv` 触及 Env。

判据是"任何跨 `await` 强持 slot 的地方等价于强持整张 Env 图"。按这条判据扫过 `materializer.ts` 的全部 `await`：`recoverFailedSlot` 的 `sleepAbortable` 随 abort 结束，`settleSlot` / `disposeServiceSlot` 在预算处返回，`loadService` 的等待帧随 deadline/abort 结束，`runCleanups` 的帧只持有 cleanup 列表、slot id 与记录器——除上述两条外没有别的。

证据：`rc4-retention`（四条路径 × {closed Env 不可达 / 其无关 Input payload 不可达 / 对照组 Env 也不可达}，`--expose-gc` + `WeakRef` + 跨宏任务八轮 GC，全部在子进程里；加一条**正对照**：用户自己捕获了 Env 时应当保留，`runtime.dispose()` 之后同样验一遍）。

## 5. 参考应用（A4）

`acquireTimeoutMs` 过去只覆盖配置读取与容量等待；`await create(record, config)` 里的三个 `await`（`boundSites.enter()`、`context.load()`、`auth.load()`）与 `await record.creation` 都在外面，`shutdown()` 也唤不醒卡在其中的调用者。20 ms 的超时可以在 85 ms 之后返回一个**成功的租约**。`docs/MULTITENANT_BLOG.md` 承诺的是"整个 acquire 共用一个截止时间"。

rc.4 把"等待"和"创建"分开：一个通用的 `waitWithin()`（形状与 rc.3 的 `readConfigWithin` 相同）绑定**调用者的等待**，共享的 creation 不被取消、不被缩短、继续持有它的 Env，并对后来者可用；`creationWaiters` 与 `configWaiters` 并列，`shutdown()` 一起唤醒。第一位调用者超时不会让仍在等待的第二位失败，也不会让该租户进入创建 backoff。creation 自己持有它所创建的 record（一份 lease），所以调用者离开不会让半成品被回收。到期用现有的 `SiteCapacityError`；**不新增设置项、不新增错误码**。

**明确不是缺陷、没有改**：`shutdown()` 总耗时超过 `shutdownTimeoutMs`。`docs/MULTITENANT_BLOG.md` 规定收尾是"等 lease 到 `shutdownTimeoutMs` → 报告未归还的 lease → 并发关闭 Env"，后半段由 Runtime 宽限期兜底。

证据：`rc4-acquire-deadline`（`boundSites.enter()` 与 `auth.load()` 两个卡点各卡一次、`record.creation` 的第一/第二调用者、全部调用者离开后 record 的归宿、`shutdown()` 中途、与 `invalidate()` 竞争、`record.disposal`、控制组）。`context.load()` 位于两个卡点之间，期限包住整个 `record.creation` 因而按构造覆盖；应用没有暴露可以从外部拦住站点上下文的接缝，测试文件里如实写明了这一点。

## 6. 门禁的计时断言（G1）

`close-matrix.test.mjs` 里"一层关闭只花一个预算"是**两个**命题，过去压在同一次墙钟读数上：`wideElapsed >= graceMs` 是对实测时长的**零容差下界**断言。libuv 可以让定时器提前约 1 ms 触发，`Date.now()` 又把两次读数各自向下取整——云端那次 40 ms 预算实测 39 ms，本机 3000 轮里 8 次落在预算之下（`work/rc4/BASELINE.md` §7）。`:249` 与 `:263` 是全仓仅有的两条零容差墙钟下界断言。

rc.4 拆成两条：

1. **结构性、确定性的一条**：在测试文件内拦截定时器构造（house style 已有先例），断言**预算归属与启用的先后关系**——宽度用例里这一层的每个预算都在其中第一个到期**之前**被 arm（阶段重叠，所以整层只花一个预算的墙钟时间），深度用例里第 n+1 个预算在第 n 个到期**之后**才被 arm（链内串行）；顺序另用受控闸门（cleanup 的实际执行序列）断言。全程不读任何时长。
2. **墙钟的一条**：保留上界，下界改用单调时钟并给出明确容差（`TIMER_SLACK_MS = 5`，与全仓其余同类断言一致）。

改完之后**能证明**：关闭确实为每一层消费了预算；链内串行、链间并发；真实墙钟没有失控。**不能证明**：精确时长；也不能从结构性那条推出"没有别的定时器被 arm"（它只统计延迟等于 `graceMs` 的那些）。墙钟那条必须保留，否则失去"真的会在预算之后放弃"的端到端证据。这里的容差是这两条断言的工程取值，不是普遍定理。

**没有任何测试用精确的 timer 数量断言并发或串行**：五个独立 slot 今天 arm 五个并发定时器，将来合法地共用一个也不会让这些断言失效。

## 7. 属性测试

`packages/core/tests/rc4-graph-property.test.mjs`：固定种子的 seeded PRNG，200 张随机图（6–14 个 service、25% 边密度、0–2 条用 `forward()` 闭合的回边、每个 slot 0–3 个 cleanup、成功/抛错随机、随机的物化子集因而有从未物化的中间节点），断言销毁顺序、每个 cleanup 恰好执行一次、每个 cleanup 失败在 `dispose()` 的错误集合里恰好出现一次、结束后无残留。

判据独立于被测调度器：顺序 oracle 是本文件里用广度优先搜索算出的可达性（互相可达即同一个环，不承诺顺序；否则依赖方必须先关完），不是 Runtime 的 SCC 凝聚。失败时打印种子、图的 JSON 与实际的清理序列。测试自身还断言它确实生成了要测的东西（有序对数、互相可达对数、从未物化的 slot 数、生成的失败数）。约 90 ms。

**不收**"随机挂住"：一次挂住要真实支付一个宽限期，会让门禁既慢又对时间敏感——G1 刚给出这一课。那些形状是 `rc4-cleanup-phase` 与 `close-matrix` 里十几个闸门驱动的确定场景。GC 保留性也保持为单独的目标测试（`rc4-retention`），不并入属性测试。

## 8. 公开面

零增量。`node scripts/api-inventory.mjs --diff validation/v1.0.0-rc.3-release/api-inventory.json <current>`：exports 92→92、members 232→232、union members 50→50，added / removed / changed / doc-only 全为 0。`docs/API_STABILITY.md` 因此没有新的登记项，只记录本轮"零增量"这一事实。

## 9. 撤回与改写的测试清单

| 测试 | 改动 | 原因 |
|---|---|---|
| `packages/core/tests/close-matrix.test.mjs` "the cleanup step of one Env costs one grace per slot of its longest chain" | 拆成 `structure: …`（拦截定时器 + 闸门顺序）与 `wall clock: …`（单调时钟 + 5 ms 容差） | §6 |
| `packages/core/tests/v07-s7-env-state.test.mjs` "the four codes are declared …" | 内部不变式点位由 5 改为 4，并写明原因 | sequence 由 `for` 循环改成反应链之后，"exhausted setup attempts" 那个不可达点位不复存在（§4） |
| `apps/multitenant-blog/tests/site-manager.test.mjs` F-AP3-04 | 不再断言 `SITE_MANAGER_CLOSED` 携带 `cause: ENV_CLOSED`；改为断言调用者在 shutdown 处**立刻**结束等待（远早于创建返回） | §5：shutdown 现在就地结束调用者的等待，那一刻创建还没有失败，也可能仍会成功，所以没有 cause 可带 |

其余测试一律未改。两轮报告的探针留在 `work/rc4/probes/`，作为基线记录；仓库里的测试是它们翻转后的形态，**没有一个原样收进测试目录**。

## 10. 明确没有做的事

- 没有为 rollback 新增 timer、预算或 limit；没有"健康 owner 下 cleanup 必须在 `disposalGraceMs` 后判终局"的全局政策。
- 没有要求同一错误在 `dispose()` 与诊断事件中"合计恰好一次"——那是两个观察者各自的合法报告（`rc3-close-paths.test.mjs:141-173` 断言的正是合计两次，未改）。
- 没有用精确 timer 数量断言并发或串行。
- 没有拆分 `materializer.ts`（推到 rc.5）；没有改动规划层；没有改任何公开名字。
- 没有把 `shutdown()` 总耗时超过 `shutdownTimeoutMs` 当作缺陷"修"。
