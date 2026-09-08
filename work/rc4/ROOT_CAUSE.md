# rc.4 根因报告：独立审计在 1.0.0-rc.3（9c57269）之后的五项新发现

只读调查，不修任何缺陷。每一项的判断都有文件、行号与我自己跑出来的观测；无法确认的会明说。

**结论一句话**：五项里有四项（N1、N2、N3、N4）归结为两条根因——**(A) Runtime 在自己的不变式尚未建立时同步执行用户代码**（N2、N3），**(B) 一个"清理阶段"只有整体的结果，没有过程中的可见性，也没有独立于调用帧的生命周期**（N1、N4）。A4 是应用层的期限覆盖不全，G1 是测试的测量方法问题。沿着根因 B 我还找到第六项（N5），它**不需要关闭就能复现**，比清单里的几项更严重。

---

## 0. 我做了什么、临时改了什么、怎么恢复的

- 探针全部在会话临时目录 `<scratchpad>/rc4/` 下（`/private/tmp/claude-501/…`），**没有一个进过仓库**：`n1.mjs`、`n2n3.mjs`、`n4.mjs`、`extra.mjs`、`a4.mjs`、`onevent.mjs`、`waiter.mjs`、`waiter2.mjs`、`n2-error.mjs`、`cost.mjs`、`cost2.mjs`、`observe.mjs`。
- 为了验证"候选修复是否真的解决问题"，我把 `packages/core/dist` **复制**到临时目录，只改副本（`dist/runtime.js`、`dist/internal/materializer.js`），从副本导入。**仓库里的 `packages/core/`、`apps/`、`docs/`、`scripts/` 一行未动。**
- 为了确认候选修复没有改坏别的东西，我把 `packages/core/tests` 也复制到临时目录，让它跑在打过补丁的副本上（下详）。
- 结束状态：`git status --porcelain` 只有本文件一行（`?? work/rc4/`），`git stash list` 为空，仓库内无残留临时文件（`apps/multitenant-blog/work` 未生成）。未提交、未 push、未 tag。

---

## N1 — 同一 slot 上"先抛错的 cleanup + 后挂住的 cleanup"，已确定的错误被隐藏

### 你的初步判断：**成立**，而且比你写的更宽——同一形状出现在四个调用点，不止一个。

### 根因

`runCleanups()`（`packages/core/src/internal/materializer.ts:1436-1446`）把错误累进**局部数组**，只有整段循环跑完才 `return errors`：

```ts
const errors: DisposableError[] = []
for (const cleanup of cleanups.splice(0).reverse()) {
  try { await cleanup() }
  catch (error) { errors.push({ slot: slotId, error }) }
}
return errors
```

`disposeServiceSlot()`（`:1357-1382`）对**整段** Promise 计时：

```ts
const running = this.runCleanups(slot.cleanups, slot.id)
if (!(await settlesWithin(running, this.options.disposalGraceMs))) {
  this.abandonCleanup(slot, running, startedAt)   // :1392
  return
}
```

于是"第 1 个 cleanup 已经确定失败"这件**已知事实**，与"第 2 个 cleanup 结果未知"这件**未知事实**，被同一个 Promise 的结算状态混成一类。`abandonCleanup()` 只把晚到反应挂在 `running` 上，那个已知错误要等挂住的 cleanup 结束才随 `attempt-failed-late` 出来；永不结束就永不上报。

**这与规范冲突**：`docs/SEMANTIC_MODEL.md` §13"Errors of the close itself are exactly the cleanup failures it waited for … Each of them appears exactly once"，以及 `docs/SEMANTIC_CHANGES_RC3.md` §3.2 第 1 条"关闭**等待过**的每个 cleanup 失败……恰好一次进入 dispose() 的 AggregateError"。关闭确实**等待过**这个 cleanup（等满了整个宽限期），它也确实在等待期间失败了。

### 我的观测（grace 15 ms）

```
N1a  ready-slot cleanup: error then hang
    dispose=fulfilled  events=[attempt-abandoned:cleanup]  ledger=[abandoned]
N1a  after releasing the hung cleanup
    events=[attempt-abandoned:cleanup,attempt-failed-late]  ledger=[0]

N1c  two determined failures behind one hang
    dispose=fulfilled  events=[attempt-abandoned]
N1c  after releasing
    events=[attempt-abandoned,attempt-failed-late(2)]

N1e  control, all inside the grace
    dispose=rejected:1  events=[]          ← 同样两个 cleanup，不挂住就正常报告
```

### 最小修复方案（只描述）

把"错误收集"从"阶段结果"里拆出来，让**已确定的失败在确定的那一刻就可见**：

1. `runCleanups(cleanups, slotId, sink?)` 增加一个可选的 `sink: DisposableError[]`，每次 catch 直接 `sink.push(...)`；返回值仍是同一个数组，调用点不变。
2. `disposeServiceSlot()` 自己持有 `sink`，超时走 `abandonCleanup()` 时把 `sink` 里**已经确定**的错误交给关闭：进 `env.attemptOwner.closeErrors`（与 L2 的通道一致，`dispose()` 的 `AggregateError` 里恰好一次），并把它们从 `sink` 中取走。
3. `abandonCleanup()` 的晚到反应只上报**取走之后新增**的错误（`attempt-failed-late` 的 `cleanupErrors` 只列晚到的那些），"恰好一次"因此成立。
4. 同一处理施加在另外三个调用点：`runAttempt()` 的 `:836 / :858 / :881`，以及 `closeUnsettled()` 的 `:1169`（见 N4）。

**公开面**：不触及。事件形状、`phase` 取值、`dispose()` 的 `AggregateError` 形态都不变；变的只是**同一批错误出现的时刻与出口**。

**与语义记录的关系**：属于"修到规范承诺的位置"。但 §13 的那句需要补一个从句，说明粒度：*关闭停止等待的是一个 cleanup 阶段，阶段里已经确定的失败仍属于关闭*。§3.2 第 4 条（"关闭停止等待的东西不进 dispose()"）要相应写成"停止等待时**结果尚未确定**的部分不进 dispose()"。

### 影响面与未测到的维度

| 维度 | 观测 | 说明 |
|---|---|---|
| 先错后挂（N1a） | 复现 | 你报告的那个 |
| **先挂后错（N1b）** | **同一 slot 剩余的 cleanup 根本没开始跑** | `runCleanups` 是顺序循环：挂住的那个之后的 cleanup 一个也没执行。放弃的是**整个剩余阶段**，不只是那一个 cleanup。§13"被放弃的 cleanup 仍在运行、仍持有资源"没有说"它后面的 cleanup 一次也没跑过" |
| 多个错误后挂起（N1c） | 复现，2 个都被隐藏 | |
| **attempt rollback 通道（N1d）** | **复现，而且更彻底** | setup 已确定失败 + rollback 先错后挂：`dispose()=fulfilled`，事件只有 `attempt-abandoned:rollback`，**setup 自身的失败与 cleanup 的失败都不可见**，因为 `runAttempt():858` 之后的一切（`attributeToClose`、`attempt-failed-late`）都在那个 await 后面 |
| **late-settlement 通道（`closeUnsettled():1169`）** | 同形状，未被任何测试覆盖 | 迟到结算的 cleanup 先错后挂时同样隐藏 |
| **unreachable 通道（`runAttempt():836`）** | 同形状 | 极难触发（要 GC 判定 + cleanup 挂住），但代码路径相同 |
| 全部在宽限期内结算 | 正常报告（N1e） | 现有测试只覆盖这一格，所以四个调用点都没被抓到 |

**结论：矩阵少的那一维是"一个 cleanup 阶段内部的多个 cleanup 有不同结局"。** 现有 4×4 close matrix 的每一格里，一个 slot 的 cleanup 阶段只有一种行为。

### 建议的验收矩阵（N1）

每格断言四件事：`dispose()` 的结局、`AggregateError` 里错误的个数与身份、事件序列、账本。

| 调用点 | 阶段内行为 |
|---|---|
| Ready slot cleanup（`disposeServiceSlot`） | ① 先错后挂 ② 先挂后错（断言"后面的 cleanup 在放行前没跑过"） ③ 两错一挂 ④ 一错一挂一错 ⑤ 全部在预算内（控制组） ⑥ 全部挂住 |
| attempt rollback（`runAttempt` rejected 分支） | 同上 ①②③⑤ |
| discarded late success（`runAttempt` ownerClosed 分支） | 同上 ①⑤ |
| late settlement（`closeUnsettled`） | 同上 ①⑤ |

外加一条跨格不变式：**同一个错误在 `dispose()` 与事件里合计恰好出现一次**（把每个错误对象打上标记，最后清点身份，而不是只数个数）。

---

## N2 — abort 回调重入 `dispose()`，两条关闭流程，外层提前宣布成功

### 你的初步判断：**完全成立**。补充三点：Runtime 层有同一个洞；受影响的窗口比想象的窄；后果比"提前宣布成功"更重——**它会把一个 cleanup 错误彻底吞掉**。

### 根因

`packages/core/src/runtime.ts:315-316`

```ts
dispose(): Promise<void> {
  this.disposePromise ??= this.runtime.disposeEnv(this)   // ← 右侧求值期间 disposePromise 仍是 undefined
  return this.disposePromise
}
```

`??=` 先判空、再求值右侧、最后赋值。而 `disposeEnv()`（`:765-767`）在第一个 `await` 之前同步调用 `broadcastClosing(env)`，后者同步调用 `env.abortController.abort()`（`:745`）——`AbortController.abort()` 按规范同步执行监听器。于是用户监听器运行时 `disposePromise` 尚未赋值，重入的 `dispose()` 再起一条 `disposeEnv`。两条流程竞争同一组 slot：先到的一条把 slot 置 `disposing`，后到的一条在 `disposeServiceSlot()` 开头 `if (slot.state !== 'ready') return`（`:1358`）直接跳过，于是**空手完成、`detachEnv`、宣布 `disposed`**。外层 `??=` 最后把 `disposePromise` 覆盖成外层那条，用户 await 到的正是空手的那条。

**Runtime 层同一形状**：`runtime.ts:445` `this.disposePromise ??= (async () => { … })()`，IIFE 的同步前缀里 `for (const root of roots) this.broadcastClosing(root)` 同样先于赋值。

**窗口的精确边界**（实测）：只有"`dispose()` 的 `??=` 正在求值的那个 Env"会分叉。子 Env 的监听器重入 `child.dispose()` 是安全的（`disposeEnv(parent)` 之后 await 到的就是同一个 promise）；`onEvent` 里重入也是安全的（那时 promise 已赋值）。

### 我的观测

```
N2a  abort listener re-enters dispose()      (grace 500 ms)
    outer=fulfilled  afterMs=1  envState=disposed  live=0  cleanupCalls=1  stillHanging=true  events=[]  ledger=0
N2a  the second flow
    inner=fulfilled  events=[attempt-abandoned:cleanup]  elapsedMs=502

N2c  child listener re-enters child.dispose() during the parent close
    outerRoot=fulfilled  afterMs=301  childState=disposed  cleanupCalls=1  events=[attempt-abandoned:cleanup]   ← 安全

N2d  onEvent re-enters dispose() during the close
    outer=fulfilled  ms=62  inner=fulfilled  events=[attempt-abandoned]                                        ← 安全

N2b  abort listener re-enters runtime.dispose()
    events=[attempt-abandoned:cleanup, runtime-attempts-outstanding, runtime-attempts-outstanding]              ← 诊断事件发了两次
```

**更重的后果**：把挂住的 cleanup 换成**抛错**的 cleanup：

```
the caller's dispose(): fulfilled
the flow nobody awaits: rejected:AggregateError(1)
events=[]  ledger=0  envState=disposed
```

`dispose()` 兑现、无事件、账本为空——**一个确定发生的 cleanup 失败被完全吞掉**。这不是"迟报"，是"丢失"。

### 最小修复方案（已在 dist 副本上验证）

`EnvImpl.dispose()`：先建 promise、再调用 `disposeEnv`，任何用户代码运行时 `disposePromise` 都已存在。

```ts
dispose(): Promise<void> {
  if (!this.disposePromise) {
    let settle!: { resolve: () => void; reject: (error: unknown) => void }
    this.disposePromise = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
    this.runtime.disposeEnv(this).then(settle.resolve, settle.reject)
  }
  return this.disposePromise
}
```

`RuntimeImpl.dispose()` 同形（先赋值 promise，再启动那个 async IIFE）。

**验证**（打过补丁的 dist 副本）：N2a 的 `outer` 从 `fulfilled @1ms / events=[] / ledger=0` 变成 `fulfilled @502ms / events=[attempt-abandoned:cleanup] / ledger=1`；吞错那格从 `fulfilled` 变成 `rejected:AggregateError(1)`；N2b 的 `runtime-attempts-outstanding` 只剩一次。

**不会引入死锁**：cleanup 里 `await env.dispose()` 现在与修复前一样有界（实测 grace 60 ms → 94 ms 返回、cleanup 正常收尾），因为 cleanup 运行时 promise 早已赋值，两者本来就是同一个 promise，宽限期到时关闭照常完成。

**公开面**：不触及。**与语义记录的关系**：修到 §13 已经承诺的位置（"关闭是有界的，它的结束就是 Env 的结束"以及"每个 cleanup 失败恰好一次"），无需修订规范。

### 影响面与未测到的维度

- **同源的另一个入口**：`RuntimeImpl.dispose()`（重复诊断事件；若某个 root 的 cleanup 抛错，同样可能落到没人 await 的那条流程）。
- **未测**：兄弟 root 之间的重入（`root1` 的监听器调用 `root2.dispose()`——安全，但没有测试说它安全）；`Symbol.asyncDispose`（`await using`）路径与 `dispose()` 同一入口，行为相同但无测试；`enterFrom()` 激活失败时的 `await env.dispose()`（`runtime.ts:634`）也在同一个 `??=` 上。
- **未测**：两条流程同时走到 `errors.push(...env.attemptOwner.closeErrors.splice(0))`（`runtime.ts:790`）时 `splice` 的先到先得——这正是错误被吞掉的机制。

### 建议的验收矩阵（N2）

| 监听器注册在 | 重入调用 | 期望 |
|---|---|---|
| 同一 Env 的 lifecycle signal | `env.dispose()` | 一条流程；预算被遵守；`attempt-abandoned` 一次；账本 1 |
| 同一 Env | `runtime.dispose()` | 同上；`runtime-attempts-outstanding` 恰好一次 |
| 子 Env | `child.dispose()`（父在关） | 与无重入时逐字一致 |
| 子 Env | `parent.dispose()`（重入祖先） | 一条流程 |
| 兄弟 root | `otherRoot.dispose()` | 两棵树各自一条流程 |
| 多 root × `runtime.dispose()` | 每个 root 的监听器都重入 | 事件与账本与单次关闭一致 |
| cleanup 内部 | `await env.dispose()` | 有界（宽限期到时放弃），不死锁 |
| `onEvent` 内部 | `env.dispose()` / `runtime.dispose()` | 与无重入一致 |
| **错误可见性**（每一格都要） | cleanup 抛错 | 调用者 await 到的那个 promise 一定拒绝，且错误恰好一次 |

---

## N3 — 父级 abort 时子 Env 尚未标记，回调可以启动关闭集合里的 dormant 服务

### 你的初步判断：**成立**，与 N2 **同源但不同因**（详见最后一节）。

### 根因

`packages/core/src/runtime.ts:741-747`

```ts
private broadcastClosing(env: EnvImpl<any>): void {
  if (env.state === 'disposed') return
  env.state = 'disposing'
  env.attemptOwner.closing = true
  env.abortController.abort()                                   // ← 用户代码在这里运行
  for (const child of env.children) this.broadcastClosing(child) // ← 子树在这之后才被标记
}
```

标记与广播是同一次深度优先遍历，`abort()` 在递归**之前**。`disposeEnv()` 自己的文档（`:756-758`）写的是 "refuse new work and broadcast cancellation to the whole subtree … before anything is waited for"，§13 写的是 "Closing first refuses new work and aborts the owner signal of the whole subtree"。实现做不到"whole subtree 先拒绝"。

`runtime.dispose()` 里 `for (const root of roots) this.broadcastClosing(root)`（`:448`）把同一个洞放大到 root 之间：第一个 root 的监听器看到第二个 root 仍是 `ready`。

### 我的观测

```
N3a  parent abort starts a dormant service in a not-yet-marked child
    childStateAtParentAbort=ready  dormantSetupsAfterClose=1  childLoad=ENV_CLOSED  events=[attempt-succeeded-late]

N3d  runtime.dispose(): the first root starts work in the second
    secondStateAtAbort=ready  dormantSetups=1  load=ENV_CLOSED
```

`load()` 本身被拒（子 Env 在下一步就被标记了），**但 `setup()` 真的执行了**——副作用发生、资源被获取，然后作为 `attempt-succeeded-late` 丢弃。

**还有一个后果没人提过：关闭时间上界被撑破。** 让那个 dormant setup 挂住：

```
N3c  close time with vs without the listener-started setup
    graceMs=80  withListener=82 ms  control=0 ms  ledger=1
```

本来 0 ms 结束的关闭，因为监听器在关闭集合里点起一个 setup，多付了一整个宽限期。§13 的"a tree closes in at most one grace per level"是按关闭开始时的树状态算的；用户代码可以在这之后往里加。

### 最小修复方案（已在 dist 副本上验证）

把一次遍历拆成两趟：**先标记整棵子树，再统一 abort**。

```ts
private broadcastClosing(env: EnvImpl<any>): void { this.broadcastClosingAll([env]) }

private broadcastClosingAll(envs: readonly EnvImpl<any>[]): void {
  const subtree: EnvImpl<any>[] = []
  const mark = (node: EnvImpl<any>): void => {
    if (node.state === 'disposed') return
    node.state = 'disposing'
    node.attemptOwner.closing = true
    subtree.push(node)
    for (const child of node.children) mark(child)
  }
  for (const env of envs) mark(env)
  for (const node of subtree) node.abortController.abort()
}
```

并把 `runtime.dispose()` 的 `for (const root of roots) this.broadcastClosing(root)` 换成一次 `this.broadcastClosingAll(roots)`——**这一步不可省**：只改 `broadcastClosing` 时 N3d 仍然复现（实测：`secondStateAtAbort=ready`，setup 照跑），改完才变成 `disposing / dormantSetups=0`。

**验证**：N3a 变成 `childStateAtParentAbort=disposing, dormantSetupsAfterClose=0`；N3b 的 `child.enter()` 从 `ENTRY_ACTIVATION_FAILED` 变成规划期就拒绝的 `ENV_CLOSED`（更准确的错误）；N3c 的关闭时间从 82 ms 回到 0 ms。

**公开面**：不触及（`ENTRY_ACTIVATION_FAILED` → `ENV_CLOSED` 是同一场景下更早、更准确的拒绝，属于错误码在具体情形下的收紧；若要严格保持，可以让 `enterFrom` 在规划前的检查里保留原包装——建议不保留，因为现在的 `ENTRY_ACTIVATION_FAILED` 是"活到一半才发现"的产物）。

**与语义记录的关系**：修到规范承诺的位置。§13 与 `disposeEnv` 的注释都已经写着正确顺序。

### 影响面与未测到的维度

- `enterFrom()` 是**同步**把新 Env 挂到 `parent.children` / `roots` 的（`runtime.ts:604-605`），所以监听器造出的 Env 不会漏出关闭集合——我实测 `live=0, roots=0`，**没有 Env 泄漏**。这一条是好消息，但没有测试守着它。
- **未测**：监听器在**兄弟子树**里 `load()`（N3d 的 Env 版本）；监听器在**已标记但尚未 dispose** 的祖先里 `load()`（应被拒）；监听器往深树的第 3 层加东西；`derive()` / `anchor()` 路径与 `enter()` 同一入口但无测试。
- **未测**：`broadcastClosing` 在 `disposeEnv` 里被**重复**调用（父关子时）——两趟版本必须仍然幂等。
- 参考应用的暴露面很小：`manager.ts:646` 的 abort 监听器只置一个布尔量。

### 建议的验收矩阵（N3）

| 监听器位置 | 动作 | 期望 |
|---|---|---|
| 父 Env | 在子 Env `load()` dormant service | 拒绝 `ENV_CLOSED`，**setup 执行次数 = 0** |
| 父 Env | 在孙 Env `load()` | 同上 |
| 父 Env | `child.enter(X)` | `ENV_CLOSED`；`liveEnvCount` 回到基线；无泄漏 Env |
| 子 Env | 在父 Env `load()`（父已标记） | 拒绝 |
| 兄弟子树 | `load()` | 拒绝（同一次 `env.dispose()` 覆盖的子树内）|
| 兄弟 root，`runtime.dispose()` | `load()` / `enter()` | 拒绝，setup 执行次数 = 0 |
| 兄弟 root，`env.dispose()`（只关一棵） | `load()` | **允许**（另一棵树没在关）——反向断言，防止修过头 |
| 任意 | 监听器里挂住一个 setup | 关闭时间 = 无监听器时的关闭时间（上界不被用户代码撑大） |

---

## N4 — L3 只修了 raw setup 一条路径

### 你的初步判断：**成立**。我把四条路径都测了：**两条仍然保留整张 Env 图**，你报告的 rollback 是其一，另一条（late cleanup）你没测到。

### 根因

`runAttempt(slot, owner)`（`:767`）在三个分支上 `await this.runCleanups(...)`（`:836 / :858 / :881`）。挂起的 async 帧保存整个寄存器文件，其中包括**参数 `slot` 与 `owner`**；`owner` 就是 `EnvImpl`（`slot.ownerEnv`，`runtime.ts:601`），`slot` 又通过 `slot.ownerEnv` 指回 Env。外层 `runSequence(slot, owner)`（`:721`）的帧同样挂在 `await this.runAttempt(...)` 上，持有同样两个引用。账本那边确实做对了（`registerRollingBack():1153` 调用 `releaseSlot()`，`attempt.owner` 只是 `AttemptOwnerRecord`），但**账本不是保留者，挂起的调用帧才是**。

`closeUnsettled()`（`:1166-1169`）是第二条：`const slot = this.slotOf(attempt)` 是一个**强局部变量**，横跨 `await this.runCleanups(...)`。

### 我的观测（1 MB 无关 Input，payload 只由 WeakRef 持有，失败用字符串以免带栈帧；每格都有一个"什么都不欠"的对照 Env）

```
P1 setup pending      subject=env=false payload=false   control=false   ledger=[abandoned]     ← L3 修好的那条
P2 rollback pending   subject=env=true  payload=true    control=false   ledger=[rolling-back]  ← 你报告的
P3 ready cleanup      subject=env=false payload=false   control=false   ledger=[abandoned]     ← 干净
P4 late cleanup       subject=env=true  payload=true    control=false   ledger=[settling]      ← 未被测到的第二条
（放行之后四格都是 env=false payload=false, ledger=0）
```

**保留者就是那两个挂起的帧**，这一点我用诊断补丁钉死了：在 dist 副本里把 `:858` 的 `await this.runCleanups(...)` 改成 fire-and-forget（**只为定位，不是修复方案**），同一场景立刻变成 `env=false payload=false`。

P3 干净是有原因的，也正是修复该抄的样板：`abandonCleanup()`（`:1392-1434`）在放弃时就**结束了调用帧**，把后续反应建在一个只闭包了 `id / slotId / revisionKey / envId / WeakRef<slot>` 的作用域里。

**一个必须写进验收标准的细节**：我第一次修 P4 时写成

```js
const slotProbe = this.slotOf(attempt)
const slotProbeRef = slotProbe ? new WeakRef(slotProbe) : undefined
const cleanupErrors = await this.runCleanups(...)
```

**没有修好**——`slotProbe` 这个此后不再使用的局部变量仍然被挂起帧保存。改成 `const slotProbeRef = (() => { const s = this.slotOf(attempt); return s ? new WeakRef(s) : undefined })()` 之后才收得掉。**所以这一项只能用 WeakRef + `--expose-gc` 的运行时测试来验收，代码审查看不出来。**

### 最小修复方案

分两块，规模不同：

**(a) `closeUnsettled()`——真正的一行级修复。** 把 `slot` 换成"await 前取 `WeakRef`、await 后 `deref()`"，且不留任何强局部。已在副本上验证（P4 → 收得掉）。

**(b) rollback 路径——不是一行，需要一个设计改动。** 只要 `runAttempt` / `runSequence` 还在 await rollback，它们的帧就一定持有 `slot` 与 `owner`；换谁去 await 都一样，因为帧是被**挂起**这件事本身保留的。唯一的出路是让 **rollback 阶段像 Ready slot 的 cleanup 阶段一样有自己的预算和自己的放弃**：

1. `runAttempt` 在 rejected / discarded-late-success 分支上不再直接 `await runCleanups(...)`，而是交给一个 `runRollback(attempt, slotRef, ownerRecord, budget)` 辅助方法，它返回"完成（带错误清单）"或"到期放弃"。
2. 到期放弃时：sequence 以 setup 自身的失败结算（帧展开，Env 可回收），slot 置 `abandoned`，账本记 `rolling-back`（现在这条记录由 `settleSlot` 事后补，改后由放弃点直接记），发 `attempt-abandoned` `phase: 'rollback'`。
3. 预算：owner 正在关闭时用 `disposalGraceMs`；owner 仍然活着时（见 N5）也必须有一个上界，否则 slot 永远卡在 `starting`。
4. `settleSlot():380-386` 现在那段"raw 已结算 → `registerRollingBack`"的补记逻辑可以简化成"确认已被放弃"。

这块改动同时解决 **N1d**（放弃时已确定的错误可以交出去）与 **N5**（sequence 有界结算），三项一处修。

**公开面**：`attempt-abandoned` 的 `phase: 'rollback'` 已存在（rc.3 就有），事件时机提前；`SlotState` 不变。若第 3 条给"owner 存活时的 rollback 预算"引入一个新的 limit，那就是**新增公开选项**——建议不引入，复用 `disposalGraceMs`，并在 §13 写明它现在也是 rollback 阶段的预算。

**与语义记录的关系**：(a) 与 (b) 的保留部分是"修到规范承诺的位置"——§13 白纸黑字："An attempt on the ledger … holds nothing of the Env it belonged to: not the Env, not its plan, not its Input payloads, not its sibling slots. A closed Env whose handle the user dropped is collectable while its abandoned attempt is still pending." (b) 的"rollback 也是有预算的阶段"需要**修订** §13 与 `SEMANTIC_CHANGES` 新增一节。

### 影响面与未测到的维度

- **`slot.ownerEnv` 是强引用**（`runtime.ts:601`），所以"任何跨 await 强持 slot 的地方"都等价于"强持整张 Env 图"。这是放大器，也是排查清单的判据。我按这个判据扫了 materializer 的全部 `await`：`recoverFailedSlot():1276` 的 `sleepAbortable` 在 abort 时结束、`settleSlot` / `disposeServiceSlot` 都在预算处返回、`loadService` 的等待帧随 deadline/abort 结束——**除上述两条外没有别的**。
- **未测**：SCC（循环依赖）里的 rollback 挂住；一个 Env 里多条链同时挂住时的可回收性；`runtime.dispose()` 之后的可回收性（现有 L3 测试只测单个 Env 的 `dispose()`）。
- **未测**：`attempt-unreachable` 路径（`:836`）——它也 await cleanup。

### 建议的验收矩阵（N4）

四条路径 × 三个断言（closed Env 不可达 / 其无关 Input payload 不可达 / 对照组 Env 也不可达），全部 `--expose-gc` + WeakRef + 至少 8 轮 gc：

| 路径 | 触发方式 | 现状 |
|---|---|---|
| setup pending | 关闭时 setup 未结算 | 已绿（rc.3） |
| **rollback pending** | setup 失败、cleanup 挂住 | 红 |
| Ready cleanup pending | Ready slot 的 `onDispose` 挂住 | 已绿 |
| **late cleanup pending** | 放弃后 setup 迟到结算、其 cleanup 挂住 | 红 |

补充格：`runtime.dispose()` 之后的同四格；SCC 内的 rollback 挂住；一个 Env 两条链各挂一条。
每格都要有对照组，并且**断言 `ledger` 的条数**（保证测的是"有东西 outstanding"的状态，而不是"什么都没发生"）。

---

## A4 — `acquireTimeoutMs` 仍不覆盖完整 acquire（参考应用）

### 你的初步判断：**成立**。但其中一条我要纠正：`shutdown()` 本身耗时超过 `shutdownTimeoutMs` 是**已文档化的设计**，不是缺陷。

### 根因

`apps/multitenant-blog/src/site/manager.ts:462-585` 的 `acquireWithin()` 里，期限只覆盖两段：

- `readConfigWithin(tenantId, deadline)`（`:479` → `:228-245`）：rc.3 的 A2 修好了。
- `reserveCapacity(purpose, deadline)`（`:511` → `:347-380`）：容量等待有 `min(acquireTimeoutMs, deadline - now)` 的计时器。

**没有覆盖**：

- `await create(record, config)`（`:529`）→ `create()`（`:401-460`）里的 `boundSites.enter(...)`、`env.deps.context.load()`、`env.deps.auth.load()`，三个 `await` 都不带期限、不带 signal；
- `await record.creation`（`:542`）：加入别人那次创建的等待，同样无界。

`shutdown()`（`:625-643`）唤醒的是 `waiters`（容量队列）与 `configWaiters`（配置读取），**没有任何东西能唤醒卡在 `create()` 里的调用者**。

`docs/MULTITENANT_BLOG.md:55` 的承诺是"整个 acquire 共用一个截止时间"。

### 我的观测（闸门放在站点 authenticator 的 setup 里，即 `create()` 的第三个 await；通过 `extraServices` 注入，未改仓库任何代码）

```
A4a  acquireTimeoutMs=20 ms, the gate is inside create()
    afterMs=85  acquire=still pending  stats={"inFlightAcquires":1,"creating":1}
A4a  after opening the gate
    totalMs=86  outcome={"value":"acquired"}          ← 超期 4 倍后返回的是成功租约，不是超时

A4b  a joining acquirer (await record.creation)
    afterMs=82  second=still pending

A4c  shutdown() with an acquirer inside create()
    shutdown=still pending  shutdownMs=403  acquirer=still pending
    after opening the gate: acquirer=SITE_MANAGER_CLOSED  totalMs=505
```

**纠正**：A4c 里 `shutdown()` 在 403 ms 仍未返回，`shutdownTimeoutMs` 只有 150 ms——但 `docs/MULTITENANT_BLOG.md:71` 明确写着收尾是"等待 lease 到 `shutdownTimeoutMs`，报告未释放 lease，**然后**并发关闭 Env"，关闭 Env 那段由 Runtime 的宽限期兜底（文档甚至给了"要让 Runtime 等完整个收尾就把 `disposalGraceMs` 调大"的建议）。所以**这一条不是缺陷**。缺陷是另一条：卡在 `create()` 里的调用者要等创建自己返回才拿到 `SITE_MANAGER_CLOSED`，这与 rc.3 A3 给配置读取立的规矩不一致。

### 最小修复方案

1. `create()` 的三个 `await` 各自受 `deadline` 约束：给 `create(record, config, deadline)`，用与 `readConfigWithin` 相同的形状——**结束的是这个调用者的等待，不取消共享的创建**（创建仍要跑完并归属于 record，否则会留下无人认领的 Env）。
2. `await record.creation`（`:542`）同样包一层"到期只结束我的等待"。
3. 引入 `creationWaiters: Set<(error: Error) => void>`，与 `configWaiters` 并列；`shutdown()` 里 `for (const cancel of creationWaiters) cancel(new SiteManagerClosedError())`。
4. 到期的拒绝用现有的 `SiteCapacityError`（消息指明是站点创建），与配置读取到期一致；不新增错误码。
5. `stats()` 增加 `inFlightCreations`（可选；`creating` 已经近似覆盖，建议不加，避免公开面增量）。

**公开面**：不触及（沿用现有错误类型；不加新设置项）。**与语义记录的关系**：修到 `docs/MULTITENANT_BLOG.md:55` 已经承诺的位置；:55 那句可以加一句"创建阶段亦然（rc.4 / A4）"。

### 影响面与未测到的维度

- 同一形状还在两处：`disposeRecord()`（`:314-330`）等 `env.dispose()`，由 Runtime 宽限期兜底——**已文档化**，不动；`sweep()` 的 `Promise.all(closing)`（`:612`）同理。
- **未测**：`create()` 在 `boundSites.enter()`、`context.load()`、`auth.load()` 三个位置分别卡住时的行为（我只测了第三个）；创建到期后 record 的归宿（应当仍然完成并被后来者复用，或者被 `settle()` 关掉——两种都要断言，否则修复会造出泄漏的 record）；到期与 `invalidate()` 竞争。
- **未测**：`purpose` 为 `build` / `background` 时的同一路径。

### 建议的验收矩阵（A4）

| 卡点 | 场景 | 期望 |
|---|---|---|
| `boundSites.enter()` | 单个 acquirer，`acquireTimeoutMs=20` | 在 ~20 ms 以 `SITE_CAPACITY` 拒绝；创建本身继续；record 最终成为 active 或被 settle，**不泄漏 Env** |
| `context.load()` | 同上 | 同上 |
| `auth.load()` | 同上 | 同上 |
| `record.creation` | 第二个 acquirer 加入 | 在自己的期限处拒绝，不影响第一个 |
| 任一卡点 | `shutdown()` | 调用者**立刻**得到 `SITE_MANAGER_CLOSED`，不等创建返回 |
| 任一卡点 | 到期后放行 | 创建完成的 record 可被后续 acquire 复用；`creations` 计数正确；无 `creationFailures`、无退避 |
| 控制组 | 创建很快 | 与今天逐字一致（`acquireTimeoutMs` 不缩短正常路径）|

---

## G1 — release gate 的计时断言不稳

### 你的初步判断：**成立**，我实测到了同一现象。

### 根因

`packages/core/tests/close-matrix.test.mjs:249`

```js
assert.ok(wideElapsed >= graceMs && wideElapsed < graceMs * 3, …)
```

这是对**实际耗时的下界**断言，零容差。两个独立效应都能让它落到 39 ms：

1. Node/libuv 的定时器可以比请求的延迟**提前约 1 ms**触发；
2. `Date.now()` 截断到毫秒，两次读数可以各自向下取整。

**实测**（本机，Node 26）：`setTimeout(40)` 用 `Date.now()` 量，2000 次里 **1 次量到 39 ms**，最小值 39。这与云端那次 39/40 完全一致。

**同类风险更高的一条没被抓到**：`:263` 的 `deepElapsed >= graceMs * 3`（三个串联的 40 ms 预算），同样零容差，而它串了三个定时器，每个都可能提前 1 ms。

**全仓对比**：其余同类断言都留了余量——`v07-s2:49` 是 20 ms 预算断言 `>= 15`，`rc3-close-paths:67` 是 60 ms 预算断言 `>= 55`，`v08-deadline-queue` 全部是"预算 − 5 ms"，`rc3-close-paths:170` 是 200 ms 断言 `>= 190`。**`close-matrix.test.mjs:249` 与 `:263` 是全仓仅有的两条零容差下界断言。**

### 稳定化方案

分成两条互不干扰的测试，各证各的：

**(1) 结构性、确定性的那一条（证明"预算被消费了几次"）。** 在测试文件内替换 `globalThis.setTimeout`（house style 已有先例：`work/rc3/probes/site-manager.mjs` 就这么拦 `setInterval`），记录每次 arm 的延迟值与顺序，然后断言：
- 宽度用例：`disposalGraceMs` 的定时器 arm **恰好 1 次**（五个独立 slot 共用一个预算）；
- 深度用例：arm **恰好 3 次**，且是**串行**的（第 n+1 次在第 n 次 fire 之后才 arm）——这正是"每条链一次预算、链内串行"的本意，而且不看墙钟；
- 顺序用两个受控闸门断言（cleanup 开始/结束的先后），而不是耗时。

**(2) 墙钟的那一条（证明"真的有界"）。** 只保留**上界**，容差沿用现有风格：`wideElapsed < graceMs * 3`、`deepElapsed < graceMs * 3 + 220`。若仍想保留下界，写成 `>= graceMs - TIMER_SLACK_MS`（`TIMER_SLACK_MS = 5`，并在注释里写明理由是 libuv 提前触发 + `Date.now()` 截断）。

**改完之后它还能证明什么**：
- 能证明——关闭确实为每一层消费了一个预算而不是零个（(1) 的 arm 次数）；链内是串行、链间是并发（(1) 的 arm 顺序 + 闸门顺序）；真实墙钟没有失控（(2) 的上界）。
- **不能证明**——"恰好等了 40 ms"这种精确时长；也不能再从这条测试推出"没有别的定时器被 arm"（除非把 arm 记录做成白名单断言，建议做：只统计延迟等于 `graceMs` 的那些）。
- 注意 (1) 用假时钟会失去"真的会在 40 ms 后放弃"的端到端证据，所以 **(2) 必须保留**，两条一起才是完整的。

### 影响面与未测到的维度

- 建议顺手给 `:263` 同样处理（它风险更高）。
- gate 里所有"墙钟下界"断言都应过一遍 5 ms 余量的尺子；本轮扫描结果是只有这两条不合规。
- **未测**：在负载很高的机器上（gate 与 benchmark 同机顺序跑）上界 `graceMs * 3` 是否够宽——`:249` 的上界是 120 ms 而实际约 40 ms，余量充足；`:263` 的上界是 340 ms 而实际约 120 ms，也充足。

---

## N5（清单之外的新发现）— rollback 挂住时，`load()` 永不结算，且 `loadTimeoutMs` 不再兜底

沿着 N1/N4 的根因往下查时找到的，**不需要任何关闭动作**，在完全健康的 Env 上就能复现。

### 观测

```
loadTimeoutMs=100，Env 从未关闭：
    waiter=pending after 517 ms; envState=ready; slot=[starting]; events=[]
    a second load() while the rollback hangs: pending（300 ms 后仍然）
```

setup 在 10 ms 处**已确定失败**，它注册的 `onDispose` 挂住；此后：调用者的 `load()` 永不结算、**不触发 `LOAD_TIMEOUT`**、不发任何事件、slot 永远停在 `starting`、后续每个 `load()` 也一起挂住。

### 根因

- `runAttempt():806` 在 raw Promise 结算的一刻 `for (const waiter of slot.waiters) this.disarm(waiter)`——**所有等待者的 deadline 在这里被解除**；
- `waiterTimedOut():624` 还有一道 `attempt.rawSettled → return` 的保险，即便定时器还在也不会超时；
- 等待者真正 await 的是 `slot.sequence`，而 sequence 要等 `runAttempt` 从 `:858` 的 rollback await 回来；
- 新来的 `load()` 走 `:663 case 'starting': return slot.sequence!`，而 `waitFor():590` 的 arm 条件是 `attempt.state === 'running' && !attempt.rawSettled`——**rawSettled 之后加入的等待者根本不 arm 定时器**。

这与 §11 的承诺直接冲突："The load timeout … bounds one `load()` wait on the current attempt … and ends that wait with `LOAD_TIMEOUT`"。

### 修复

被 N4(b) 的设计改动一并覆盖：rollback 成为有预算的阶段之后，sequence 在预算处以 setup 的失败结算，所有等待者随之结束。若要更保守，可以只补 `waitFor` 的 arm 条件（rawSettled 之后仍 arm，超时按"rollback 未结束"报告）——但那只让调用者拿到 `LOAD_TIMEOUT`，slot 仍然永远卡在 `starting`，第二个 `load()` 仍然无望，所以**不建议只补这一半**。

### 验收

`loadTimeoutMs=100`、rollback 挂住、Env 保持 ready：第一个 `load()` 在预算处结算；第二个 `load()` 也在自己的预算处结算；slot 状态离开 `starting`；账本有一条；放行后账本清空。控制组：rollback 很快 → 与今天逐字一致。

---

## 综合结论

### 1. N2 与 N3 是否同源

**同一个大类，不同的具体缺陷；一处修不了两个，但应该在同一次改动里一起修。**

共同点：两者都是"**`abortController.abort()` 同步执行用户代码，而此时关闭的不变式只建立了一半**"。区别在于**半建立的是哪一个**：

- N2：缺的是"**这次关闭的 promise 已经存在**"——`??=` 的赋值发生在 `disposeEnv` 返回之后。修法在 `EnvImpl.dispose()` / `RuntimeImpl.dispose()`。
- N3：缺的是"**整棵子树都已拒绝新工作**"——标记与 abort 在同一趟遍历里。修法在 `broadcastClosing()` / `runtime.dispose()` 的 root 循环。

我实测过：只修 N2 时 N3 照样复现（`childStateAtParentAbort=ready`），只修 `broadcastClosing` 而不改 root 循环时 N3d 照样复现。三处改动缺一不可。

值得记一笔的对照：Runtime **已经**隔离了另一个用户代码面——`onEvent` 在 `runtime.ts:352-356` 被 try/catch 包住，我实测它抛错既不会破坏关闭也不会产生 unhandled rejection。同样的自我保护没有施加在 abort 监听器上，而 abort 监听器恰恰是文档推荐的取消路径。**这条不对称就是 N2/N3 的本质。**

### 2. 属性测试提议的评估

**可行，值得收，但按提议的形状收进来抓不到本轮任何一项。**

成本（本机实测）：

- 200 个随机图（6–14 个 service、25% 边密度）、每张图 enter + 全量 load + dispose + 校验销毁顺序：**41 ms**；带随机抛错的版本 **25 ms**。基本免费。
- 同样 200 张图，加上"随机 cleanup 行为（正常 / 抛错 / **挂住**）"、宽限期 20 ms、118 张图至少有一个挂住的 cleanup：**3403 ms**。gate 里要跑两遍（源码 + 归档重建副本），约 **7 s**。

覆盖率诚实评估——按第 3 点里列出的维度逐条对：

| 维度 | 提议的形状能否抓到 |
|---|---|
| N1 一个 slot 内多个 cleanup 结局不同 | **不能**，除非生成器把行为下放到**每个 cleanup**（提议是"随机 cleanup 行为"，读起来是每个 service 一种）；还需要一个"已确定的失败必须可见"的判据 |
| N2 / N3 abort 监听器里重入 | **不能**——提议里根本没有"用户代码在关闭期间做事"这一维 |
| N4 保留 | **不能**——需要 WeakRef + `--expose-gc` + 对照组 + 多轮 gc，属性测试跑 200 张图时既慢又不确定 |
| N5 rollback 挂住时的等待者 | 可能——只要生成器会在"setup 失败 + cleanup 挂住"时检查所有 `load()` 都结算了 |
| G1 | **反效果**——把更多墙钟塞进 gate |
| 销毁顺序、错误恰好一次、并发正确性 | **能**，而且已经证明有效（1898 条顺序断言、258 个错误各一次） |

建议的收法：

1. **收**顺序/计数/恰好一次那部分，固定种子、seeded PRNG、**判据里不出现墙钟**，200 张图约 50 ms，进 `packages/core/tests/`，两遍也就 0.1 s。种子写死在文件里，失败时打印种子与图的 JSON（可复现）。
2. **不收**"随机挂住"那部分进同一个循环；改成一个**小而确定**的挂住场景集（十几个，闸门驱动），因为挂住的代价是真实的宽限期，而且会把 gate 变成计时敏感的东西——G1 刚教过这一课。
3. **补**两个提议里没有的维度：**每个 cleanup 独立的行为**、**关闭期间的用户重入**（abort 监听器随机执行 `dispose()` / `load()` / `enter()` 中的一个）。这两维是本轮四项里三项的所在地。
4. 保留 N4 的保留性测试为**单独的、目标明确的 `--expose-gc` 测试**（四条路径 × 三个断言），不要塞进属性测试。

### 3. 这五项之外，我认为还有的同类风险

按两条根因扫过一遍全仓，除已写的 N5 之外：

- **根因 A（用户代码的时机）**：Runtime 同步调用用户代码的面共有四个——`setup()`（try/catch 有）、cleanup（try/catch 有）、`onEvent`（try/catch 有，`runtime.ts:353`）、**abort 监听器（什么都没有）**。abort 监听器不仅能重入 `dispose()`（N2）和启动服务（N3），还能**抛错**。这一格我补测了：三层树、root 的监听器抛错 →
```
dispose=fulfilled  root=disposed  child=disposed  grandchild=disposed  live=0  uncaught=[listener threw]
```
**递归没有被打断，关闭完全正确**；异常按 Node 的 `EventTarget` 语义变成进程级 `uncaughtException`。所以这**不是关闭路径的缺陷**——但它是那条不对称的另一半：`onEvent` 抛错被 Runtime 吞掉，abort 监听器抛错会掀翻没装处理器的进程，而两者都是文档推荐的用户扩展点。是否要在文档里说明这个差别，是产品决定，不是缺陷。
- **根因 B（跨 await 的强引用 / 无界阶段）**：除 N4 的两条外，materializer 里没有别的 await 会活过关闭（我按 `await` 清单逐条核过：`recoverFailedSlot` 的 `sleepAbortable` 随 abort 结束，`settleSlot` / `disposeServiceSlot` 在预算处返回，`loadService` 的等待帧随 deadline/abort 结束）。但是 **`runtime.dispose()` 的 `awaitSettling(graceMs)`（`materializer.ts:310`）等的是 `record.closing`**，而 `record.closing` 里跑的正是 `closeUnsettled` 的那段无预算 cleanup——也就是说 **late cleanup 阶段自始至终没有任何预算**，只是没人等它。这在语义上是自洽的（"关闭不等它"），但它意味着账本条目 `settling` 可以永久存在；§13 说"An entry leaves the ledger when … an abandoned cleanup ends"，对永不结束的 late cleanup 没有说法。**未确认是否算缺陷，倾向于是文档缺口。**
- **参考应用**：`disposeRecord()` 把 `record.disposal` 的失败交给 `onDisposalError` 并计数，路径是干净的；但 `create()` 失败分支里的 `await record.disposal`（`manager.ts:445`）同样无界——它等的是一次 `env.dispose()`，由 Runtime 宽限期兜底，与 A4 是同一类，**建议在 A4 的验收矩阵里顺带加一格**。

---

## 复现命令

探针在会话临时目录，不在仓库。若要重跑，把 `<scratchpad>/rc4/` 下的文件复制出来即可；每个文件顶部都写明了它证明什么。

```
node          <scratchpad>/rc4/n1.mjs        # N1a–N1e
node          <scratchpad>/rc4/n2n3.mjs      # N2a–N2c, N3a, N3b
node          <scratchpad>/rc4/extra.mjs     # N2d, N2e, N3c, N3d
node --expose-gc <scratchpad>/rc4/n4.mjs     # P1–P4（四条内存路径）
node          <scratchpad>/rc4/a4.mjs        # A4a–A4c
node          <scratchpad>/rc4/waiter2.mjs   # N5
node          <scratchpad>/rc4/cost.mjs      # 属性测试的成本锚点
node          <scratchpad>/rc4/cost2.mjs     # 带挂住的成本锚点
```

候选修复的验证方式：把 `packages/core/dist` 复制到临时目录，只改副本的 `dist/runtime.js`（N2、N3）与 `dist/internal/materializer.js`（N4 的 `closeUnsettled`），再把 `packages/core/tests` 复制成副本的兄弟目录，`node --test --expose-gc tests/*.test.mjs`。

**候选修复（N2 + N3）的回归结果**：266 个测试 263 通过 3 失败；对照组（未打补丁的 dist 副本 + 同一份复制的测试）**同样是 263/3**，三条失败都是复制目录里读不到 `docs/API_REFERENCE.md` 与 `packages/core/src/runtime.ts` 的 ENOENT，与行为无关。也就是说这两个候选修复对现有核心测试**行为中性**。N4 与 N1 的修复我只做了定位用的诊断补丁，**没有**做完整候选实现，因此没有对应的回归数据。
