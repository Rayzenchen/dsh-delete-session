/**
 * Renders the Client half's menu row and confirmation dialog for real
 * (React 18 + react-dom + jsdom, from this package's optional dev dependencies)
 * and asserts the behaviour that used to be checked only by hand:
 *
 *   - refusal code → the UI language's copy; unknown codes fall back to the Host text
 *   - role="alertdialog" with aria-labelledby / aria-describedby pointing at real nodes
 *   - Tab is trapped inside the dialog; closing hands focus back to the menu trigger
 *   - a `500 partial` drops the rows of the descendants that were already deleted
 *
 * Prints SKIP and exits 0 when those dependencies are absent, so a plain clone
 * without `npm install` never reports a failure.
 *
 *   node tools/verify-client-dialog.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const localRequire = createRequire(import.meta.url)

let failures = 0
function check(ok, label) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures++
}

/* ---------------- dependencies ---------------- */

/**
 * Resolve React 18 and jsdom, in this order:
 *
 *   1. this package's own `node_modules` (after `npm install` / `pnpm install`);
 *   2. `DSH_PNPM_DIR` — a pnpm store such as `<checkout>/node_modules/.pnpm`;
 *   3. `DSH_CHECKOUT` — a DSH source checkout whose store is appended.
 *
 * Returning null (instead of throwing) lets a machine without these optional
 * dev dependencies report SKIP, so the suite never fails a stranger's clone.
 */
function fromLocalModules() {
  try {
    const React = localRequire('react')
    const ReactDOM = localRequire('react-dom')
    const ReactDOMClient = localRequire('react-dom/client')
    const { JSDOM } = localRequire('jsdom')
    return { React, ReactDOM, ReactDOMClient, JSDOM }
  } catch {
    return null
  }
}

function fromPnpmStore(store) {
  if (typeof store !== 'string' || store.length === 0 || !existsSync(store)) return null
  let names
  try {
    names = readdirSync(store)
  } catch {
    return null
  }
  const reactDomDir = names.find((name) => name.startsWith('react-dom@18'))
  const jsdomDir = names.find((name) => name.startsWith('jsdom@'))
  if (reactDomDir === undefined || jsdomDir === undefined) return null
  try {
    // pnpm puts react next to react-dom, so resolve both from react-dom's own package.
    const fromReactDom = createRequire(join(store, reactDomDir, 'node_modules/react-dom/package.json'))
    const fromJsdom = createRequire(join(store, jsdomDir, 'node_modules/jsdom/package.json'))
    return {
      React: fromReactDom('react'),
      ReactDOM: fromReactDom('react-dom'),
      ReactDOMClient: fromReactDom('react-dom/client'),
      JSDOM: fromJsdom('jsdom').JSDOM,
    }
  } catch {
    return null
  }
}

function loadDeps() {
  const local = fromLocalModules()
  if (local !== null) return local
  const explicitStore = process.env.DSH_PNPM_DIR
  const fromExplicit = fromPnpmStore(explicitStore)
  if (fromExplicit !== null) return fromExplicit
  const checkout = process.env.DSH_CHECKOUT
  if (typeof checkout === 'string' && checkout.length > 0) {
    const fromCheckout = fromPnpmStore(join(checkout, 'node_modules', '.pnpm'))
    if (fromCheckout !== null) return fromCheckout
  }
  return null
}

const deps = loadDeps()
if (deps === null) {
  console.log('SKIP  react-dom@18 / jsdom not found, so the Client half cannot be rendered for real.')
  console.log('      Install the optional dev dependencies:  npm install')
  console.log('      Or point at a DSH checkout:             DSH_PNPM_DIR=/path/to/checkout/node_modules/.pnpm node tools/verify-client-dialog.mjs')
  process.exit(0)
}

const { React, ReactDOM, ReactDOMClient, JSDOM } = deps
const reactMajor = Number.parseInt(String(React.version ?? '0').split('.')[0], 10)
if (!(reactMajor >= 18)) {
  console.log(`SKIP  react ${React.version} found, but this suite renders against React 18 semantics.`)
  process.exit(0)
}
const act = React.act ?? React.unstable_act
const h = React.createElement

/* ---------------- browser facade ---------------- */

const dom = new JSDOM('<!doctype html><html lang="zh"><body></body></html>', { pretendToBeVisual: true })
const { window: win } = dom
const doc = win.document
const registered = []
globalThis.window = win
win.__ModuleLoader__ = { load: (definition) => registered.push(definition) }
globalThis.document = doc
globalThis.HTMLElement = win.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const requests = []
const queued = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ url, body })
  if (body.op === 'ghosts') return { ok: true, status: 200, json: async () => ({ ok: true, ghosts: [] }) }
  const next = queued.shift()
  if (next === undefined) throw new Error('no queued response for a delete request')
  if (typeof next === 'function') return next()
  return {
    ok: next.status < 400,
    status: next.status,
    json: async () => {
      if (next.body === undefined) throw new SyntaxError('no JSON')
      return next.body
    },
  }
}

const removed = []
let clearedMain = 0
const components = {}
const contributions = []
const disposers = []
const ctx = {
  effect: (run) => {
    const off = run()
    if (typeof off === 'function') disposers.push(off)
  },
  get: (key) => {
    if (key === 'sessions') {
      return {
        list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
        handleSessionRemoved: (id) => removed.push(id),
      }
    }
    if (key === 'uiWorkspace') return { mainReference: { sessionId: 's-main' }, clearMain: () => { clearedMain++ } }
    if (key === 'remote') return { $on: () => () => {} }
    return undefined
  },
  slots: {
    inject: (_name, register) => register(),
    register: (meta, component) => {
      components[meta.id ?? meta.key] = component
      return () => {}
    },
  },
  contextMenus: {
    register: (contribution) => {
      contributions.push(contribution)
      return () => {}
    },
  },
}

/* ---------------- load and mount the real client half ---------------- */

await import('../client.js')
const api = registered[0].factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return ReactDOM
  throw new Error(`unexpected require: ${specifier}`)
})
api.apply(ctx)
check(typeof components['delete-session-confirm'] === 'function', 'registers the overlay dialog')
check(typeof components['delete-session.trash'] === 'function', 'registers the menu action glyph')
check(contributions.length === 1 && contributions[0].target === 'session' && contributions[0].order === 700,
  'registers one Session menu contribution ordered after Archive (600)')

const trigger = doc.createElement('button')
trigger.setAttribute('aria-expanded', 'true')
trigger.setAttribute('aria-haspopup', 'menu')
trigger.textContent = '…'
doc.body.appendChild(trigger)

const menuActions = contributions[0].resolve({ sessionId: 's-main', displayTitle: '我的会话', kind: 'session' })
const overlayHost = doc.createElement('div')
doc.body.append(overlayHost)
const overlayRoot = ReactDOMClient.createRoot(overlayHost)
await act(async () => {
  overlayRoot.render(h(components['delete-session-confirm']))
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const dialog = () => doc.querySelector('[role="alertdialog"]')
const alertText = () => doc.querySelector('.dsh-del-error')?.textContent ?? null
const buttons = () => [...dialog().querySelectorAll('button')]
const confirmButton = () => dialog().querySelector('.dsh-del-danger')
const cancelButton = () => dialog().querySelector('.dsh-del-outline')
async function click(node) {
  await act(async () => {
    node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await tick()
  })
}
async function key(name, shiftKey = false) {
  const event = new win.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
  await act(async () => {
    (doc.activeElement ?? doc.body).dispatchEvent(event)
  })
  return event
}
async function openDialog() {
  trigger.focus()
  await act(async () => {
    menuActions[0].run()
    await tick()
  })
}

/* ---------------- menu action ---------------- */

check(menuActions.length === 1 && menuActions[0].label === '删除会话',
  'the menu action carries the page language label')
check(menuActions[0].danger === true && menuActions[0].separatorBefore === true,
  'the action is marked dangerous and separated from the rows above it')

/* ---------------- a11y wiring ---------------- */

await openDialog()
const box = dialog()
check(box !== null, 'choosing the row opens the confirmation dialog')
check(box?.getAttribute('aria-modal') === 'true', 'the dialog is aria-modal')
const labelled = box && doc.getElementById(box.getAttribute('aria-labelledby'))
check(labelled?.tagName === 'H2' && labelled.textContent === '删除会话', 'aria-labelledby points at the dialog title')
const describedIds = (box?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
const described = describedIds.map((id) => doc.getElementById(id))
check(described.length === 2 && described.every((node) => node !== null && box.contains(node)),
  'aria-describedby names two nodes inside the dialog')
check(described[0]?.textContent.includes('我的会话') && described[1]?.textContent.includes('不可撤销'),
  'the description covers the session title and the "cannot be undone" warning')

/* ---------------- focus trap and focus return ---------------- */

check(doc.activeElement === cancelButton(), 'focus starts on Cancel')
const [first, , last] = buttons()
last.focus()
const forward = await key('Tab')
check(forward.defaultPrevented && doc.activeElement === first, 'Tab on the last control wraps to the first')
const backward = await key('Tab', true)
check(backward.defaultPrevented && doc.activeElement === last, 'Shift+Tab on the first control wraps to the last')
trigger.focus()
const stray = await key('Tab')
check(stray.defaultPrevented && dialog().contains(doc.activeElement), 'Tab from outside the dialog is pulled back inside')
await key('Escape')
check(dialog() === null, 'Escape closes the dialog')
check(doc.activeElement === trigger, 'closing hands focus back to the menu trigger')

/* ---------------- refusal codes → UI copy ---------------- */

await openDialog()
queued.push({ status: 409, body: { ok: false, code: 'active', message: 'HOST-TEXT' } })
await click(confirmButton())
const deleteCall = requests.filter((request) => request.body.op !== 'ghosts').at(-1)
check(deleteCall?.body.sessionId === 's-main' && deleteCall.body.confirm === true && deleteCall.body.stopActivity === false,
  'the first attempt asks the Host without stopping work')
check(alertText() === '该会话仍有正在进行的任务，可选择「停止任务并删除」。', `a known code shows the zh copy, not the Host text (${alertText()})`)
check(confirmButton().textContent === '停止任务并删除', 'an "active" refusal offers "stop work and delete"')

queued.push({ status: 503, body: { ok: false, code: 'check-failed', message: 'HOST-TEXT' } })
await click(confirmButton())
check(requests.filter((request) => request.body.op !== 'ghosts').at(-1)?.body.stopActivity === true,
  'the retry asks the Host to stop the work')
check(confirmButton().textContent === '删除', 'a non-activity refusal drops the stop offer again')
await click(cancelButton())

doc.documentElement.setAttribute('lang', 'en')
await openDialog()
queued.push({ status: 409, body: { ok: false, code: 'descendant-running', message: 'HOST-TEXT' } })
await click(confirmButton())
check(alertText() === 'A subagent of this session is still running. You can stop it and delete.',
  `the same refusal speaks English when the page does (${alertText()})`)
queued.push({ status: 400, body: { ok: false, code: 'something-new', message: '宿主原文' } })
await click(confirmButton())
check(alertText() === '宿主原文', 'an unknown code falls back to the Host text')
queued.push({ status: 502 })
await click(confirmButton())
check(alertText() === 'Delete failed (HTTP 502)', 'no JSON at all falls back to the HTTP status')
await click(cancelButton())
doc.documentElement.setAttribute('lang', 'zh')

/* ---------------- busy state ---------------- */

await openDialog()
let release
queued.push(() => new Promise((resolve) => {
  release = () => resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: 'busy', message: 'x' }) })
}))
await click(confirmButton())
check(dialog().getAttribute('aria-busy') === 'true' && buttons().every((button) => button.disabled),
  'while the request runs the dialog is aria-busy and every button is disabled')
await key('Escape')
check(dialog() !== null, 'Escape does not close the dialog mid-request')
await act(async () => {
  release()
  await tick()
})
check(dialog().getAttribute('aria-busy') === 'false', 'the busy state clears once the Host answers')
await click(cancelButton())

/* ---------------- partial failure ---------------- */

await openDialog()
removed.length = 0
queued.push({
  status: 500,
  body: { ok: false, code: 'partial', message: 'HOST-TEXT', deletedIds: ['child-1'], failed: [{ id: 's-main', code: 'EACCES' }] },
})
await click(confirmButton())
check(removed.includes('child-1'), `a partial failure drops the descendant rows already deleted (${removed.join(',') || 'nothing'})`)
check(!removed.includes('s-main'), 'a partial failure keeps the session row itself')
check(dialog() !== null && alertText() === '删除未完成：会话目录无法完全移除，会话已保留，请稍后重试。',
  'a partial failure keeps the dialog open with the zh explanation')

/* ---------------- success ---------------- */

removed.length = 0
const ghostReadsBefore = requests.filter((request) => request.body.op === 'ghosts').length
queued.push({ status: 200, body: { ok: true, deletedIds: ['child-2', 's-main'], freedBytes: 10 } })
await click(confirmButton())
check(dialog() === null, 'success closes the dialog')
check(removed.includes('s-main') && removed.includes('child-2'), `success drops the session and its deleted descendants (${removed.join(',')})`)
check(clearedMain === 1, 'success closes the conversation that was open on screen')
check(requests.filter((request) => request.body.op === 'ghosts').length === ghostReadsBefore + 1,
  'success re-reads the Host ghost list')

/* ---------------- teardown ---------------- */

await act(async () => {
  overlayRoot.unmount()
})
for (const off of disposers) off()

console.log(failures === 0 ? '\nALL CLIENT DIALOG CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
