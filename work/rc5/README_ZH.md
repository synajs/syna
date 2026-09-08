# Syna 1.0.0-rc.4 独立定向复核

## 结论

**没有复现“eager activation 的 deadline 仍未接上”这个运行时缺陷。**在未修改的 rc.4 上，内部 eager waiter 在配置期限处拒绝，owner 随即 abort；`enter()` 的公开 Promise 继续等待新 Env 的有界关闭，然后才返回 `ENTRY_ACTIVATION_FAILED`。默认 2000 ms grace 下，60 ms load timeout 对应约 2064 ms 的公开返回；若测试在 1200 ms 放行 rollback，返回约 1200 ms。这恰好解释网页审查者给出的现象，并非又一个无法解释的截止机制。

**关闭守卫的当前位置通过了本轮独立检查。**`.dispose()` 仍是 `??=`，但 `disposeEnv()` 在广播前建立 `closing`，重入通过一个微任务后的 `joinClose()` 观察外层发布的关闭 Promise。没有发现与所述代码形状优化相伴的新同步窗口。普通公开调用必须看行为，不应要求私有字段一定采用某种赋值写法。

**测试断言确有重大缺口，已用隔离变异实验验证。**将实际 timeout 放大四倍，N5 文件 8 项仍全部通过；将 Env/Runtime 的重入观察者改为提前 fulfil，五个新增文件 55 项仍全部通过。原生产代码没有这些变异，本轮也没有修改其实现。此结果证明的是测试不能有效排除某些错误实现，不是当前实现仍有那两个错误。

发布建议：不以网页端的 1201 ms 现象要求核心立刻改语义；先统一任务书/规范对等待对象的表述，并补入真正能杀死这两个变异的测试。无需换 API、拓扑模型或重写生命周期。

## 1. 来源与执行范围

- 仓库：`synajs/syna`。
- 固定提交：`b691067b4b9156f4897b2386f088dcda36a288d2`。
- CI run：`34193542725`，已完成且成功。
- Artifact：`10043171791`，下载的完整 ZIP SHA256 为 `46cedea3acfbf17ebb9e9ec82e1408184b38f5654c82c3b2cd2c99629fb9a8b3`，与 GitHub 返回的 digest 相同。
- CI 归档内门禁：COMPLETE，53 步，无失败步骤。它是 b691067 的 Linux/Node 22.23.2/PostgreSQL 16.15 运行；不是用户贴出的 e96871b 的 macOS/Node 26/PostgreSQL 17.10 本地归档。因此两份归档的哈希、fingerprint 不应相互冒用。
- 本地 Node：22.16.0。运行 CI 安装包中的未修改 compiled core；源码与 GitHub 对应 blob 校验一致（见 source-and-scope）。
- 本地 Git/npm 网络无法访问。为加载模块，仅使用环境现有 semver 7.6.3；包声明 ^7.8.5。所有新增探针只使用 exact 1.0.0 定义，不使用范围匹配；仍必须明确：这不是锁文件重建。
- 没有本地重跑全量 PostgreSQL、完整 release gate、21 轮性能比较。
- 复跑了指定五个 rc.4 核心测试文件，55/55；这是变异实验的基线，不拿它充当完整验收证据。
- 全部变异在独立 compiled 副本中运行，原源码和原 compiled core 不变。

## 2. eager：将两个阶段分开观察

### 2.1 源码与规范

`materializer.ts:637–710` 的 waiter deadline 现在覆盖 running attempt，raw 已拒绝但 rollback pending 的 waiter 也会 arm。

`materializer.ts:723–736` 在 rollback 阶段结束 waiter 为 `LOAD_TIMEOUT`，刻意不产生 `attempt-overdue`。所以 `events=[]` 不能证明 deadline 未触发。

`runtime.ts:657–685` 的顺序是：

```text
await activateEnv()
catch failure:
    construct ENTRY_ACTIVATION_FAILED(cause)
    await env.dispose()
    throw failure
```

因此有两个不同的完成时刻：

```text
内部 eager load wait 的结束 T_wait
公开 enter() 的结束 T_enter = T_wait + 失败后的有界 close
```

不是所有一般情形都精确等于 loadTimeout+grace；关闭可能包含更多受依赖链/后代影响的阶段，已有 close 规范继续适用。对本轮单服务、单挂起 rollback 用例，就是等待 cleanup 完成与 grace 到期中较早的一项。

### 2.2 独立真实时钟结果

| 条件 | owner abort 时刻 | enter 最终返回 |
|---|---:|---:|
| timeout 60，grace 40，rollback 不放行 | 60.9 ms | 101.9 ms |
| timeout 60，grace 250，rollback 不放行 | 61.7 ms | 312.3 ms |
| timeout 60，默认 grace 2000，rollback 不放行 | 61.7 ms | 2064.3 ms |
| timeout 60，默认 grace，1200 ms 放行 rollback | 61.6 ms | 1200.2 ms |
| raw 本身 pending，timeout 60，grace 90 | 61.7 ms | 152.4 ms |

全部 eager 情形的最终错误均为 `ENTRY_ACTIVATION_FAILED` / cause `LOAD_TIMEOUT`。在 1200 ms 放行那一行，100/300/600 ms 的采样都是 enter pending、live=1、events=[]，但 owner 早在约 62 ms 已经 abort。

这能复现网页报告的观测，但否定其“activation waiter 没接上，只靠 close 兜底”的归因。没有 deadline 先拒绝，当前 `enterFrom` 就不会因这条路径进入 close。

### 2.3 任务书确有不一致，不能替实施方悄悄抹掉

已读取实际 `work/tasks/SYNA_RC4_EXECUTION_PROMPT.md`。§2.3 写每个 waiter 的期限必须覆盖 eager；§3 更直接写“enter() 必须在期限内以 ENTRY_ACTIVATION_FAILED 结算”。按“期限就是 loadTimeout”的字面阅读，当前公开 enter 不满足这一句。

但现行语义 §11/§13、原有结构化 activation 失败清理，以及本轮测试标题/矩阵，采用的是“内部 load timeout + 新 Env 的 bounded close”。任务书不能同时要求公开 Promise 在 loadTimeout 内结束，又要求它等待可能更长的 rollback，并同时声称不改该行为。

建议以现行 API/规范的结构化清理为准，修订任务书与测试说明为两个保证：内部 waiter 按期限结束并启动 close；公开 enter 在所需 bounded close 后拒绝，不等资源无限结束。若要公开 enter 本身严格以 loadTimeout 为总期限，那需要另行批准错误发布与后台清理的语义变化，不能把它当一个补 timer 的修复。

我上轮只在 180 ms 观察 eager pending，足以参与确认 rc.3 的 waiter 盲区，但不足以单独证明公开 enter 有 60 ms 的总期限。本轮对此明确收窄。

### 2.4 确定性验证

`probes/deadline-contract.mjs` 在独立进程中控制 clock/timer，不修改 Syna，也不以 timer 数量作 oracle：

- t=59：未 abort、enter pending。
- t=60：abort，enter 仍在有界回滚。
- t=2059：未结束 close。
- t=2060：enter 拒绝，cause LOAD_TIMEOUT，Env 已离开 live registry。
- lazy 首个 waiter t=40 超时；t=70 加入的 waiter 到 t=110 才超时。

该探针能拒绝四倍 deadline 的变异，真实时钟探针提供另外一层端到端观察。

## 3. N2/N3：实际守卫可接受，原断言未完整证明它

`EnvImpl.dispose()` / `RuntimeImpl.dispose()` 保留 `??=`，但底层 close 同步 prologue 先写 `closing`，再执行广播；重入通过 `joinClose()` 先让一个微任务，再读取最终的 `disposePromise`。外层调用返回前会完成赋值，普通 Promise 的 reaction 不会在当前栈中提前运行，因此相同关闭的公开观察者加入真实结果。

标记集合的过程与 abort 分两趟；单棵树关闭与 Runtime 全部 root 关闭均有明确入口。`closing`（这次关闭是否已进入）和 `state=disposing`（不再接收新工作）不能混为一个字段，否则递归关闭子树容易出现“以为别人会关闭它”的悬空 join。

本轮独立八种路径：同 Env、Symbol.asyncDispose、child→parent、parent→child、root→root、root→Runtime、Runtime→Runtime、Runtime→child。cleanup 在可控闸门后抛错：

- 放行前两个观察者均 pending，Env 不提前 disposed。
- 两个观察者随后均拒绝。
- 同一 close 的 observer 得到同一拒绝原因；父级与 Runtime 的聚合包装不要求与子级相同对象，但保留相同底层失败，且各自一次。
- cleanup 只执行一次。
- 已在关闭集合内的 dormant setup 没有执行。

另以真的 `attempt-abandoned` 事件触发 onEvent 重入，两个 observer 同样得到正确失败。

因此没有发现该入口代码形状优化留下的新行为窗口。但这不意味着 benchmark 报告的引擎归因已经被本轮独立证明。

## 4. 对新增五个测试文件的断言审计

### 4.1 可证明的两个漏检，不只是读代码挑字眼

#### M1：重入观察者提前 fulfil

仅在隔离 compiled 副本中将 Env 和 Runtime 的两处 `joinClose()` 改为：

```ts
await null
return
```

真正的 close 仍然照常进行；只是重入者不再等它，也不再得到其错误。这明确违反 N2。

五个新增测试文件仍 **55/55 通过**。原因是 `rc4-close-invariants.test.mjs:78–85` 对外层结果检查“不是 resolved”，对内层只是 `await codeOf(holder.inner)`，没有断言返回值。cleanup 不重复，不能证明内层观察到了正确结果。

`close-guards.mjs` 对同一个变异会立即失败：`same-env: inner ended early`。这验证新增探针确实覆盖原测试遗漏，不是多跑一遍相同的正常路径。

#### M2：deadline 四倍延后

仅在隔离 compiled 副本中把 DeadlineQueue 入队时间的 `deadlineMs` 改成 `deadlineMs * 4`，返回的错误详情仍写原值。

N5 文件仍 **8/8 通过**：40 ms 的两项判断只要求 `[35,400)`，eager 只要求 `<1000`，其他项主要检查错误码或最终状态。

这证明测试可以遗漏严重的期限偏差。但这是刻意注入的错误，不是当前 rc.4 已经四倍超时；当前版本通过独立虚拟时钟和真实时钟验证。

本轮没有声称变异通过了完整 release gate。变异只在原测试执行所用 compiled 副本里生效；真正 gate 的重建会重新编译源文件，不能混淆。

### 4.2 逐文件评价

| 文件 | 有效部分 | 缺口/建议 |
|---|---|---|
| `rc4-waiter-termination` | catch 后 rollback 期限、后加入 waiter、重试与终局错误都有实际断言 | deadline 窗口过宽；eager 缺内部 abort/开始关闭时刻；补上述二阶段确定性验收 |
| `rc4-close-invariants` | 外层失败、cleanup 单次、关闭集合内不启动新 setup 的断言有效 | 内层 outcome 未断言；普通成功服务不产生事件，onEvent 场景实际 callback=0；应强制产生事件并断言回调发生 |
| `rc4-cleanup-phase` | cleanup 执行身份、已知错误、被阻塞步骤、晚到结果与账本有明确断言，不能一概说“只证明会结束” | 多处用 sleep(5/20) 假定阶段到位；建议换成进入 cleanup/phase 的闸门；测试本身加独立 watchdog 防永久挂住，不把 watchdog 当语义期限 |
| `rc4-retention` | 四条路径、无关 payload、负/正对照与子进程 GC 很有价值 | `after runtime.dispose(): same four paths` 实际只测 rollback+Ready cleanup；矩阵承认是两条，改标题或补另两条；固定 GC 轮数不是语言保证 |
| `rc4-graph-property` | 独立可达性 oracle、cleanup 级身份、覆盖下限，不用墙钟 | 它证明顺序/次数/归集，不证明 timeout、重入或 GC；无需把这些硬塞回随机图 |

N5 的“no overlap after cancelled waiter”单项还可加强：其后续五个 load 都使用已 aborted 的 signal，可能在到达共享 attempt 前就被拒绝。加入真正活跃的 waiter，保持 rollback 闸门未放行，再检查 setup 数不变和 caller 自行超时/取消。其他 joined 用例提供部分交叉覆盖，因此不是说整个 suite 完全没有检查 no-overlap。

### 4.3 应用测试同类问题（静态阅读，未本地执行）

`rc4-acquire-deadline.test.mjs` 的 40 ms case 允许 <400 ms，80 ms case 允许 <600 ms，300 ms disposal case 允许 <1000 ms。确有同类宽上界，但本轮没有重跑这套集成测试，也没有将该阅读发现宣称为 A4 未修复。

### 4.4 报告覆盖数字需按实际矩阵表述

“5 个调用点 × 6 种形状全绿”容易让人理解成 30 个 cell。实际代码/公开 MATRIX 是 Ready 6、rollback 6、discarded-late-success 3、late-settlement 3、unreachable 1，另加 invariants 等测试。矩阵比简报准确，不应把简报笛卡尔积当成真实覆盖数。

## 5. Benchmark、归档与文档

- 对比 rc.3 与 rc.4 的真实 CI 源码归档，四个规划层模块字节一致。
- `scripts/benchmark-compare.mjs` 字节一致。因此本轮没有看到该比较脚本修改统计量或放宽性能阈值的证据。
- 没有独立重跑 21 轮，也没有独立验证“双峰由哪种 V8 状态造成”。STATE.md 的表格是实施方的实验记录。未执行分支也能影响 JIT 生成形状这一解释并不能单独证明所有性能差异都不是实际成本；正确性测试与生产基准仍需分别成立。
- 以当前公开关闭行为看，guard 留在 disposeEnv 是可接受实现选择。不能仅因 `??=` 还在就判 N2 复发。
- `docs/SEMANTIC_CHANGES_RC4.md §3.2` 的编号列表仍说先创建/发布 Promise，实际实现是先发布 entered guard，重入延后 join。STATE.md 和 runtime 注释是准确版本；此处应同步文档，避免误导下一次维护。
- §11 关于 rollback timeout 不报告 overdue 后紧跟 “Such an attempt is overdue” 的英文衔接不清，宜明确只指 raw setup 仍 pending 的那种情况。这是澄清，不需要改实现。

## 6. 发布前建议

本轮没有确认新的生产运行时 blocker，也不建议把公开 enter 强行改成 loadTimeout 时直接抛错。已经证实必须补的，是验收自身：

1. 统一 eager 的两个时间对象：内部 waiter deadline 与公开 enter 的 rollback-inclusive 完成时刻。
2. 为重入者断言实际结果与放行前状态，不只数 cleanup 次数。
3. 让 onEvent 场景真实产生至少一次目标事件。
4. 给 timeout 采用受控时钟/阶段观测，另保留适度容差的端到端墙钟检查。不要用无限缩紧毫秒阈值解决断言缺口。
5. 将本轮两个变异保留为测试有效性的反例：修订后的相关测试必须能拒绝它们；不必把整套 mutation audit 放进每次 CI。
6. 修正文档/矩阵名称与真实覆盖，不用新 API 解决报告问题。

补完这些，再在锁文件环境中执行已有门禁。这是定向收口，不是开始新一轮无限扩围审计。对于本轮没有执行的完整后端与性能路径，本报告不作“全系统无问题”的承诺。

## 7. 复跑

这不是 Syna 源码包；请使用你自己按锁文件构建的同提交工作区：

```sh
export SYNA_ROOT=/absolute/path/to/syna
export SYNA_CORE="$SYNA_ROOT/packages/core/dist/index.js"

node probes/eager-phases.mjs
node probes/deadline-contract.mjs
node probes/close-guards.mjs
python probes/mutation-audit.py
```

各探针只在自己的进程中使用受控对象/时钟。mutation-audit 复制 compiled core 和原测试到本审计目录的 mutations/ 下，绝不修改 SYNA_ROOT。需要 Node >=22、Python 3，且源工作区已安装运行所需依赖。

`evidence/mutation-results.json` 是原有断言遗漏错误的证据；exit=0 意味着“变异存活”，不是变异实现正确。`independent-kills-*` 则记录独立探针对变异的失败。`rc4-original-tests.log` 是未修改实现上指定五文件的执行基线。所有结果均给出执行范围，不将观察、受控实验与全量发布验证混为一谈。
