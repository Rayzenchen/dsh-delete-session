/**
 * Tests the Client half's ghost suppression without a browser.
 *
 * `client.js` is a `window.__ModuleLoader__` bundle, so this loads it behind a
 * minimal facade: a React stub (the logic under test uses no hooks), a scripted
 * fetch, a fake `sessions` service, a fake connection store and an in-memory
 * localStorage. Timers are replaced by a deterministic clock, so the resync
 * backoff is verified instantly instead of by waiting.
 *
 * Scenarios:
 *   1. the original behaviours: fetch on load, hide what the list brings back
 *   2. a new connection generation + a full list pull → hidden, main panel closed
 *   3. four failed resyncs then a success → the row still ends up hidden
 *   4. Host unreachable for good, but localStorage still has the id → hidden at once
 *   5. a stored id that is not in the list → no error, other rows untouched
 *   6. a superseded instance's disposer must not disarm the live instance
 *
 *   node tools/verify-client-ghosts.mjs
 */
import { readFileSync } from 'node:fs'

let failures = 0
function check(ok, label) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}

/* ---------------- browser facade (installed before the bundle is imported) ---------------- */

const registered = []
globalThis.window = { __ModuleLoader__: { load: (definition) => registered.push(definition) } }
globalThis.document = { documentElement: { getAttribute: () => 'zh' } }

const ReactStub = {
  createElement: (...args) => ({ args }),
  Fragment: 'fragment',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: (callback) => callback,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return ReactStub
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`unexpected require: ${specifier}`)
}

await import('../client.js')
check(registered.length === 1 && registered[0].id === '@local/dsh-delete-session', 'the bundle registers the plugin id')

const bundle = registered[0]
const makeApi = () => bundle.factory(requireStub)

/* ---------------- harness ---------------- */

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const flushTasks = () => new Promise((resolve) => realSetTimeout(resolve, 0))

// The plugin logs every failed resync; keep the report readable and count them instead.
const pluginWarnings = []
const realWarn = console.warn
console.warn = (...args) => pluginWarnings.push(args)

/** Deterministic timer queue so the backoff ladder can be asserted without waiting. */
function useClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  globalThis.setTimeout = (fn, delay = 0) => {
    const id = ++seq
    timers.set(id, { fn, at: now + Math.max(0, delay) })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }
  return {
    get now() {
      return now
    },
    pending: () => timers.size,
    /** Run every timer due within `ms`, in due order, flushing microtasks between. */
    async advance(ms) {
      const target = now + ms
      for (;;) {
        let pick = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (pick === null || timer.at < timers.get(pick).at) pick = id
        }
        if (pick === null) break
        const timer = timers.get(pick)
        timers.delete(pick)
        now = timer.at
        timer.fn()
        await flushTasks()
      }
      now = target
      await flushTasks()
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

function makeStorage(pairs = {}) {
  const map = new Map(Object.entries(pairs))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
    raw: map,
  }
}

/** Scripted Host endpoint: `failures` rejections first, then `ghosts`. */
function installFetch({ ghosts = [], failures = 0 } = {}) {
  const calls = []
  let remaining = failures
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (remaining > 0) {
      remaining -= 1
      throw new Error('network down')
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ghosts }) }
  }
  return calls
}

function makeSessions() {
  const state = { snapshot: { byId: {} }, subscribers: [], removed: [] }
  return {
    state,
    log: state.removed,
    list: {
      getSnapshot: () => state.snapshot,
      subscribe: (listener) => {
        state.subscribers.push(listener)
        return () => {}
      },
    },
    handleSessionRemoved: (sessionId) => state.removed.push(sessionId),
  }
}

/**
 * A `sessions` service whose removal does NOT take effect (the client downgrades a
 * durable subagent's removal to a status change) and whose store is marked dirty on
 * a MICROTASK — exactly what `markDirty()` does. Bounded so a runaway chain cannot
 * hang this test process.
 */
function makeStuckRowSessions({ cap = 50 } = {}) {
  const state = { snapshot: { byId: {} }, subscribers: [], removed: 0, notified: 0 }
  let scheduled = false
  const notify = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      state.notified += 1
      if (state.notified > cap) return
      for (const listener of [...state.subscribers]) listener()
    })
  }
  return {
    state,
    list: {
      getSnapshot: () => state.snapshot,
      subscribe: (listener) => {
        state.subscribers.push(listener)
        return () => {}
      },
    },
    handleSessionRemoved: () => {
      state.removed += 1
      notify()
    },
  }
}

function makeGeneration() {
  let value
  const listeners = new Set()
  return {
    store: {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    publish(next) {
      if (Object.is(value, next)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function makeWorkspace() {
  return {
    mainReference: undefined,
    cleared: 0,
    clearMain() {
      this.cleared += 1
      this.mainReference = undefined
    },
  }
}

/** One plugin install against one page context. */
function install({ sessions, workspace = makeWorkspace(), generation, remote } = {}) {
  const effects = []
  const ctx = {
    effect: (callback, label) => {
      effects.push({ label, dispose: callback() })
    },
    get: (key) => {
      if (key === 'sessions') return sessions
      if (key === 'uiWorkspace') return workspace
      if (key === 'connection') return generation === undefined ? undefined : { generation: generation.store }
      if (key === 'remote') return remote
      return undefined
    },
  }
  const api = makeApi()
  api.apply({
    ...ctx,
    slots: { inject: () => {}, register: () => {} },
    contextMenus: { register: () => () => {} },
  })
  return { ctx, effects, workspace }
}

const showRows = (sessions, ids) => {
  sessions.state.snapshot = { byId: Object.fromEntries(ids.map((id) => [id, { sessionId: id }])) }
  for (const listener of [...sessions.state.subscribers]) listener()
}

/* ================================================================ *
 * Scenario 1 — the original behaviours
 * ================================================================ */

console.log('--- scenario 1: load + list re-add ---')
{
  const clock = useClock()
  const sessions = makeSessions()
  const calls = installFetch({ ghosts: ['ghost-from-host'] })
  globalThis.localStorage = makeStorage()
  install({ sessions })
  await flushTasks()

  check(calls.length === 1 && calls[0].body.op === 'ghosts', 'asks the Host for deleted-session ids on load')
  check(calls[0].url === '/plugins/dsh-delete-session/delete', `uses the plugin route (${calls[0].url})`)
  check(typeof calls[0].body.client === 'string', `names its own revision in the request (${calls[0].body.client})`)
  check(sessions.state.subscribers.length >= 1, 'subscribes to the session list store')

  showRows(sessions, ['ghost-from-host', 'healthy-session'])
  check(sessions.log.length === 1 && sessions.log[0] === 'ghost-from-host',
    `hides the ghost the list brought back (${sessions.log.join(',') || 'nothing'})`)
  check(!sessions.log.includes('healthy-session'), 'leaves every healthy row alone')

  sessions.log.length = 0
  showRows(sessions, ['ghost-from-host', 'healthy-session'])
  check(sessions.log.length === 1, 'a re-entrant notification suppresses once, not in a loop')

  sessions.log.length = 0
  showRows(sessions, ['healthy-session'])
  check(sessions.log.length === 0, 'does nothing once the ghost is out of the list')

  // Another window's deletion, through the forwarded notice.
  const informed = makeSessions()
  const remoteListeners = []
  install({
    sessions: informed,
    remote: { $on: (event, listener) => { remoteListeners.push({ event, listener }); return () => {} } },
  })
  const notice = remoteListeners.find((entry) => entry.event === 'api-session/removed')
  check(notice !== undefined, 'subscribes to forwarded session removals')
  notice.listener('ghost-from-window-b')
  showRows(informed, ['ghost-from-window-b'])
  check(informed.log.length === 1 && informed.log[0] === 'ghost-from-window-b',
    `hides a session another window deleted (${informed.log.join(',') || 'nothing'})`)
  clock.restore()
}

/* ================================================================ *
 * Scenario 2 — a new connection generation must resync
 * ================================================================ */

console.log('--- scenario 2: connection generation + full list pull ---')
{
  const clock = useClock()
  const sessions = makeSessions()
  const generation = makeGeneration()
  const workspace = makeWorkspace()
  const calls = installFetch({ ghosts: ['ghost-after-wake'] })
  globalThis.localStorage = makeStorage()
  install({ sessions, workspace, generation })
  await flushTasks()

  // Sleeping and waking: the connection drops (undefined) and a new one is ready.
  generation.publish(undefined)
  generation.publish({ id: 2 })
  await flushTasks()
  check(calls.length === 2, `a new generation re-reads the ghost list (${calls.length} reads)`)

  // The reconnect's full list pull puts the row back.
  workspace.mainReference = { sessionId: 'ghost-after-wake' }
  showRows(sessions, ['ghost-after-wake', 'healthy-session'])
  check(sessions.log.includes('ghost-after-wake'), 'the row the reconnect brought back is hidden again')
  check(workspace.cleared === 1, 'the open conversation of a deleted Session is closed')
  check(!sessions.log.includes('healthy-session'), 'other rows are untouched')
  clock.restore()
}

/* ================================================================ *
 * Scenario 3 — the resync must not give up after a fixed number of tries
 * ================================================================ */

console.log('--- scenario 3: four failures then success ---')
{
  const clock = useClock()
  const sessions = makeSessions()
  const calls = installFetch({ ghosts: ['ghost-late'], failures: 4 })
  globalThis.localStorage = makeStorage()
  install({ sessions })
  await flushTasks()
  check(calls.length === 1, 'first attempt happens at once')

  await clock.advance(1000)
  check(calls.length === 2, 'retries after 1s')
  await clock.advance(2000)
  check(calls.length === 3, 'retries after 2s more')
  await clock.advance(4000)
  check(calls.length === 4, 'retries after 4s more')
  await clock.advance(8000)
  check(calls.length === 5, 'a fifth attempt is made (the old code stopped at four)')

  sessions.log.length = 0
  showRows(sessions, ['ghost-late', 'healthy-session'])
  check(sessions.log.length === 1 && sessions.log[0] === 'ghost-late', 'the late answer still hides the row')
  clock.restore()
}

/* ================================================================ *
 * Scenario 4 — a stored id survives a reload with the Host unreachable
 * ================================================================ */

console.log('--- scenario 4: persisted ids without the Host ---')
{
  const clock = useClock()
  const sessions = makeSessions()
  const workspace = makeWorkspace()
  // A renderer reload: new module instance, Host still not reachable.
  installFetch({ ghosts: [], failures: 99 })
  globalThis.localStorage = makeStorage({
    'dsh.delete-session.ghosts.v1': JSON.stringify({ v: 1, ids: ['ghost-persisted'] }),
  })
  install({ sessions, workspace })
  await flushTasks()

  workspace.mainReference = { sessionId: 'ghost-persisted' }
  showRows(sessions, ['ghost-persisted'])
  check(sessions.log.includes('ghost-persisted'), 'a persisted id is hidden even though the Host never answered')
  check(workspace.cleared === 1, 'and its open conversation is closed')

  // The ladder keeps climbing instead of dying at the old ~9s cap.
  const before = clock.pending()
  await clock.advance(30000)
  check(before > 0 || clock.pending() > 0, 'the retry timer stays armed for later generations')
  clock.restore()
}

/* ================================================================ *
 * Scenario 5 — a stored id that is not in the list is harmless
 * ================================================================ */

console.log('--- scenario 5: stored id absent from the list ---')
{
  const clock = useClock()
  const sessions = makeSessions()
  installFetch({ ghosts: [] })
  globalThis.localStorage = makeStorage({
    'dsh.delete-session.ghosts.v1': JSON.stringify({ v: 1, ids: ['ghost-gone-for-good', 'ghost-also-stale'] }),
  })
  install({ sessions })
  await flushTasks()
  showRows(sessions, ['healthy-a', 'healthy-b'])
  check(sessions.log.length === 0, 'nothing is removed when the stored id is not listed')
  const stored = JSON.parse(globalThis.localStorage.getItem('dsh.delete-session.ghosts.v1'))
  check(Array.isArray(stored?.ids) && stored.v === 1, 'the ledger is persisted under its versioned key')
  check(stored.ids.length <= 200, 'the stored list stays bounded')
  clock.restore()
}

/* ================================================================ *
 * Scenario 6 — a superseded instance's disposer must not disarm the live one
 * ================================================================ */

console.log('--- scenario 6: re-apply and a late disposer ---')
{
  const clock = useClock()
  const first = makeSessions()
  const calls = installFetch({ ghosts: ['ghost-after-reapply'] })
  globalThis.localStorage = makeStorage()
  const instanceA = install({ sessions: first })
  await flushTasks()

  // The plugin is re-applied: same module, new context; the old disposer runs late.
  const second = makeSessions()
  install({ sessions: second })
  await flushTasks()
  for (const effect of instanceA.effects) if (typeof effect.dispose === 'function') effect.dispose()

  showRows(second, ['ghost-after-reapply'])
  check(second.log.includes('ghost-after-reapply'), 'a stale disposer does not disarm the live instance')
  check(calls.length >= 2, `the re-applied instance resynced with the Host (${calls.length} reads)`)
  clock.restore()
}

/* ================================================================ *
 * Scenario 7 — a row that refuses to disappear must not spin the renderer
 * ================================================================ */

console.log('--- scenario 7: stuck row stays bounded ---')
{
  const clock = useClock()
  const sessions = makeStuckRowSessions()
  sessions.state.snapshot = { byId: { 'ghost-stuck': { sessionId: 'ghost-stuck' } } }
  installFetch({ ghosts: ['ghost-stuck'] })
  globalThis.localStorage = makeStorage()
  install({ sessions })
  await flushTasks()
  await flushTasks()

  check(sessions.state.removed <= 3,
    `a row that never disappears is asked at most 3 times (asked ${sessions.state.removed})`)
  check(sessions.state.notified < 50,
    `the notification chain terminates instead of feeding itself (${sessions.state.notified} notifications)`)
  clock.restore()
}

/* ---------------- regression guard: the bundle did not grow a dependency on the harness ---------------- */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check(!/require\(['"]@deepseek-ai\//.test(source), 'the client half still imports no Harness Client package')

console.warn = realWarn
console.log(`\n(${pluginWarnings.length} plugin warnings captured)`)
console.log(failures === 0 ? 'ALL CLIENT GHOST CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
