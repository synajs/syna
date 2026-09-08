import type { Env } from '@syna/core'
import { define } from '../syna.js'
import { ContentBackend } from '../domain/content.js'
import type { SiteConfig } from '../domain/model.js'
import { SiteAuth } from '../auth/contract.js'
import { SiteEntry } from './entries.js'
import { DEFAULT_SITE_MANAGER_SETTINGS, SiteManagerOptions, defaultReservedForRequests, type SiteManagerSettings } from './inputs.js'
import type { SiteContext } from './context.js'

export type LeasePurpose = 'request' | 'build' | 'background'

export interface SiteLease {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  readonly env: Env<typeof SiteEntry['requires']>
  readonly context: SiteContext
  /** Idempotent. */
  release(): void
}

export interface SiteRecordView {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  /** `disposing`: the Env is being closed; its key is already free for a successor, but it occupies its unit of capacity until the close settles. */
  readonly state: 'creating' | 'active' | 'draining' | 'disposing' | 'disposed'
  readonly leases: number
  readonly idleForMs: number | undefined
}

export interface SiteManagerStats {
  readonly capacity: number
  /** Units only request leases may take as new SiteEnvs (see `SiteManagerSettings.reservedForRequests`). */
  readonly reservedForRequests: number
  /** Records occupying capacity: creating + active + draining + disposing. Never exceeds `capacity`. */
  readonly records: number
  readonly active: number
  readonly idle: number
  readonly creating: number
  readonly draining: number
  readonly disposing: number
  readonly leases: number
  /** The capacity queue: acquirers waiting for a unit of the working set (never the ones reading configuration). */
  readonly pendingAcquires: number
  readonly waitingByPurpose: Readonly<Record<LeasePurpose, number>>
  /** Configuration round-trips in flight (single-flight per tenant: several acquirers may share one). */
  readonly inFlightConfigReads: number
  /** `acquire()` calls that have not settled, whatever stage they are in. */
  readonly inFlightAcquires: number
  readonly evictions: number
  readonly creations: number
  readonly creationFailures: number
  /** SiteEnv closes that rejected (reported through `onDisposalError`). */
  readonly disposalFailures: number
  readonly rejectedForCapacity: number
  readonly closed: boolean
}

export class SiteCapacityError extends Error {
  readonly code = 'SITE_CAPACITY'
  constructor(message: string) {
    super(message)
    this.name = 'SiteCapacityError'
  }
}

export class SiteManagerClosedError extends Error {
  readonly code = 'SITE_MANAGER_CLOSED'
  constructor(options?: { readonly cause?: unknown }) {
    super('The site environment manager is shutting down; no new site environments are acquired.', options)
    this.name = 'SiteManagerClosedError'
  }
}

export class SiteCreationBackoffError extends Error {
  readonly code = 'SITE_CREATION_BACKOFF'
  constructor(
    readonly tenantId: string,
    readonly failures: number,
    readonly until: Date,
    cause: unknown,
  ) {
    super(`Site ${tenantId} creation is backing off after ${failures} failure(s) until ${until.toISOString()}.`, { cause })
    this.name = 'SiteCreationBackoffError'
  }
}

export class UnknownTenantError extends Error {
  readonly code = 'UNKNOWN_TENANT'
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} has no site configuration.`)
    this.name = 'UnknownTenantError'
  }
}

export interface SiteEnvironmentManager {
  /** Loads the tenant's current configuration and returns a lease on the matching SiteEnv (single-flight per key). */
  acquire(tenantId: string, purpose: LeasePurpose): Promise<SiteLease>
  /**
   * Marks every environment of a tenant as stale: the next acquire reads the
   * store again and creates a fresh SiteEnv even when `configRevision` did not
   * change (a per-tenant generation is part of the key). Draining envs close
   * as soon as their last lease ends.
   */
  invalidate(tenantId: string): void
  /** Forces the idle sweep now (tests). */
  sweep(): Promise<number>
  records(): readonly SiteRecordView[]
  stats(): SiteManagerStats
  readonly settings: SiteManagerSettings
  /** Refuses new acquires, waits for leases up to the shutdown timeout, disposes every SiteEnv. Reports leases still held. */
  shutdown(): Promise<{ readonly unreleasedLeases: readonly string[] }>
}

interface SiteRecord {
  readonly key: string
  readonly tenantId: string
  readonly configRevision: number
  /** The tenant generation (invalidate() counter) this world was created for; part of the key. */
  readonly generation: number
  state: 'creating' | 'active' | 'draining' | 'disposing' | 'disposed'
  leases: number
  lastReleasedAt: number
  env?: Env<typeof SiteEntry['requires']>
  context?: SiteContext
  creation?: Promise<void>
  disposal?: Promise<void>
  /** Set by the close that took `env`; a creator whose Env was attached after that close ran closes it itself. */
  envClosed?: boolean
}

interface Waiter {
  readonly purpose: LeasePurpose
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

function runtimeIdentity(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
}

/** An acquirer that must read the configuration again waits this long first: a store that answered a moment ago answers the same now. */
const RETRY_PACE_MS = 5

/**
 * SiteEnvs are a bounded working set, not tenant existence. Business facts
 * (posts, recipes, configuration versions) live in the content store; a
 * SiteEnv is only a cached, leased composition of them for one configuration
 * revision. Eviction therefore never loses data, and stale configuration is
 * handled by version rotation, never by evicting live tenants.
 */
export const SiteEnvironmentManager = define.service('site-environment-manager', {
  requires: { sites: SiteEntry, store: ContentBackend, options: SiteManagerOptions },
  async setup({ sites, store, options }, { onDispose, signal }): Promise<SiteEnvironmentManager> {
    const provided = options.read()
    const merged = { ...DEFAULT_SITE_MANAGER_SETTINGS, ...provided }
    const settings: SiteManagerSettings = Object.freeze({
      ...merged,
      reservedForRequests: provided.reservedForRequests ?? defaultReservedForRequests(merged.capacity),
    })
    if (!Number.isSafeInteger(settings.capacity) || settings.capacity < 1) {
      throw new TypeError('siteManager.capacity must be a positive integer.')
    }
    if (!Number.isSafeInteger(settings.reservedForRequests) || settings.reservedForRequests < 0 || settings.reservedForRequests >= settings.capacity) {
      throw new TypeError(`siteManager.reservedForRequests must be an integer in [0, capacity); got ${String(settings.reservedForRequests)} for capacity ${settings.capacity}.`)
    }
    if (!Number.isSafeInteger(settings.pageCacheMaxEntries) || settings.pageCacheMaxEntries < 1) {
      throw new TypeError(`siteManager.pageCacheMaxEntries must be a positive integer; got ${String(settings.pageCacheMaxEntries)}.`)
    }
    const boundSites = await sites.load()
    const contentStore = await store.load()
    const runtimeId = runtimeIdentity()

    const records = new Map<string, SiteRecord>()
    const waiters: Waiter[] = []
    /** Capacity granted to acquirers that have not inserted their record yet. */
    let reservations = 0
    /** Bumped by invalidate(): part of the key, so a stale env is replaced even at the same configRevision. */
    const generations = new Map<string, number>()
    const failureBackoff = new Map<string, { count: number; until: number; error: unknown }>()
    /** Refuses new acquires. Set by the owner's stop signal and by `shutdown()`; never a reason to skip the shutdown itself. */
    let admissionClosed = false
    /** The one shutdown of this manager: `onDispose` and every explicit call await the same run. */
    let shutdownPromise: Promise<{ readonly unreleasedLeases: readonly string[] }> | undefined
    let inFlightAcquires = 0
    let evictions = 0
    let creations = 0
    let creationFailures = 0
    let disposalFailures = 0
    let rejectedForCapacity = 0

    const keyFor = (tenantId: string, configRevision: number): string =>
      `${runtimeId}|${tenantId}|${configRevision}|g${generations.get(tenantId) ?? 0}`

    const assertNotBackingOff = (tenantId: string): void => {
      const backoff = failureBackoff.get(tenantId)
      if (backoff && Date.now() < backoff.until) {
        throw new SiteCreationBackoffError(tenantId, backoff.count, new Date(backoff.until), backoff.error)
      }
    }

    /** Concurrent acquirers of one tenant share a single store round-trip. */
    const configReads = new Map<string, Promise<SiteConfig>>()
    const readConfig = (tenantId: string): Promise<SiteConfig> => {
      let pending = configReads.get(tenantId)
      if (!pending) {
        pending = (async () => {
          const config = await contentStore.forTenant(tenantId).getSiteConfig()
          if (!config) throw new UnknownTenantError(tenantId)
          return config
        })().finally(() => { configReads.delete(tenantId) })
        configReads.set(tenantId, pending)
      }
      return pending
    }

    /** Callers waiting for a shared configuration read; a shutdown ends their wait without cancelling the read. */
    const configWaiters = new Set<(error: Error) => void>()
    /** Callers waiting for a shared site creation; a shutdown ends their wait without cancelling the creation. */
    const creationWaiters = new Set<(error: Error) => void>()

    /**
     * One caller's wait on something shared — the configuration round-trip, the
     * creation of a site, the close of a record — bounded by what is left of the
     * acquire deadline (docs/MULTITENANT_BLOG.md: one deadline for the whole
     * acquire) and ended by a shutdown.
     *
     * Only this caller's wait ends. The shared task is never cancelled: it keeps
     * running, keeps whatever it acquired and stays available to everyone else
     * joined to it. A deadline that belonged to the task instead of to the caller
     * would fail the second acquirer because the first one grew impatient, would
     * count that impatience as a creation failure of the tenant (arming the
     * backoff), and would leave a half-created Env with no owner.
     */
    const waitWithin = <T>(
      pending: Promise<T>,
      deadline: number,
      waiters: Set<(error: Error) => void>,
      timedOut: () => Error,
    ): Promise<T> => new Promise<T>((resolve, reject) => {
      const end = (settle: () => void): void => {
        clearTimeout(timer)
        waiters.delete(cancel)
        settle()
      }
      const cancel = (error: Error): void => end(() => reject(error))
      const timer = setTimeout(() => cancel(timedOut()), Math.max(0, Math.min(settings.acquireTimeoutMs, deadline - Date.now())))
      waiters.add(cancel)
      pending.then(value => end(() => resolve(value)), error => end(() => reject(error)))
    })

    const readConfigWithin = (tenantId: string, deadline: number): Promise<SiteConfig> =>
      waitWithin(readConfig(tenantId), deadline, configWaiters, () => new SiteCapacityError(
        `Site ${tenantId} configuration was not read within ${settings.acquireTimeoutMs} ms while acquiring.`,
      ))

    /**
     * One acquirer's wait on the creation of a site — its own `create()` or one it
     * joined through `record.creation`. It covers everything inside the creation:
     * `boundSites.enter()`, the context load and the authenticator load, none of
     * which takes a deadline or a signal of its own.
     */
    const awaitCreationWithin = (record: SiteRecord, pending: Promise<void>, deadline: number): Promise<void> =>
      waitWithin(pending, deadline, creationWaiters, () => new SiteCapacityError(
        `Site ${record.tenantId} environment ${record.key} was not created within ${settings.acquireTimeoutMs} ms while acquiring.`,
      ))

    /** Records whose Env is being closed: no longer under their key (a successor may be created at once) but still occupying their unit until the close settles. */
    const closing = new Set<SiteRecord>()
    const liveRecords = (): SiteRecord[] => [...records.values(), ...closing].filter(record => record.state !== 'disposed')
    const capacityUsed = (): number => liveRecords().length + reservations

    /** Whether `free` units of capacity would let the next eligible waiter proceed. */
    const waiterServable = (free: number): boolean => {
      if (waiters.length === 0) return false
      return waiters.some(waiter => waiter.purpose === 'request') ? free > 0 : free > settings.reservedForRequests
    }

    /**
     * Hands one freed unit of capacity to a waiting acquirer, as a reservation it
     * already owns when it wakes: the longest-waiting request first; a build or
     * background acquirer only while more than `reservedForRequests` units are free.
     */
    const grantWaiter = (): void => {
      if (!waiterServable(settings.capacity - capacityUsed())) return
      const index = Math.max(0, waiters.findIndex(waiter => waiter.purpose === 'request'))
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter!.timer)
      reservations += 1
      waiter!.resolve()
    }

    /** A reservation that will not become a record: the unit is free again, and the queue is told. */
    const releaseReservation = (): void => {
      reservations -= 1
      grantWaiter()
    }

    const isNewer = (record: SiteRecord, generation: number, configRevision: number): boolean =>
      record.generation > generation || (record.generation === generation && record.configRevision > configRevision)

    /** The newest world of a tenant that still accepts leases, by (generation, configRevision). */
    const newestLiveRecord = (tenantId: string): SiteRecord | undefined => {
      let newest: SiteRecord | undefined
      for (const record of liveRecords()) {
        if (record.tenantId !== tenantId || record.state === 'draining' || record.state === 'disposing') continue
        if (!newest || isNewer(record, newest.generation, newest.configRevision)) newest = record
      }
      return newest
    }

    /** A record nobody leases must not outlive its usefulness: draining (or closing) → dispose. */
    const settle = (record: SiteRecord): void => {
      if (record.leases === 0 && record.state !== 'disposed' && record.state !== 'disposing' && (record.state === 'draining' || admissionClosed)) {
        void disposeRecord(record)
      }
    }

    const reportDisposalFailure = (error: unknown, record: SiteRecord): void => {
      disposalFailures += 1
      try { settings.onDisposalError(error, { key: record.key, tenantId: record.tenantId, configRevision: record.configRevision }) }
      catch { /* a reporting hook must not change the manager's outcome */ }
    }

    /**
     * Closes a record's Env. The record leaves its key at once, so an acquirer of
     * that world creates its successor instead of waiting for the close, but it
     * keeps its unit of capacity until the close has settled (state `disposing`);
     * only then is the unit handed to the longest waiter, in the same tick, so
     * nobody can slip a new Env in ahead of the queue. Never rejects: a failed
     * close is reported and counted, and the Runtime keeps its own ledger of
     * unsettled attempts.
     */
    const disposeRecord = (record: SiteRecord): Promise<void> => {
      if (record.disposal) return record.disposal
      record.state = 'disposing'
      if (records.get(record.key) === record) records.delete(record.key)
      closing.add(record)
      const env = record.env
      if (env) record.envClosed = true
      record.disposal = (async () => {
        try { await env?.dispose() }
        catch (error) { reportDisposalFailure(error, record) }
        finally {
          record.state = 'disposed'
          closing.delete(record)
          grantWaiter()
        }
      })()
      return record.disposal
    }

    /** Active records without leases, longest idle first. */
    const idleRecords = (): SiteRecord[] => liveRecords()
      .filter(record => record.state === 'active' && record.leases === 0)
      .sort((left, right) => left.lastReleasedAt - right.lastReleasedAt)

    /** Starts closing the longest-idle active record without leases. Never evicts a leased record. */
    const evictIdle = (): boolean => {
      const victim = idleRecords()[0]
      if (!victim) return false
      evictions += 1
      void disposeRecord(victim)
      return true
    }

    const waitForCapacity = (purpose: LeasePurpose, deadline: number): Promise<void> => {
      if (waiters.length >= settings.maxPendingAcquires) {
        rejectedForCapacity += 1
        return Promise.reject(new SiteCapacityError(
          `All ${settings.capacity} site environments are leased and ${waiters.length} acquirers are already waiting.`,
        ))
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          purpose,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            rejectedForCapacity += 1
            reject(new SiteCapacityError(`Timed out after ${settings.acquireTimeoutMs} ms waiting for a site environment.`))
          }, Math.max(0, Math.min(settings.acquireTimeoutMs, deadline - Date.now()))), // one deadline for the whole acquire, however often it waits
        }
        waiters.push(waiter)
      })
    }

    /**
     * Returns holding one reservation. When the working set is full for this
     * purpose (requests may use every unit; builds and background work leave
     * `reservedForRequests` units alone), the acquirer starts closing as many
     * idle Envs as would let it proceed (a request needs one; none at all when
     * the idle Envs would not suffice, since closing warm Envs for a build that
     * is refused anyway only thrashes the working set) and joins the queue: the
     * unit is granted, in arrival order and requests first, only once a close
     * settles, so the working set never exceeds `capacity` even while Envs are
     * closing.
     */
    const reserveCapacity = async (purpose: LeasePurpose, deadline: number): Promise<void> => {
      const limit = purpose === 'request' ? settings.capacity : settings.capacity - settings.reservedForRequests
      if (capacityUsed() < limit) {
        reservations += 1
        return
      }
      if (waiters.length >= settings.maxPendingAcquires) {
        rejectedForCapacity += 1
        throw new SiteCapacityError(
          `All ${settings.capacity} site environments are leased and ${waiters.length} acquirers are already waiting.`,
        )
      }
      const needed = purpose === 'request' ? 1 : settings.reservedForRequests + 1 - (settings.capacity - capacityUsed())
      if (idleRecords().length >= needed) {
        for (let count = 0; count < needed; count += 1) evictIdle()
      }
      await waitForCapacity(purpose, deadline) // resolved with a reservation already granted to this acquirer
      if (admissionClosed) { releaseReservation(); throw new SiteManagerClosedError() }
    }

    const create = (record: SiteRecord, config: SiteConfig): Promise<void> => {
      record.creation = (async () => {
        // The creation holds the record, not the acquirer that started it: an
        // acquirer whose own deadline passes stops waiting, while the world it
        // started keeps its unit of capacity and its place under its key until it
        // is finished — or has failed and closed itself.
        record.leases += 1
        let env: Env<typeof SiteEntry['requires']> | undefined
        try {
          env = await boundSites.enter({
            tenant: record.tenantId,
            snapshot: config,
            auth: SiteAuth.parse(config.auth.implementation),
            authOptions: config.auth.options,
          })
          // From here on the Env belongs to the record: a shutdown that reaches the
          // record closes it, and every failure below closes it before giving up.
          record.env = env
          if (record.state === 'disposed' || record.state === 'disposing' || admissionClosed) throw new SiteManagerClosedError()
          record.context = await env.deps.context.load()
          // Every request needs the authenticator; loading it here surfaces configuration
          // errors at creation, including an override whose instance lacks the interface.
          const authenticator = await env.deps.auth.load()
          if (typeof authenticator !== 'object' || authenticator === null || typeof authenticator.authenticate !== 'function' || typeof authenticator.scheme !== 'string') {
            throw new TypeError(`Site ${record.tenantId}: the configured authenticator does not implement the Authenticator interface (scheme + authenticate()).`)
          }
          record.state = record.state === 'creating' ? 'active' : record.state
          creations += 1
          failureBackoff.delete(record.tenantId)
        }
        catch (caught) {
          // A shutdown that took the record while its site was still starting is not a
          // failure of the tenant, whatever the Runtime reported when the Env was closed
          // under its setup: the acquirer is refused as closed, nothing is counted
          // against the tenant and no backoff is armed.
          const takenAway = admissionClosed || record.disposal !== undefined
          const error = takenAway && !(caught instanceof SiteManagerClosedError) ? new SiteManagerClosedError({ cause: caught }) : caught
          if (!(error instanceof SiteManagerClosedError)) {
            creationFailures += 1
            // Never leave a poisoned single-flight promise behind; back off future attempts.
            const previous = failureBackoff.get(record.tenantId)
            const count = (previous?.count ?? 0) + 1
            const delay = Math.min(settings.creationBackoffMaxMs, settings.creationBackoffMs * 2 ** (count - 1))
            failureBackoff.set(record.tenantId, { count, until: Date.now() + delay, error })
          }
          if (record.disposal) {
            // A shutdown already took the record and closes the Env — unless it ran before
            // the Env was attached (enter() still pending): then it closed nothing, and the
            // Env is closed here rather than left to the Runtime's final disposal.
            await record.disposal
            if (env && !record.envClosed) {
              record.envClosed = true
              try { await env.dispose() }
              catch (disposalError) { reportDisposalFailure(disposalError, record) }
            }
          }
          else {
            // A half-configured site is closed, never dropped: the Env was entered.
            await disposeRecord(record)
          }
          throw error
        }
        finally {
          record.leases -= 1
          settle(record) // rotated to draining while it was being created → close it now
        }
      })()
      return record.creation
    }

    const acquireWithin = async (tenantId: string, purpose: LeasePurpose): Promise<SiteLease> => {
      // A configuration that keeps changing while we acquire makes us re-read and
      // join the newest world; that is bounded by the acquire timeout, not by a
      // fixed number of attempts, so a burst of saves cannot fail live requests.
      const deadline = Date.now() + settings.acquireTimeoutMs
      const stillRetrying = (): boolean => Date.now() < deadline
      const keptChanging = (attempt: number, what: string): SiteCapacityError =>
        new SiteCapacityError(`Site ${tenantId} ${what} for ${settings.acquireTimeoutMs} ms while acquiring (${attempt} attempts).`)
      // Reading again at once is never useful (a store that answered a moment ago answers
      // the same now): a retry that must re-read is paced, within the deadline.
      const pace = async (): Promise<void> => {
        const remaining = deadline - Date.now()
        if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(RETRY_PACE_MS, remaining)))
      }
      for (let attempt = 1; ; attempt += 1) {
        if (admissionClosed) throw new SiteManagerClosedError()
        assertNotBackingOff(tenantId)
        const config = await readConfigWithin(tenantId, deadline)
        // Re-checked after the store round-trip: a burst of acquirers arriving while
        // the first one fails must join the backoff, not each start its own attempt.
        assertNotBackingOff(tenantId)
        const generation = generations.get(tenantId) ?? 0
        let key = keyFor(tenantId, config.configRevision)

        // Rotation is monotonic. A concurrent acquirer may already hold a newer
        // world than this read describes (a stale read behind a save, or an
        // invalidate() that raced the read): join it, never drain it for an older
        // read. Only worlds older than the read (older revision or invalidated
        // generation) rotate to draining: no new leases, close as soon as idle.
        let record = newestLiveRecord(tenantId)
        if (record && isNewer(record, generation, config.configRevision)) {
          key = record.key
        }
        else {
          for (const other of liveRecords()) {
            if (other.tenantId === tenantId && other.key !== key && other.state !== 'draining') {
              other.state = 'draining'
              settle(other)
            }
          }
          record = records.get(key)
        }

        if (record?.state === 'draining') {
          // This acquirer read an older configuration than a concurrent one: re-read and join the newer world.
          if (stillRetrying()) { await pace(); continue }
          throw keptChanging(attempt, 'configuration kept changing')
        }
        if (!record || record.state === 'disposed') {
          await reserveCapacity(purpose, deadline)
          if (admissionClosed) { releaseReservation(); throw new SiteManagerClosedError() }
          // The wait may have outlived the read: an invalidate() moved the generation,
          // or another acquirer created this world or a newer one meanwhile. A record
          // created now from the old read would be stale from birth; read again.
          const concurrent = newestLiveRecord(tenantId)
          if ((generations.get(tenantId) ?? 0) !== generation || (concurrent && isNewer(concurrent, generation, config.configRevision))) {
            releaseReservation()
            if (stillRetrying()) continue
            throw keptChanging(attempt, 'configuration kept changing')
          }
          record = records.get(key)
          if (!record || record.state === 'disposed') {
            record = { key, tenantId, configRevision: config.configRevision, generation, state: 'creating', leases: 0, lastReleasedAt: Date.now() }
            records.set(key, record)
            reservations -= 1 // the record now counts as live capacity
            // The creation itself holds the record; this acquirer only waits for it,
            // within the one deadline of this acquire.
            await awaitCreationWithin(record, create(record, config), deadline)
          }
          else {
            releaseReservation() // somebody else inserted the record meanwhile: the unit is free again, and the queue is told
          }
        }
        if (record.state === 'creating' && record.creation) {
          // Joining somebody else's creation is a wait like any other: bounded by
          // this acquirer's deadline, and it never becomes the creation's deadline.
          await awaitCreationWithin(record, record.creation, deadline)
        }
        const env = record.env
        const context = record.context
        if (record.state !== 'active' || !env || !context) {
          // The world this acquirer waited for was rotated away (configuration bump or
          // invalidate() while it was being created) or is closing (its key is free
          // again): read the current configuration and join or create the current
          // world instead of failing the caller.
          if ((record.state === 'draining' || record.state === 'disposing' || record.state === 'disposed') && stillRetrying()) { await pace(); continue }
          throw keptChanging(attempt, `environment ${record.key} is ${record.state} and the configuration kept changing`)
        }
        record.leases += 1
        let released = false
        const current = record
        return {
          key: current.key,
          tenantId,
          configRevision: current.configRevision,
          env,
          context,
          release() {
            if (released) return
            released = true
            current.leases = Math.max(0, current.leases - 1)
            current.lastReleasedAt = Date.now()
            if (current.leases === 0 && (current.state === 'draining' || admissionClosed)) void disposeRecord(current)
            else if (current.leases === 0 && current.state === 'active' && waiters.length > 0) {
              // An idle env is worth more to a waiting acquirer than to a cache: when
              // closing it is what lets the next eligible waiter proceed, hand it over.
              const free = settings.capacity - capacityUsed()
              if (!waiterServable(free) && waiterServable(free + 1)) {
                evictions += 1
                void disposeRecord(current)
              }
            }
          },
        }
      }
    }

    const acquire = async (tenantId: string, purpose: LeasePurpose): Promise<SiteLease> => {
      inFlightAcquires += 1
      try { return await acquireWithin(tenantId, purpose) }
      finally { inFlightAcquires -= 1 }
    }

    /** Closes idle Envs past their TTL (and any leaseless draining Env) concurrently. Never rejects. */
    const sweep = async (): Promise<number> => {
      const now = Date.now()
      const closing: Promise<void>[] = []
      let evicted = 0
      for (const record of liveRecords()) {
        if (record.leases !== 0) continue
        if (record.state === 'draining') {
          // Defensive: a draining record with no lease is closed regardless of age.
          closing.push(disposeRecord(record))
          continue
        }
        if (record.state !== 'active') continue
        if (now - record.lastReleasedAt >= settings.idleTtlMs) {
          evictions += 1
          evicted += 1
          closing.push(disposeRecord(record))
        }
      }
      await Promise.all(closing)
      return evicted
    }

    const sweeper = setInterval(() => { void sweep() }, settings.sweepIntervalMs)
    sweeper.unref()

    /**
     * Runs once, whoever asks and however the admission was closed: the owner's
     * stop signal only refuses new acquires, it never means the manager has
     * already been wound down. Every caller awaits the same run.
     */
    const shutdown = (): Promise<{ readonly unreleasedLeases: readonly string[] }> => {
      shutdownPromise ??= (async () => {
        admissionClosed = true
        clearInterval(sweeper)
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer)
          waiter.reject(new SiteManagerClosedError())
        }
        // In-flight acquirers stop waiting here, wherever they are waiting: the
        // store round-trips and the site creations they were joined to are not
        // cancelled and are not waited for either. A creation that is still running
        // owns its Env and closes it when it finds the manager closed.
        for (const cancel of [...configWaiters]) cancel(new SiteManagerClosedError())
        for (const cancel of [...creationWaiters]) cancel(new SiteManagerClosedError())
        const deadline = Date.now() + settings.shutdownTimeoutMs
        while (liveRecords().some(record => record.leases > 0) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const unreleased = liveRecords().filter(record => record.leases > 0).map(record => `${record.key}#${record.leases}`)
        await Promise.all(liveRecords().map(record => disposeRecord(record)))
        return { unreleasedLeases: unreleased }
      })()
      return shutdownPromise
    }

    signal.addEventListener('abort', () => { admissionClosed = true }, { once: true })
    onDispose(async () => { await shutdown() })

    return {
      settings,
      acquire,
      invalidate(tenantId) {
        generations.set(tenantId, (generations.get(tenantId) ?? 0) + 1)
        for (const record of liveRecords()) {
          if (record.tenantId !== tenantId || record.state === 'draining' || record.state === 'disposing') continue
          record.state = 'draining'
          settle(record)
        }
      },
      sweep,
      records: () => liveRecords().map(record => ({
        key: record.key,
        tenantId: record.tenantId,
        configRevision: record.configRevision,
        state: record.state,
        leases: record.leases,
        idleForMs: record.leases === 0 ? Date.now() - record.lastReleasedAt : undefined,
      })),
      stats: () => {
        const live = liveRecords()
        return {
          capacity: settings.capacity,
          reservedForRequests: settings.reservedForRequests,
          records: live.length,
          active: live.filter(record => record.state === 'active' && record.leases > 0).length,
          idle: live.filter(record => record.state === 'active' && record.leases === 0).length,
          creating: live.filter(record => record.state === 'creating').length,
          draining: live.filter(record => record.state === 'draining').length,
          disposing: live.filter(record => record.state === 'disposing').length,
          leases: live.reduce((sum, record) => sum + record.leases, 0),
          pendingAcquires: waiters.length,
          waitingByPurpose: {
            request: waiters.filter(waiter => waiter.purpose === 'request').length,
            build: waiters.filter(waiter => waiter.purpose === 'build').length,
            background: waiters.filter(waiter => waiter.purpose === 'background').length,
          },
          inFlightConfigReads: configReads.size,
          inFlightAcquires,
          evictions,
          creations,
          creationFailures,
          disposalFailures,
          rejectedForCapacity,
          closed: admissionClosed,
        }
      },
      shutdown,
    }
  },
})
