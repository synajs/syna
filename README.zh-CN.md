# Syna

为有状态的 TypeScript 服务管理依赖与生命周期。

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

[English](https://github.com/synajs/syna/blob/main/README.md) | 简体中文

连接池要在应用结束时关闭，带租户凭据的 API 客户端不能被另一个租户误用，请求里的临时缓存也不该一直留着。程序规模不大时，手写这些逻辑很直接。等到同一个资源被多处使用、不同租户又需要不同配置，“谁创建、谁共享、谁关闭”就渐渐散落在工厂函数、模块级单例和 `finally` 块里。

Syna 用服务声明描述这些关系。Service 声明依赖，在 `setup()` 中创建实例，并登记资源的清理方式。应用通过 Entry 打开一个环境（Env），让它承载某个租户或一次请求的上下文。子环境复用父环境中依赖未变的服务；需要不同依赖的部分则使用新实例。环境关闭时，Syna 按依赖关系调用它所拥有的服务的清理函数。

## 安装

首个公开 RC 正在准备中。发布到 npm 的 `rc` 标签后，安装命令是：

```sh
npm install syna@rc
```

需要 Node.js ≥ 22，使用 ESM。建议配合 TypeScript：Syna 自带类型声明，不需要额外安装其他 Syna 包或使用专用 tsconfig。包管理器会自动安装它的运行时依赖。

## 快速开始

三个文件。这个例子在第一次加载 `Database` 时打开连接池，在本次调用结束后关闭它。`openPool()` 是演示用的模拟驱动，不会连接数据库。

`package.json`

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "resolveJsonModule": true,
    "strict": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`src/main.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)
const DatabaseConfig = define.input<{ url: string; poolSize: number }>('database-config')

interface Database {
  query(sql: string): Promise<string>
}

const Database = define.service('database', {
  requires: { config: DatabaseConfig },
  async setup({ config }, { onDispose }): Promise<Database> {
    const { url, poolSize } = config.read()
    const pool = await openPool(url, poolSize)
    onDispose(() => pool.close())
    return { query: sql => pool.run(sql) }
  },
})

const App = define.entry('app', {
  requires: { database: Database },
  parameters: { config: DatabaseConfig },
})

const runtime = createRuntime({ services: [Database] })
try {
  await runtime.run(App, {
    config: { url: 'postgres://localhost/app', poolSize: 4 },
  }, async ({ database }) => {
    const db = await database.load()
    console.log(await db.query('select 1'))
  })
} finally {
  await runtime.dispose()
}

// A stand-in for a database driver; no database connection is made.
async function openPool(url: string, poolSize: number) {
  console.log(`opened ${url} (${poolSize} connections)`)
  return {
    run: async (sql: string) => `${sql} -> 1 row`,
    close: async () => console.log(`closed ${url}`),
  }
}
```

创建上述文件后，在项目目录安装依赖：

```sh
npm install syna@rc
npm install -D typescript @types/node
```

运行 `npx tsc && node dist/main.js`，打印：

```
opened postgres://localhost/app (4 connections)
select 1 -> 1 row
closed postgres://localhost/app
```

`runtime.run()` 创建环境，把 Entry 声明的依赖交给回调，并在回调完成或抛错后关闭环境。连接池的清理方式只在 `Database.setup()` 中登记一次，使用它的代码不必知道该调用哪个驱动方法来关闭它。最外层的 `finally` 负责关闭 Runtime。

真正触发连接池创建的是 `database.load()`。这个服务没有声明 eager 启动；如果回调不调用它，连接池就不会打开。`config.read()` 则同步读取调用者提供的配置。

`definePackage(packageJson)` 从应用自己的 `package.json` 取得名称和版本，用来标识它声明的服务。`#syna/package` 是上面配置的本地导入别名，不是另一个需要安装的包。

## 几个基本概念

**Runtime** 收录这个程序允许使用的服务定义。创建 Runtime 本身不会启动服务；调用 Entry 时，才会规划并创建环境。

**Entry** 声明进入一个环境所需的参数，以及进入后可以使用的能力。`parameters` 是调用者提供的 Input 和 Binding 赋值，`requires` 决定回调和 `env.deps` 得到哪些依赖引用。

**Env** 是一个执行环境。应用可以按需要为租户、请求或构建任务创建它们，Syna 没有内置这些业务层级。子环境会复用父环境中仍然适用的服务；这个决定不取决于父环境是否已经调用过 `load()`。

**Service** 是有标识、依赖和生命周期的受管组件。同一环境对同一个服务版本提供同一个实例，不同版本可以共存。默认在首次 `load()` 时启动；声明 `eager: true` 的服务则需要在环境就绪前启动。`onDispose()` 用来清理自己创建的资源，不应用来关闭共享依赖。

**Input** 是调用者提供的上下文数据，例如租户记录、请求或配置，通过 `read()` 同步读取。子环境显式重新提供某个 Input，就会产生新的上下文身份，即使传入的是同一个对象。依赖该 Input 的服务会据此分叉；Syna 不比较配置是否深度相等。

这里只介绍使用方式。精确定义见[语义模型][semantic-model]，所有类型和方法见 [API 参考][api-reference]。

## 每个租户一个环境

共享资源放在应用环境中，租户专属服务放在它的子环境中：

```
app Env                        Pool
├── tenant Env: acme            MailClient(acme)   ─┐
└── tenant Env: globex          MailClient(globex) ─┴─ shared Pool
```

沿用前面的 `package.json` 和 `tsconfig.json`，新增下面的文件。连接池和邮件客户端仍是演示实现，不需要数据库或真实凭据。

`src/tenants.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)
const CurrentTenant = define.input<{ id: string; apiKey: string }>('current-tenant')

interface Pool {
  readonly id: number
  run(sql: string): Promise<string>
}

let pools = 0
const Pool = define.service('pool', {
  setup(_deps, { onDispose }): Pool {
    const id = ++pools
    console.log(`pool #${id} opened`)
    onDispose(() => console.log(`pool #${id} closed`))
    return { id, run: async sql => `${sql}: ok` }
  },
})

interface MailClient {
  send(to: string): Promise<string>
}

const MailClient = define.service('mail-client', {
  requires: { tenant: CurrentTenant, pool: Pool },
  async setup({ tenant, pool }, { onDispose }): Promise<MailClient> {
    const { id } = tenant.read()
    const db = await pool.load()
    console.log(`mail client of ${id} opened on pool #${db.id}`)
    onDispose(() => console.log(`mail client of ${id} closed`))
    return {
      send: async to => `${id}: mail to ${to} accepted (${await db.run('insert into outbox')})`,
    }
  },
})

const App = define.entry('app', { requires: { pool: Pool } })
const TenantEntry = define.entry('tenant', {
  requires: { mail: MailClient },
  parameters: { tenant: CurrentTenant },
  reuse: { share: [Pool] },
})

const runtime = createRuntime({ services: [Pool, MailClient] })
try {
  const app = await runtime.enter(App)
  for (const tenant of [{ id: 'acme', apiKey: 'key-acme' }, { id: 'globex', apiKey: 'key-globex' }]) {
    await app.run(TenantEntry, { tenant }, async ({ mail }) => {
      const client = await mail.load()
      console.log(await client.send('owner@example.test'))
    })
  }
} finally {
  await runtime.dispose()
}
```

运行 `npx tsc && node dist/tenants.js`，打印：

```
pool #1 opened
mail client of acme opened on pool #1
acme: mail to owner@example.test accepted (insert into outbox: ok)
mail client of acme closed
mail client of globex opened on pool #1
globex: mail to owner@example.test accepted (insert into outbox: ok)
mail client of globex closed
pool #1 closed
```

`MailClient` 没有声明名为“租户”的 scope。它依赖 `CurrentTenant`，而每次进入 `TenantEntry` 都会提供本次租户数据，因此两个子环境各有自己的客户端。`Pool` 在应用环境中已经被规划，且不依赖租户数据，所以它在两个子环境间共享，直到 Runtime 关闭应用环境时才关闭。

`reuse: { share: [Pool] }` 进一步要求使用父环境的连接池：无法共享就报错，不会悄悄创建第二份。不写这条约束时，Syna 也会默认尝试复用符合条件的父级服务。

请求、构建和定时任务可以使用同样的结构。只需要派生边界时，也可以调用 `env.derive()`；它会创建子环境，但不额外声明对外暴露的依赖。

并非每种配置都需要一个新环境。比如正文和评论使用不同的 Markdown 选项，同一个管线工厂服务可以通过两次普通调用生成两个产物。只有需要不同的受管依赖身份或生命周期时，才需要让它们处在不同环境中。

## 选择一个实现

Contract 定义能力接口，Service 声明自己提供这个接口。Binding 为某个使用位置保存实现选择，因此可以把用户的选择写入设置，再在下一次调用时读回来。

下面三个代码块是一组连续示例，按顺序放入同一个 `src/mailers.ts`，沿用 Quick Start 的项目配置。前两个 provider 只返回演示结果，不发送真实邮件。

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'syna'

const define = definePackage(packageJson)
interface Mailer {
  send(to: string, text: string): Promise<string>
}

const Mailer = define.contract<Mailer>('mailer')
const Preferred = define.binding('preferred-mailer', Mailer)
const CurrentTenant = define.input<{ id: string }>('mail-tenant')

const SmtpMailer = define.service('smtp-mailer', {
  provides: [Mailer],
  requires: { tenant: CurrentTenant },
  setup: ({ tenant }): Mailer => ({
    send: async (to, text) => `${tenant.read().id}: SMTP -> ${to}: ${text}`,
  }),
})
const ApiMailer = define.service('api-mailer', {
  provides: [Mailer],
  requires: { tenant: CurrentTenant },
  setup: ({ tenant }): Mailer => ({
    send: async (to, text) => `${tenant.read().id}: API -> ${to}: ${text}`,
  }),
})

const MailEntry = define.entry('send-mail', {
  requires: { mail: Preferred },
  parameters: { tenant: CurrentTenant, mail: Preferred },
})

const services = [SmtpMailer, ApiMailer]
const stored = JSON.stringify(Preferred.to(ApiMailer))
const parameters = {
  tenant: { id: 'acme' },
  mail: Preferred.parse(JSON.parse(stored)),
}

const runtime = createRuntime({ services })
try {
  const result = await runtime.run(MailEntry, parameters, async ({ mail }) =>
    (await mail.load()).send('owner@example.test', 'hello'))
  console.log(result)
} finally {
  await runtime.dispose()
}
```

这次调用返回 `acme: API -> owner@example.test: hello`。两个实现都明确传入了 `createRuntime()`；仅仅导入一个 Service，并不会让它成为公开可选实现。

`Preferred.to(ApiMailer)` 生成可 JSON 序列化的实现引用，`Preferred.parse()` 校验引用格式及其 Contract 标识。进入环境时，Runtime 再从已接纳的实现中解析具体版本；解析一个引用不会下载包，也不会授予额外权限。

引用保存的是服务标识和版本范围，不是当前客户端对象。只要两个版本仍被 Runtime 接纳，就可以让已有的 1.x 选择继续使用 1.x，同时为新的选择指定 2.x。版本升级与配置迁移的细节见[包作者指南][package-authoring]。

## 测试替换

接着上一段，在测试用 Runtime 中替换 `SmtpMailer`。`services` 仍包含原服务，替身不需要被另外公开：

```ts
import { override } from 'syna'

const recorded: string[] = []
const RecordingMailer = define.service('recording-mailer', {
  provides: [Mailer],
  setup: (): Mailer => ({
    send: async (to, text) => {
      recorded.push(`${to}: ${text}`)
      return 'recorded'
    },
  }),
})

const testRuntime = createRuntime({
  services,
  overrides: [override(SmtpMailer, RecordingMailer)],
})
try {
  await testRuntime.run(MailEntry, {
    tenant: parameters.tenant,
    mail: Preferred.to(SmtpMailer),
  }, async ({ mail }) => {
    await (await mail.load()).send('owner@example.test', 'hello')
  })
  console.log(recorded)
} finally {
  await testRuntime.dispose()
}
```

`recorded` 得到 `['owner@example.test: hello']`。调用仍然选择 `SmtpMailer`，实际执行的却是替身。被替换服务的标识和 Contract 归属保留；具体依赖、`setup()` 及其登记的清理来自替身。

## 规划与检查

最后，用另一个 Runtime 检查同一个入口。`parameters` 包含它声明的两个参数：`tenant` 和 `mail`。

```ts
const diagnosticRuntime = createRuntime({ services })
try {
  const check = await diagnosticRuntime.check(MailEntry, parameters)
  if (!check.ok) console.log(check.error.code)

  const plan = await diagnosticRuntime.explain(MailEntry, parameters)
  if (plan.ok) console.log(plan.services, plan.forks.map(fork => fork.label))

  const env = await diagnosticRuntime.enter(MailEntry, parameters)
  console.log(env.inspect().nodes)
} finally {
  await diagnosticRuntime.dispose()
}
```

`check()` 回答这次调用能否完成规划。`explain()` 给出将新建、复用或分叉的节点及原因；两者都不会运行 `setup()`，也不会创建 Env。类型检查能帮你发现参数类型和依赖使用上的错误，版本无解、缺少实现等组合问题仍需要规划检查。

`env.inspect()` 查看已经创建的环境，包括各个 slot 的状态。进入环境不代表所有 lazy 服务都已经启动，这个示例就没有调用 `mail.load()`。运行时异常带有错误码和结构化信息；可用 `isSynaError(error, 'MISSING_INPUT')` 判断并收窄错误类型。返回结构详见 [API 参考][api-reference]。

## Syna 不做的事

- **代码隔离与热安装。** Service 是进程内的普通 JavaScript，不是沙箱。Runtime 的公开服务集合在构造时固定，不负责运行中安装或卸载包。
- **进程全局或分布式单例。** 实例身份与共享关系属于一个 Runtime 中的环境树，不能替代跨进程协调。
- **强制终止异步工作。** 关闭会在规定的宽限期内等待，并报告仍未结束的 setup 或清理。它不能杀死忽略 `AbortSignal` 的 JavaScript；有界的是等待，不是资源释放。
- **数据库事务。** 调用清理函数不等于替应用提交或回滚事务，事务协议由对应的数据层负责。

更多边界见[语义模型][semantic-model]和[暂不实现的能力][deferred]。

## 文档

**开始使用：** [示例][examples] · [API 参考][api-reference] · [语义模型][semantic-model] · [术语表][glossary]

**编写模块：** [包作者指南][package-authoring] · [参考应用的插件协议][plugin-authoring]

**兼容性：** [API 稳定性][api-stability] · [版本历史与迁移][history]

**参与开发：** [贡献指南][contributing] · [内部架构][architecture] · [验证记录][validation] · [审计记录][audit]

## 状态与许可

仓库正在准备首个公开版本 `syna@1.0.0-rc.1`。公开 API 已冻结；旧开发候选的名称和版本沿革保留在[历史记录][history]中。发布验证包含源码归档重建及独立安装包消费者，详细结果见[验证记录][validation]。

采用 MIT 许可证。源码与问题反馈：[synajs/syna](https://github.com/synajs/syna)。

[examples]: https://github.com/synajs/syna/blob/main/docs/EXAMPLES.md
[api-reference]: https://github.com/synajs/syna/blob/main/docs/API_REFERENCE.md
[semantic-model]: https://github.com/synajs/syna/blob/main/docs/SEMANTIC_MODEL.md
[glossary]: https://github.com/synajs/syna/blob/main/docs/GLOSSARY.md
[package-authoring]: https://github.com/synajs/syna/blob/main/docs/PACKAGE_AUTHORING.md
[plugin-authoring]: https://github.com/synajs/syna/blob/main/docs/PLUGIN_AUTHORING.md
[api-stability]: https://github.com/synajs/syna/blob/main/docs/API_STABILITY.md
[history]: https://github.com/synajs/syna/blob/main/docs/HISTORY.md
[architecture]: https://github.com/synajs/syna/blob/main/docs/ARCHITECTURE.md
[validation]: https://github.com/synajs/syna/blob/main/docs/VALIDATION.md
[audit]: https://github.com/synajs/syna/blob/main/docs/AUDIT.md
[contributing]: https://github.com/synajs/syna/blob/main/CONTRIBUTING.md
[deferred]: https://github.com/synajs/syna/blob/main/docs/DEFERRED.md
