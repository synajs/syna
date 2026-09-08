# multitenant-blog（MULTITENANT_BLOG）

multitenant-blog（`apps/multitenant-blog`，包名 `@syna-app/multitenant-blog`）是 Syna 的参考应用：窄范围但完整的多租户博客引擎——两种真实数据后端 × 两种执行方式，三份配方共享一组工厂，两租户隔离，可替换 auth，按需、有界、租约保护的 SiteEnv 工作集。它不是完整的 BlogAssembly，也不是通用 ORM。它在 1.0.0-rc.2 改为现名（此前的名字、改名的范围与理由见 `docs/HISTORY.md`）；改名不改行为：`syna.id`（`hyla.mini`）、默认 schema、advisory 锁命名空间、日志前缀与静态构建清单标记都保持原样，下文照实写出。七个入门示例见 `docs/EXAMPLES.md`；这个应用回答的是规模、资源与运行边界的问题。

## 分层

```
apps/multitenant-blog/src
├── domain/        数据模型（Post/Category/Tag/SiteConfig/Recipe）、ContentRepository/ContentStore Contract、ContentBackend Binding
├── data/
│   ├── postgres/  DatabasePool（唯一 pg.Pool，schema 固定）、PostgresContentStore、幂等 migrations、seed
│   └── filesystem/ FilesystemContentStore、Default/Blog 两个 ContentLayout（同 Contract）、原子写、symlink 拒绝、每租户互斥
├── render/        MarkdownStageFactory Contract、7 个 unified/remark/rehype 工厂、JSON 配方、PipelineBuilder、Renderer、RenderInfrastructureEntry
├── auth/          Principal、Authenticator Contract、SessionAuth 与 SignedTokenAuth（测试适配器）、SiteAuth Binding、授权函数
├── site/          Inputs（TenantId/SiteSnapshot/CurrentRequest/BuildOptions/SiteManagerOptions）、SiteContext、RequestHandler、
│                  SiteEnvironmentManager、StaticBuilder、MaintenanceWorker、Entries、域名表、预算评估、HTTP/静态服务
├── app.ts         宿主装配：Runtime → 基础设施 root → App Env，启动预检
└── testing/       故意违规的 fixture（仅测试/演示）
```

## Env 世界

```
InfrastructureEntry (root)      DatabaseConfig 或 ContentRoot+Layout 的 Input
└── AppEntry                    ContentBackend Binding；拥有 Pool/Store、Factory 集合、PipelineBuilder、Renderer、SiteEnvironmentManager、MaintenanceWorker
    ├── SiteEntry (per tenant × configRevision)  TenantId、SiteSnapshot、SiteAuth Binding、AuthOptions；拥有 SiteContext 与 Authenticator
    │   ├── RequestEntry (per request)          CurrentRequest；仅 RequestHandler 为请求本地
    │   └── BuildEntry (per static build)       BuildOptions；StaticBuilder
    └── WorkerEntry (由宿主在 Ready 后启动)
```

"想要两个对象时，先问它们是否只是同一个 Factory 的两个产物"：三份配方、两个租户共享同一组 Factory slot；只有受 Syna 管理的依赖身份（TenantId、SiteSnapshot、CurrentRequest、Binding 选择）不同才分叉。

## 数据模型（H01）

Post：stable `id`、`tenantId`、`slug`、`locale`（`zh-CN`/`en`，普通数据）、Markdown `body`、`status`（published/draft/private）、`categories` 与 `primaryCategory`、`tags`、`revision`、时间戳（fixture 控制）。Category/Tag/SiteConfig（标题、域名、主题参数、导航、三份配方、auth 设置、`configRevision`）。排序、路径安全、locale/状态判断在 `domain/model.ts`，两个后端共用。

两个后端的写入保证（第三轮 B1–B4）：

- 身份：文章由 `(tenantId, id)` 标识。PostgreSQL 的 `posts` 主键是 `(tenant_id, id)`（早期只以 `id` 为主键的 schema 在启动迁移时幂等地改为复合键），同一个 id 在两个租户里是两篇互不影响的文章，与文件系统后端和按租户划分的仓库 API 一致。
- 变更与版本号：每个变更和它的内容版本推进是同一个工作单元。PostgreSQL 公共路径上的每个变更（`savePost`/`deletePost`/`saveCategory`/`saveTag`/`saveSiteConfig`）自成一个事务，写入与 `content_versions` 的推进一起提交或一起回滚；`transaction()` 里的变更沿用外层事务。文件系统后端在变更的第一次内容写入之前写下 `content.version.pending` 标记，推进版本后删除；公共仓库在串行区之外看到残留标记（写入与推进之间崩溃的痕迹）时推进一次版本，使缓存丢弃该变更可能写下的内容——这不是多文件 ACID，只是让崩溃不会把缓存永久留在旧版本。持久性边界（D65）：文件系统后端的原子替换与标记只保证进程崩溃后的一致性；不做 fsync，掉电或内核崩溃后 rename 可能先于数据落盘（空文件或残缺文件），先写的标记也可能丢失而后写的内容留存。
- 工作单元的边界（复审 I-102、I-103）：`transaction()` 里任何 SQL 级错误都结束这个工作单元——PostgreSQL 会在之后的 COMMIT 上静默回滚，`withTransaction` 检查 COMMIT 的命令标签，得到 `ROLLBACK` 即以 `TransactionAbortedError`（`TRANSACTION_ABORTED`）拒绝，不会把什么都没写的工作单元当作成功。域名冲突在删除自己的域名行之前检查，所以被拒绝的保存不会丢失所有权。
- 每租户串行（PostgreSQL，I-104、I-108）：每个工作单元（公共路径的每个变更、`transaction()`、`deleteTenant()`）开始时取事务级 advisory 锁 `hyla-mini:tenant:<id>`，同一租户的工作单元一个接一个执行，重叠的配置保存不再留下孤儿域名行，同一租户的两个工作单元也不会死锁；任何锁等待受 `lockTimeoutMs`（默认 30 s，SQLSTATE 55P03）约束。
- 重入（I-105、I-106）：在同一租户的工作单元内部再走公共仓库（或 `deleteTenant()`）会永远等自己，因此以 `TransactionReentrancyError`（`TRANSACTION_REENTRANCY`，AsyncLocalStorage 跟踪）立即拒绝。`transaction()` 得到的仓库在自身内部也串行（文件系统内层互斥；PostgreSQL 把语句按顺序链在租用的连接上），并发发出的变更全部落地且版本每次推进。
- 连接池关闭有界（I-109）：`dispose` 立即以 `PoolClosedError` 拒绝排队的租用，最多等 `closeTimeoutMs`（默认 5 s）让已租出的连接回来，然后终止仍未归还的连接并以 `PoolCloseTimeoutError` 报告；`stats()` 有 `waiting`/`leased`/`removed`。
- 文件系统与迁移（I-107、I-110、I-113）：一次重命名中途崩溃留下的两个同 id 文件被当作同一篇（布局路径上的副本优先，否则最高 revision，再否则路径靠前者），读取忽略另一个，下一次保存或删除把多余副本一起清掉。PostgreSQL 的 `domains` 回填只在建表时执行一次，且和建表在同一个 `do` 块里并按 `jsonb_typeof` 过滤，格式错误的存量配置只影响那个租户的读取。两个后端都在写入前拒绝任何字符串里的 NUL（`TypeError`）；`listTenants()` 是六张表（PostgreSQL）或目录（文件系统）的并集，只有分类或标签的租户也在列。
- 域名归属：PostgreSQL 有 `domains(normalized_host primary key, tenant_id)` 表（迁移时从已有配置回填，之后每次保存重写该租户的行）；保存配置时按排序后的主机名逐个取事务级 advisory 锁，再检查并写入，两个租户同时认领一个主机名只有一个成功，主键是绕过应用写入者的兜底。文件系统后端在租户锁之内再取存储级 `__domains__` 锁，把扫描其他租户与写入自己的配置做成一个临界区（锁序：租户 → 域名）。
- 连接池：只有连接级错误（`isConnectionError`：SQLSTATE 08 类、57P01/57P02/57P03、网络 errno、pg 的连接终止消息）、租约期间连接上的 error 事件、或 BEGIN/ROLLBACK 本身失败才销毁连接；业务错误（约束冲突、抛出的异常、坏 SQL）回滚后把连接交还池。`stats().removed` 计数被丢弃的连接。租约中的连接在两次查询之间断开不会成为进程级 error 事件。

## 站点工作集（H10/H11）

`SiteEnvironmentManager` 是应用自己的普通 Service（Syna core 无 TenantScope/LRU）：

- key = `runtimeId|tenantId|configRevision|g<generation>`；按需创建；同 key 并发首次获取 single-flight。`invalidate(tenantId)` 递增 generation：即使 `configRevision` 未变，下一次 acquire 也得到全新 Env，旧 Env 在最后一个 lease 释放时立即关闭。
- 创建期间被轮换（配置保存或 invalidate）的 Env 一旦无人持有就关闭，不会以 draining 状态滞留占用容量；等它的 acquirer 重新读取配置加入当前世界，重试以 `acquireTimeoutMs` 为界而不是固定次数：整个 acquire 共用一个截止时间，**配置读取**（rc.3 / A2）**与站点创建**（rc.4 / A4）**都在这个截止时间之内**，每次等待容量的计时器取 `min(acquireTimeoutMs, 截止时间 − 现在)`，需要重新读取配置的重试先等 5 ms 再读（复审 I-98）。配置读取与站点创建都是共享的：到期的是**这个调用者**的等待（以 `SITE_CAPACITY` 拒绝，消息指明是配置读取还是站点创建），共享的那件事不被取消、不被缩短、继续持有它已经拿到的东西，同租户的其他 acquirer 照样从它拿到结果。创建期间被自己发起的调用者放弃并不改变什么：创建自己持有那个记录（一份 lease），跑完之后世界照常变为 `active` 并可被后来者复用，创建计数为一，也不会为这次"没人等了"记一次创建失败或触发退避。`acquire` 内部的三个等待点——`boundSites.enter()`、`context.load()`、`auth.load()`——都在这一个期限之内，因为期限包住的是整个 `record.creation`。`stats()` 的 `inFlightConfigReads`（在途往返数）与 `inFlightAcquires`（尚未结算的 `acquire()` 调用数）是这两件事的观察点；`pendingAcquires` 始终只是容量队列，不含正在读配置的调用者。
- 轮换单调：acquire 读到的配置若比该租户某个仍接受 lease 的记录**更旧**（更小的 `configRevision`，或已被 `invalidate()` 推进的 generation），它加入较新的记录，而不是把较新的记录置 draining；只有比读到的配置更旧的记录才轮换。等待容量期间发生了 `invalidate()`、或更新的世界已被别人创建时，等到的名额放回队列并重新读取配置（仍在同一个截止时间之内）。滞后的副本读或与保存竞争的缓存读因此不会毁掉当前世界，也不会造出一出生就过期的世界。
- 名额交接：等待者被唤醒时名额（reservation）已属于它；一个名额若发现同 key 的记录已由别人创建、或管理器已关闭，立即交给下一位等待者，不会有第三个 acquirer 守着空闲名额等到超时。
- 关闭中的记录：一个 SiteEnv 开始关闭时立即离开它的 key（后继者可以马上创建），但在关闭结束前仍占用名额；同 key 的 acquirer 不再等待关闭，也不会反复读取配置（复审 I-100）。
- 只为有用的名额驱逐：build/background acquirer 只在关闭空闲 Env 足以让它拿到名额时才驱逐（请求需要一个；名额不够时一个都不关），不会为一次注定被拒绝的 build 抖动工作集（I-96）。
- 被 `shutdown()` 截断的创建本身以 `SiteManagerClosedError`（`cause` 为 Runtime 的原始错误）拒绝，不计入创建失败也不触发退避；在关闭之后才挂上的 Env 由创建者自己关闭（I-97）。自 rc.4 起等待那次创建的**调用者**不再等它返回，而是在收尾处立刻得到一个不带 `cause` 的 `SiteManagerClosedError`（A4）。
- lease 用途：`acquire(tenantId, purpose)` 的 `purpose`（`request` / `build` / `background`）是容量策略。`reservedForRequests` 个名额（默认 `capacity ≥ 2 ? 1 : 0`，取值 `[0, capacity)`，启动时校验）只有请求可以用来**新建** SiteEnv；构建/后台任务随时可以加入已存在的 SiteEnv，但只在空闲名额多于该值时新建，排队时请求先于更早到达的构建/后台等待者。`stats()` 报告 `reservedForRequests` 与 `waitingByPurpose`。
- 请求/构建/后台使用者持 lease；`release()` 幂等，不负计数。
- 容量与空闲 TTL 可配置；只驱逐无活跃 lease 的 Env；不关闭共享 pool。
- 关闭中的 Env（记录状态 `disposing`）在它的 `dispose()` 结算前继续占用一个容量名额：驱逐不会提前腾出名额，等待者在关闭结算后按到达顺序获得容量，所以容量上限是真实的 Env 数量上限。H11 测试在每次 lease 时采样 `runtime.inspect().liveEnvCount`：任何时刻存活的 SiteEnv（含关闭中的）不超过 capacity（`working-set.json` 的 `maxSiteEnvsAlive`）。Env 关闭失败（`dispose()` 拒绝）通过 `onDisposalError(error, { key, tenantId, configRevision })` 报告（默认 `console.error`）并计入 `stats().disposalFailures`，绝不成为 unhandled rejection；记录照样移除。
- 创建在 Env 进入之后失败（Authenticator 形状校验、管理器已关闭等）时，那个 Env 立即关闭而不是泄漏。
- 配置更新：新 acquire 读到新 `configRevision` → 旧 revision 置 draining，不再接受新 lease，在途请求完成后释放并关闭；旧配置不会无限积累。驱逐不是版本失效。
- 全部在用时：有界等待队列（`maxPendingAcquires`、`acquireTimeoutMs`），超出即明确拒绝 `SITE_CAPACITY`，不强关活跃租户。
- 冷创建失败不留 poison promise，按租户有界指数退避；读完配置后再次检查退避，所以同一突发中的其余 acquirer 得到 `SITE_CREATION_BACKOFF`（含 `cause`）而不是各自再试一次。创建时校验 Authenticator 实例形状（`scheme` + `authenticate()`），接口不兼容的 override 在站点创建时失败，而不是在租户的第一个请求。
- 维护 worker（`MaintenanceWorker`）：宿主在 root Ready 后 `start({ intervalMs, domains })`；每个 tick 执行 `sweep()`，给定 `domains` 时还重载域名表（重载失败计入 `refreshFailures`，循环继续）。tick 抛错则循环结束、worker 世界释放、状态为 `failed`、`lastError` 保存原因；随后的 `stop()`（包括 Runtime 释放时的清理）重新抛出该错误，进入 `HylaApp.close()` 的 `errors`；`start()` 可以从 `failed` 重新开始。循环从不产生 unhandled rejection，也不会停在 `running`。
- 关闭（rc.3 / A1）：**接纳与收尾是两件事**。`admissionClosed` 只表示不再接纳新的 acquire——owner 的 stop signal 与 `shutdown()` 都会置它；收尾（清 `sweeper` interval、以 `SITE_MANAGER_CLOSED` 拒绝容量等待者、结束在途调用者对配置读取的等待、等 lease、销毁记录）由一个 `shutdownPromise` 执行**恰好一次**，`onDispose` 与每个显式调用都 await 同一次运行并得到同一份报告。owner abort 先到（宿主只 dispose Runtime、或启动失败回滚）不再是跳过收尾的理由。收尾不等后端返回，也不等站点创建返回（rc.4 / A4）：正在读配置或正在等待某次站点创建的调用者立刻得到 `SITE_MANAGER_CLOSED`，那次往返或那次创建自己结束——创建仍然拥有它已经进入的 Env，并在发现管理器已关闭时自己关掉它。因此这样被截断的调用者拿到的 `SiteManagerClosedError` 不带 `cause`：收尾结束他的等待时，创建既没有失败，也仍可能成功。
- 关闭：拒绝新 acquire，等待 lease 到 `shutdownTimeoutMs`，报告未释放 lease，然后并发关闭 Env。`HylaApp.close()` 先执行这一关闭，再释放 Runtime，返回 `{ unreleasedLeases, unsettledAttempts, errors }`（管理器关闭本身失败也进入 `errors`；Runtime 嵌套的释放报告被展平成叶子错误；`close()` 幂等，重复调用返回同一份报告）：Runtime 释放的失败（某个 cleanup 抛出）进入 `errors` 而不是抛出；某个 setup 无视 stop signal 超过 `limits.disposalGraceMs` 不是错误（0.7）：该 attempt 列在 `unsettledAttempts`（来自 `runtime.inspect()`），Runtime 关闭时以诊断事件 `runtime-attempts-outstanding` 报告一次；Runtime 不再保留这些 Env（它们的 `state` 已是 `disposed`），attempt 只由各自的 setup Promise 维持。自 rc.3 起 cleanup 也如此（`docs/SEMANTIC_CHANGES_RC3.md` §3.1）：每个 Ready slot 的 cleanup 阶段各有一个 `limits.disposalGraceMs` 预算，超出即被放弃并以 `attempt-abandoned`（`phase: 'cleanup'`）报告。因此宿主若绕过 `HylaApp.close()` 直接 dispose Runtime，而此时还有租约未归还，管理器的 cleanup（默认最多等 `shutdownTimeoutMs` = 5 s）会在默认宽限期 2 s 处被放弃——收尾仍在后台跑完并照常上报，`close()` 的报告则来自它自己 await 的那次 `shutdown()`。要让 Runtime 等完整个收尾，把 `runtime.limits.disposalGraceMs` 设得不小于 `siteManager.shutdownTimeoutMs`。
- Env 被驱逐不丢业务事实：数据、配方、配置版本都在后端。

## 权限边界

- 认证：`Authenticator` Contract，两份本地测试实现（cookie 会话表 / HMAC 签名 token）。它们**不是**生产安全实现。
- 授权：应用函数 `canViewPost(principal, tenantId, post)`；身份属于某租户，跨租户身份视为匿名。
- 缓存：页面缓存键含 tenant、configRevision、**content version**、locale、visibility class、path。每个 SiteEnv 的页面缓存有界（`siteManager.pageCacheMaxEntries`，默认 256，最久未用者先淘汰）；同一 key 的并发渲染只生产一次（single-flight，其余等待者加入），并发的版本读取共用一次后端往返，渲染失败不入缓存；`cacheStats` 报告 `hits/misses/coalesced/entries/evictions/maxEntries`。配方流水线缓存（`PipelineBuilder`）同样有界（`PIPELINE_CACHE_MAX_ENTRIES` = 64，按 (trust, 配方) 为键，键序无关），管理器对同一租户的并发配置读取也只做一次。content version 由后端在每次变更（post/category/tag/配置）时推进（PostgreSQL `content_versions` 表在同一事务内递增；文件系统每租户 `content.version` 文件），每次查缓存都读取一次，而且**先读版本、再读内容**：在两次读取之间落地的编辑不会被缓存到新版本之下（它会被记在旧版本下并在下一次查询时被丢弃）；版本变化即丢弃该站点整个页面缓存，所以编辑与可见性变化不需要保存配置就生效，被撤回内容的摘要不会留在匿名索引页。Syna plan cache 不缓存页面或授权结果。
- 不可信输入：`PipelineBuilder.build(document, { trust })`。`trusted`（文章正文、预览）按配方原样构建；`untrusted`（评论：`/comments/preview`、`SiteContext.renderComment`）在配方之上施加平台策略：`bridge`/`compile` 阶段的 `allowDangerousHtml` 强制为 false，且最后一个 rehype 阶段必须是声明了 `sanitizer` 角色的 Factory，否则由构建器追加平台的 `rehype-sanitize`（`allowLinkTargets: true`，保留链接阶段加上的 `rel`/`target`；`finalPass: true`，每个配置得到一个独立的插件身份（`rehypeSanitizeOwnPass()`），所以配方自己的 sanitize 阶段即使也声明 `finalPass` 也不会吸收它；构建器还会核对追加的 sanitizer 确实新增了一遍处理，否则以 `RecipeError` 拒绝（复审 I-94））。因此通过 `extraServices` 注册在 sanitize 之后的阶段无法把 `<script>` 或事件处理器带回评论输出；没有任何已接纳的 sanitizer Factory 时，`untrusted` 构建以 `RecipeError` 明确拒绝。
- 站点配置：两个后端在 `saveSiteConfig` 与 `getSiteConfig` 都校验文档（`parseSiteConfig`，JSON schema + `isSafeHref` + `isCssColor` + 域名可归一化 + 租户 id 路径安全；`isSafeHref` 也拒绝反斜杠拼写 `/\host`、`\\host`、`\/host`，浏览器把它们当作协议相对 URL，复审 I-95）；不合法的保存以 `SiteConfigError`（`INVALID_SITE_CONFIG`，`problems` 列出原因）拒绝且 `configRevision` 不变，带外写入的坏文档在读取时成为该租户的类型化错误而不是渲染出的页面。渲染器另有兜底：不安全的导航 `href` 渲染为 `#`，非颜色的 `theme.accent` 渲染为默认色。格式错误的 cookie（坏的百分号编码）视为匿名而不是 500。
- HTTP 错误：客户端只看到状态码与短短语（503 `Service unavailable (<code>)`、500 `Internal error`、400 `Bad request`），内部错误信息进入 `startHttpServer({ onError })`（默认 `console.error`）；请求目标无法解析（绝对形式的坏 authority、错误百分号编码）→ 400，处理函数的任何异常都被兜底，不会挂起连接或以 unhandled rejection 终止进程。
- 域名：受控域名表 host → tenantId；未知 host 先触发一次域名表重载（single-flight，每 `domainRefreshMinIntervalMs`（默认 1000 ms）至多一次，并发的未知 host 共用一次；重载失败沿用旧表并报告给 `onError`），再次解析仍未知才 404，不访问任何租户数据，所以启动后保存的租户无需重启即可访问，而未知 host 的洪流每个间隔只花一次扫描；`serve` 的 worker 每个 tick 也重载域名表。只有 `trustProxy` 时才信任 `X-Forwarded-Host`。归一化：trim、小写、去掉一个端口和一个结尾的点、IDNA（`url.domainToASCII`），所以 `BÜCHER.example.` 与 `xn--bcher-kva.example` 是同一声明。`saveSiteConfig` 拒绝声明其他租户已拥有的域名（`DomainConflictError`，归一后比较）；带外编辑造成的冲突 host 不分配给任何租户（`DomainTable.conflicts` 列出），其余租户不受影响，`serve` 启动时告警。
- 静态输出：只写匿名可见内容与公开元数据，不含凭据/内部引用（矩阵测试逐文件扫描）。输出目录必须为空或是上一次构建：构建器只删除上次清单（`.hyla-build.json`）中列出的文件及由此变空的目录，从不触碰其他文件；有陌生内容且无清单的目录被拒绝；只有本构建器为本租户写的清单才算上一次构建（`builder: "hyla-mini"`、相同的 `tenantId`、文件列表），其他清单以 `BAD_MANIFEST` 拒绝且不删任何文件（复审 I-99）。发布是有序的而不是事务性的（H03：逐文件原子替换，不宣称多文件 ACID）：整站先在内存中从同一个内容版本渲染完成（文章按已列出的列表渲染，`SiteContext.renderPostPage`，不逐篇回读后端，I-101；前后两次读取 `contentVersion` 一致，否则重渲染，最多 `BUILD_SNAPSHOT_ATTEMPTS` 次后以 `BUILD_CONTENT_CHANGED` 拒绝且不写任何文件），然后逐文件原子替换新内容，再删除上次清单中不再存在的文件，最后写清单（含 `contentVersion`）；写入阶段之前失败的构建让上一次构建原样保留。同一目录同时只有一个构建：进程内按解析后的目录互斥，进程间靠 `.hyla-build.lock`（`{ pid, startedAt }`；持有者进程已消失或超过 `BUILD_LOCK_STALE_MS` 的锁被接管，否则 `BUILD_LOCKED`）。输出目录本身不得是符号链接，其下任何路径也不得是或穿过符号链接：将要写入或删除的每个路径在第一次写之前都经过逐段 `lstat` 检查，发现链接即以 `UNSAFE_OUTPUT_DIR` 拒绝且不动任何文件。静态服务器启动时解析根目录的真实路径，请求路径下不跟随任何符号链接（404），读取的文件必须仍在根目录之内；点文件不发布。
- 启动：`createHylaApp()` 预检三个形状：渲染基础设施、站点、以及一次请求（在管理器之外进入一个合成的 `preflight` 站点世界，按 `REQUEST_BUDGET` 解释一次请求后释放；`preflight` 数组的第三项），任何一个越界都拒绝部署（`PreflightError`）；`preflightRequests()` 再按每个已配置租户各自的配方与认证器重复请求检查。预检后实际加载内容后端（打开 PostgreSQL 连接池并探测 `search_path`）并创建站点管理器，数据库不可达、schema 非法或 `siteManager` 设置非法在启动时失败并释放 Runtime，而不是在第一个请求。

## 运行

```sh
npm install && npm run build
# 三格演示（HTTP alpha、HTTP beta、静态 alpha；文件系统后端）；也可 npm run demo:multitenant-blog
node apps/multitenant-blog/bin/multitenant-blog.mjs demo --root /tmp/blog-content
# PostgreSQL 后端（临时集群）
node scripts/pg-test-cluster.mjs with -- node apps/multitenant-blog/bin/multitenant-blog.mjs demo --backend postgres
# 开发服务器
node apps/multitenant-blog/bin/multitenant-blog.mjs serve --root /tmp/blog-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
# 单租户静态构建；解释一个请求世界及其分叉预算
node apps/multitenant-blog/bin/multitenant-blog.mjs build --root /tmp/blog-content --tenant alpha --out /tmp/blog-alpha
node apps/multitenant-blog/bin/multitenant-blog.mjs explain --root /tmp/blog-content --tenant alpha
```

测试：`npm run test:app`（文件系统后端、站点管理器、预检、复审与审计回归）、`npm run test:postgres`（临时集群上的 PostgreSQL 与后端 × 执行方式矩阵）；发布门禁以 `blog-*` 步骤逐个运行这些套件，并以 `blog-demo-filesystem` 断言三格演示的三个 200。

## 明确非目标

完整后台、完整 UI i18n、MongoDB、通用 ORM、插件市场、线上部署、生产级 auth、跨进程锁、多文件 ACID（文件系统后端只有单文件原子替换 + 进程内每租户串行）、掉电持久性（文件系统后端不 fsync，见 D65）。
