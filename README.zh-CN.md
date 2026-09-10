# Syna

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

用显式生命周期组合有状态 TypeScript 服务的运行时。

[English](https://github.com/synajs/syna/blob/main/README.md) | 简体中文

大多数程序都持有一些必须先创建、用完要释放的东西：数据库连接池、带着某个租户凭据的 API 客户端、只属于一次请求的缓存。手写创建过程一直可行，直到同一个东西要在两处同时使用，或者其中一个必须按租户、按请求、按客户的配置而不同。此时这些接线开始回答它当初并不是为之而写的问题——谁创建它、谁可以共享它、什么时候关闭才安全——而答案散落在工厂函数、模块级单例和 `finally` 块里。

Syna 把这些问题移进声明。一个 Service 声明它需要什么、如何启动、如何释放。一次调用为你手上的上下文打开一个世界：整个程序、一个租户、一次请求。在一个世界内，一个 Service 最多存在一份，并且只在有人索取时才存在；子世界复用父世界已有的部分，只为依赖于子世界改变了的事实的那些部分另建一份。世界结束时，它创建的东西按依赖顺序释放——无论代码是正常返回还是抛出异常。

## 安装

```sh
npm install syna@rc
```

- Node.js ≥ 22。
- 建议使用 TypeScript。依赖是带类型的描述符，写错或漏写会在编译期报错；这个包自带类型声明，运行时不需要任何其他东西。

## 快速开始

三个文件。程序在第一次查询需要连接池时打开它，并在世界结束时关闭它。

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

await runtime.run(App, { config: { url: 'postgres://localhost/app', poolSize: 4 } }, async ({ database }) => {
  const db = await database.load()
  console.log(await db.query('select 1'))
})

await runtime.dispose()

// Stands in for a real driver: what matters is where it is opened and who closes it.
async function openPool(url: string, poolSize: number) {
  console.log(`opened ${url} (${poolSize} connections)`)
  return {
    run: async (sql: string) => `${sql} -> 1 row`,
    close: async () => console.log(`closed ${url}`),
  }
}
```

安装 TypeScript（`npm install -D typescript @types/node`），然后 `npx tsc && node dist/main.js` 打印：

```
opened postgres://localhost/app (4 connections)
select 1 -> 1 row
closed postgres://localhost/app
```

从后往前读：`runtime.run()` 打开了一个世界，把 Entry 声明的依赖交给回调，并在回调返回时关闭这个世界——连接池就是在那一刻关闭的，执行的是它自己的 `setup()` 注册的清理。创建连接池的是 `database.load()`；如果回调从未调用它，就不会有连接池被打开。`{ url, poolSize }` 这条记录是那个世界的事实：Service 同步读取它，而用另一条记录进入的世界会得到另一个连接池。

上面没有任何一处注册进程退出钩子、在 `finally` 块里关闭连接池，或者把 `db` 参数一层层传下去。

## Runtime、Entry、Env、Service、Input

**Runtime。** 一个 Runtime 知道这个程序可以使用哪些 Service 定义。创建它本身不启动任何东西：它只接纳定义，其余一切都是进入世界之后的结果。

**Entry。** Entry 描述一个世界向进入它的代码提供什么（`requires`），以及调用者必须提供什么才能打开一个（`parameters`）。它是世界的门，并且是类型化的：`env.deps` 的形状正是 Entry 声明的形状。

**Env。** 一个 Env 就是一次执行世界——一个程序、一个租户、一次请求。子世界会复用父世界中仍然适用的 Service；当某个 Input 或某个实现选择发生变化时，依赖于该变化的部分在子世界中重新创建，其余部分继续共享。关闭一个 Env 会释放那个世界创建的东西。

**Service。** 具有 identity、依赖和生命周期的受管部件。`setup()` 获取资源并返回实例；它用 `onDispose()` 注册的清理会在拥有该 slot 的世界结束时释放它。Service 从不关闭不是自己创建的依赖。

**Input。** 世界的一条外部事实，由调用者提供、被同步读取——一条租户记录、一次请求、一份配置。Input 自身没有生命周期；它改变的是一个世界必须创建哪些 Service。

**Contract 与 Binding** 稍后再谈：当实现是被选择的而不是被写死的时候。

形式化模型见 [docs/SEMANTIC_MODEL.md][semantic-model]，术语见 [docs/GLOSSARY.md][glossary]，完整公开面见 [docs/API_REFERENCE.md][api-reference]。

## 每个租户一个世界

快速开始里只有一个世界。真正有用的形状是一棵世界树：共享的基础设施在上，每个租户一个世界在下。

```
app world                      pool #1
├── tenant world "acme"        mail client of acme    ─┐ same pool,
└── tenant world "globex"      mail client of globex  ─┘ separate clients
```

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
  async setup(_deps, { onDispose }): Promise<Pool> {
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
    const { id, apiKey } = tenant.read()
    const db = await pool.load()
    console.log(`mail client of ${id} opened on pool #${db.id}`)
    onDispose(() => console.log(`mail client of ${id} closed`))
    return {
      send: async to => `${id}: mail to ${to} accepted with ${apiKey} (${await db.run('insert into outbox')})`,
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
const app = await runtime.enter(App)

for (const tenant of [{ id: 'acme', apiKey: 'key-acme' }, { id: 'globex', apiKey: 'key-globex' }]) {
  await app.run(TenantEntry, { tenant }, async ({ mail }) => {
    console.log(await (await mail.load()).send('owner@example.test'))
  })
}

await app.dispose()
await runtime.dispose()
```

`node dist/tenants.js` 打印：

```
pool #1 opened
mail client of acme opened on pool #1
acme: mail to owner@example.test accepted with key-acme (insert into outbox: ok)
mail client of acme closed
mail client of globex opened on pool #1
globex: mail to owner@example.test accepted with key-globex (insert into outbox: ok)
mail client of globex closed
pool #1 closed
```

`MailClient` 从头到尾没有提到"租户世界"。它 `requires` 了 `CurrentTenant`，这就够了：每个租户世界提供自己的租户，于是每个都拿到自己的客户端。`Pool` 不依赖任何上下文事实，因此两个租户世界用的都是 app 世界持有的那一个——而且在第一个租户世界关闭之后它仍然开着。`reuse: { share: [Pool] }` 把这一点写成要求而不是期望：在这个 Entry 下要求一个全新连接池的调用者会被拒绝，而不是悄悄得到第二个。

同样的形状适用于会结束的工作：一次请求、一次构建、一个定时任务。工作开始时进入一个世界，让属于它的 Service 在那里创建，工作做完就关闭这个世界——当你只需要一个边界时，`env.derive()` 可以打开一个没有自己 Entry 的子世界。

## 选择一个实现

当一个 Service 是若干可能实现之一时，为它的形状声明一个 Contract，让各个 Service 提供它。Binding 承载这个选择，并且是调用者可以存起来的值：

```ts
export interface Mailer {
  send(to: string, text: string): Promise<string>
}

export const Mailer = define.contract<Mailer>('mailer')
export const Preferred = define.binding('preferred-mailer', Mailer)

const SmtpMailer = define.service('smtp-mailer', { provides: [Mailer], setup: () => ({ send: async () => 'sent' }) })
const ApiMailer = define.service('api-mailer', { provides: [Mailer], setup: () => ({ send: async () => 'sent' }) })

const TenantEntry = define.entry('tenant', {
  requires: { mail: Preferred },
  parameters: { tenant: CurrentTenant, mail: Preferred },
})

// 租户设置表里可以存的东西：{ "kind": "implementation-ref", "contractId": …, "familyId": …, "range": … }
const stored = JSON.stringify(Preferred.to(ApiMailer))

await runtime.run(TenantEntry, { tenant, mail: Preferred.parse(JSON.parse(stored)) }, async ({ mail }) => {
  await (await mail.load()).send('owner@example.test', 'hello')
})
```

`Preferred.to(service)` 写出一个 JSON 安全的引用，`Preferred.parse(value)` 把它读回来，并拒绝任何不是指向该 Contract 的东西。选择是世界的参数，因此选择不同的两个租户就是两个世界，各有自己的客户端——依赖这个 mailer 的 Service 在各自世界里分别创建，而选择之上的一切继续共享。

同一个 Service family 的多个 revision 同理：引用请求的是一个 semver 范围，因此在 `1.x` 时代选定某个实现的租户继续使用 1.x 客户端，新租户得到 2.x——在同一个程序里。

## 测试

override 在构造 Runtime 时替换某个 Service 的实现，而不动被测代码。被替换的 Service 保留它的 identity、它的 Contract 归属，以及它在每个计划中的位置：

```ts
import { createRuntime, override } from 'syna'

const RecordingMailer = define.service('recording-mailer', {
  provides: [Mailer],
  setup: () => ({ send: async (to: string) => `recorded ${to}` }),
})

const runtime = createRuntime({
  services: [Pool, MailClient],
  overrides: [override(SmtpMailer, RecordingMailer)],
})
```

其余一切不变：同样的 Entry、同样的世界、同样的清理。

## 诊断

有三个问题可以在不创建任何东西的前提下问出来：

```ts
const check = await runtime.check(TenantEntry, { tenant })          // 这个世界能不能规划出来？不能的话为什么
const plan = await runtime.explain(TenantEntry, { tenant })         // 它会创建、复用还是 fork 什么，以及为什么
if (plan.ok) console.log(plan.services, plan.forks.map(fork => `${fork.placement} ${fork.label}`))

const env = await runtime.enter(App)
console.log(env.inspect().nodes)                                    // 这个世界实际有什么，逐个 slot
```

`check()` 与 `explain()` 只做规划——不创建任何 Service，也不打开任何世界。`explain()` 会点名它将创建、复用或 fork 的每个节点以及每次 fork 的成因，这是"一个世界创建的东西比预期多"时首先该读的东西。失败是带 `code` 和结构化 `details` 的 `SynaError`；`isSynaError(error, 'MISSING_INPUT')` 可以把它收窄到一种。具体形状见 [docs/API_REFERENCE.md][api-reference]。

## Syna 不做的事

- 不为不受信任的代码提供沙箱。Service 的 `setup()` 就是普通 JavaScript，拥有进程的全部权限。
- 不在程序运行期间安装或卸载包。Runtime 的接纳集合在创建时就固定了。
- 不是分布式或进程全局的单例注册表。identity 与复用属于一个 Runtime，在一个进程之内。
- 不把任意配置的相等性变成复用语义。让世界 fork 的是声明出来的 Input、Binding 或结构差异，而不是两个选项对象的深度相等。
- 无法终止忽略 `AbortSignal` 的 JavaScript。关闭会等待一段有界的时间，然后报告有什么活过了它；有界的是等待，而不是资源的释放。
- 不提供领域相关的事务保证。给清理排序不等于提交或回滚你的数据库工作。

[docs/SEMANTIC_MODEL.md][semantic-model] 精确陈述这些保证，[docs/DEFERRED.md][deferred] 记录看到过但有意不做的事。

## 文档

从这里开始

- [示例][examples] —— 七个递进的程序，每个回答一个问题，全部由发布门禁运行
- [API 参考][api-reference] —— 完整公开面，以及每个错误码的细节
- [语义模型][semantic-model] —— 世界、slot、复用、物化与关闭的精确陈述
- [术语表][glossary] —— 中英对照的词汇

编写包

- [包作者指南][package-authoring] —— 一个包如何声明它的 Service、Contract、Input 与 Binding
- [插件作者指南][plugin-authoring] —— 参考应用的插件协议

兼容性

- [API 稳定性][api-stability] —— 冻结的公开面与命名规则
- [历史][history] —— 各次发布、它们的任务书与迁移说明

内部

- [架构][architecture] —— 实现中的模块边界
- [验证][validation] —— 记录下来的发布运行
- [审计][audit] —— 独立审计的发现
- [在这个仓库里工作][contributing] —— 如何构建、测试与发布 Syna 本身

## 状态

`syna@1.0.0-rc.1` 是一个候选发布版：公开 API 自 0.8.0 起冻结，1.0 之前不再改变其中任何名字或语义。发布从重建的源码归档中验证，其中包括打包后的包在独立消费者项目里的测试；[docs/VALIDATION.md][validation] 记录了这次运行。

MIT 许可。源码、问题与讨论：[github.com/synajs/syna](https://github.com/synajs/syna)。

[api-reference]: https://github.com/synajs/syna/blob/main/docs/API_REFERENCE.md
[api-stability]: https://github.com/synajs/syna/blob/main/docs/API_STABILITY.md
[architecture]: https://github.com/synajs/syna/blob/main/docs/ARCHITECTURE.md
[audit]: https://github.com/synajs/syna/blob/main/docs/AUDIT.md
[contributing]: https://github.com/synajs/syna/blob/main/CONTRIBUTING.md
[deferred]: https://github.com/synajs/syna/blob/main/docs/DEFERRED.md
[examples]: https://github.com/synajs/syna/blob/main/docs/EXAMPLES.md
[glossary]: https://github.com/synajs/syna/blob/main/docs/GLOSSARY.md
[history]: https://github.com/synajs/syna/blob/main/docs/HISTORY.md
[package-authoring]: https://github.com/synajs/syna/blob/main/docs/PACKAGE_AUTHORING.md
[plugin-authoring]: https://github.com/synajs/syna/blob/main/docs/PLUGIN_AUTHORING.md
[semantic-model]: https://github.com/synajs/syna/blob/main/docs/SEMANTIC_MODEL.md
[validation]: https://github.com/synajs/syna/blob/main/docs/VALIDATION.md
