// 01-basics: define services, connect them, enter a world.
//
// The domain: one connection to a notification provider, a dispatcher that uses it,
// and a program that must open the connection when it is first needed and close it
// when the program is done.
import assert from 'node:assert/strict'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from 'synajs'
import { Logger } from '@syna-demo/logger'

const define = definePackage(packageJson)

interface Notification {
  readonly id: string
  readonly to: string
  readonly subject: string
}

interface Delivery {
  readonly notificationId: string
  readonly receipt: string
}

/** The one resource this program owns: a (fake) connection to the Acme notification API. */
export interface AcmeConnection {
  readonly id: number
  readonly open: boolean
  send(notification: Notification): Promise<Delivery>
}

let connectionsOpened = 0
let connectionsOpen = 0

// A Service owns a resource: `setup` acquires it, the cleanup given to `onDispose`
// releases it. It needs the logger, so it names it in `requires` and receives a
// ref — and it never closes the logger: that is the logger's own business.
export const AcmeConnection = define.service('acme-connection', {
  requires: { logger: Logger },
  async setup({ logger }, { onDispose }): Promise<AcmeConnection> {
    const log = await logger.load()
    const id = ++connectionsOpened
    let open = true
    let sent = 0
    connectionsOpen += 1
    log.info(`acme connection #${id} opened`)
    onDispose(() => {
      open = false
      connectionsOpen -= 1
      log.info(`acme connection #${id} closed`)
    })
    return {
      id,
      get open() {
        return open
      },
      async send(notification) {
        if (!open) throw new Error(`acme connection #${id} is closed`)
        sent += 1
        return { notificationId: notification.id, receipt: `acme-${sent}` }
      },
    }
  },
})

export interface Dispatcher {
  deliver(notification: Notification): Promise<Delivery>
}

// A Service that uses another Service holds a ref to it. Nothing behind the ref
// exists until `load()` is called: the connection opens on the first delivery.
export const Dispatcher = define.service('dispatcher', {
  requires: { connection: AcmeConnection, logger: Logger },
  async setup({ connection, logger }): Promise<Dispatcher> {
    const log = await logger.load()
    return {
      async deliver(notification) {
        const acme = await connection.load()
        const delivery = await acme.send(notification)
        log.info(`delivered ${notification.id} to ${notification.to} (receipt ${delivery.receipt})`)
        return delivery
      },
    }
  },
})

// An Entry says what a world offers to the code that enters it.
export const Main = define.entry('main', {
  requires: { dispatcher: Dispatcher, logger: Logger },
})

// A Runtime admits the Services a program may use. Entering `Main` creates a world;
// `run()` enters it, hands the callback the refs, and closes the world afterwards.
const runtime = createRuntime({ services: [Dispatcher, AcmeConnection, Logger] })

let openedBeforeFirstDelivery = -1
let log: Logger | undefined
const delivery = await runtime.run(Main, async ({ dispatcher, logger }) => {
  log = await logger.load()
  const dispatch = await dispatcher.load()
  openedBeforeFirstDelivery = connectionsOpened
  return dispatch.deliver({ id: 'welcome-1', to: 'ada@example.test', subject: 'Welcome' })
})
const liveWorlds = runtime.inspect().liveEnvCount
await runtime.dispose()

console.log(`01-basics: delivered ${delivery.notificationId} to ada@example.test (receipt ${delivery.receipt})`)
console.log(`01-basics: connection opened only on the first delivery: ${openedBeforeFirstDelivery === 0 && connectionsOpened === 1}`)
console.log(`01-basics: connection closed after the world ended: ${connectionsOpen === 0}`)
const messages = log?.messages ?? []
const closedAfterConnection = messages.indexOf('[info] acme connection #1 closed') < messages.indexOf('[info] logger: sink closed')
console.log(`01-basics: logger closed last, by its own cleanup: ${closedAfterConnection && log?.closed === true}`)

// The demo checks what it printed; exit 0 alone proves only the absence of a crash.
assert.deepEqual(delivery, { notificationId: 'welcome-1', receipt: 'acme-1' })
assert.equal(openedBeforeFirstDelivery, 0)
assert.equal(connectionsOpened, 1)
assert.equal(connectionsOpen, 0)
assert.equal(closedAfterConnection, true)
assert.equal(log?.closed, true)
assert.equal(liveWorlds, 0)
console.log('01-basics: OK')
