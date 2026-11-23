/**
 * Client half of `@local/dsh-delete-session`.
 *
 * Adds one row — "删除会话 / Delete session" — to the "…" menu of every Session
 * row in the sidebar (registered through the `contextMenus` service with
 * `order: 700`, so it sorts after the shipped Archive action), and one
 * confirmation dialog in `shell.overlay`.
 *
 * The dialog states plainly that the deletion is permanent, refuses to act when
 * the session still has work (offering the same "stop it and continue" hop the
 * shipped archive confirmation offers), and shows the Host's refusal reason
 * verbatim when the Host declines.
 *
 * This half imports no Harness Client package: only `react`/`react-dom` from the
 * platform module table. The menu row and the dialog copy the markup, spacing
 * and behaviour of the shipped primitives (MenuItemButton / Modal / Button) and
 * style themselves with `--dsw-alias-*` theme tokens under a `dsh-del-` prefix.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-delete-session',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const ENDPOINT = '/plugins/dsh-delete-session/delete'
    const OVERLAY_SLOT = 'shell.overlay'
    /**
     * Context-menu contribution metadata. `order: 700` sorts after the shipped
     * Archive action (600). The legacy `sidebar.workspaces.session.menu.item`
     * Slot cannot express that on 0.2.2: every legacy entry renders before
     * Archive and the Slot's `order` no longer positions built-in actions.
     */
    const MENU_TARGET = 'session'
    const MENU_ORDER = 700
    const MENU_ICON_KEY = 'delete-session.trash'
    /**
     * This half's version, sent with every Host request and stamped in the
     * diagnostics. Kept identical to `package.json` `version` and to the Host
     * half's `BUILD`: a mismatch between the two is how a page still running an
     * older bundle becomes visible instead of silent.
     */
    const CLIENT_BUILD = '1.0.0'
    /** Where the deleted-but-still-live ids survive a renderer reload or a long outage. */
    const GHOST_STORAGE_KEY = 'dsh.delete-session.ghosts.v1'
    const GHOST_STORAGE_VERSION = 1
    /** Cap on that list; ids are never reused, and older entries are harmless. */
    const GHOST_STORAGE_LIMIT = 200
    /** Backoff bounds for the ghost resync: a wake from sleep can outlast any fixed window. */
    const RETRY_MIN_MS = 1000
    const RETRY_MAX_MS = 30000
    /**
     * How many times one ghost row may be asked to disappear before this half stops
     * asking. The client downgrades a durable subagent's removal to a status change,
     * so such a row never leaves the list; retrying it forever is a renderer hang.
     */
    const SUPPRESS_ATTEMPT_LIMIT = 3

    /* ---------------------------------------------------------------- *
     * Copy
     * ---------------------------------------------------------------- */

    const COPY = {
      zh: {
        menu: '删除会话',
        title: '删除会话',
        body: (title) => `将永久删除会话「${title}」及其全部对话记录、子代理会话与缓存。`,
        hint: '此操作不可撤销，删除后无法恢复。',
        // The Host's refusal already names the work and the remedy; show it verbatim.
        active: (message) => message,
        cancel: '取消',
        confirm: '删除',
        stopAndConfirm: '停止任务并删除',
        busy: '正在删除…',
        failed: (status) => `删除失败（HTTP ${status}）`,
        codes: {
          active: '该会话仍有正在进行的任务，可选择「停止任务并删除」。',
          'descendant-running': '该会话的子代理仍在运行，可选择「停止任务并删除」。',
          busy: '该会话正在被删除，请稍候。',
          'check-failed': '暂时无法确认会话状态，已拒绝删除，请稍后再试。',
          partial: '删除未完成：会话目录无法完全移除，会话已保留，请稍后重试。',
          'not-found': '找不到该会话的存储目录。',
          'ambiguous-location': '找到了多个同名会话目录，已拒绝删除。',
          'outside-root': '会话目录不在会话根目录内，已拒绝删除。',
          forbidden: '请求未通过安全校验，已拒绝删除。',
          'invalid-session-id': '会话 id 不合法，已拒绝删除。',
          unconfirmed: '缺少删除确认，已拒绝删除。',
          'method-not-allowed': '请求方式不被接受，已拒绝删除。',
          'payload-too-large': '请求过大，已拒绝删除。',
          'invalid-json': '请求格式不正确，已拒绝删除。',
          internal: '删除失败（内部错误），详情见日志。',
        },
      },
      en: {
        menu: 'Delete session',
        title: 'Delete session',
        body: (title) => `This permanently deletes the session "${title}", including its transcript, subagent sessions and caches.`,
        hint: 'This cannot be undone.',
        active: (message) => message,
        cancel: 'Cancel',
        confirm: 'Delete',
        stopAndConfirm: 'Stop work and delete',
        busy: 'Deleting…',
        failed: (status) => `Delete failed (HTTP ${status})`,
        codes: {
          active: 'This session still has work in progress. You can stop it and delete.',
          'descendant-running': 'A subagent of this session is still running. You can stop it and delete.',
          busy: 'This session is already being deleted.',
          'check-failed': 'Could not confirm the session state, so nothing was deleted. Try again shortly.',
          partial: 'The delete did not finish: the session directory could not be fully removed, so the session was kept. Try again.',
          'not-found': 'The session storage could not be found.',
          'ambiguous-location': 'More than one directory matches this session, so nothing was deleted.',
          'outside-root': 'The session directory is outside the sessions root, so nothing was deleted.',
          forbidden: 'The request failed the security check, so nothing was deleted.',
          'invalid-session-id': 'The session id is not valid, so nothing was deleted.',
          unconfirmed: 'The delete was not confirmed, so nothing was deleted.',
          'method-not-allowed': 'The request method was not accepted, so nothing was deleted.',
          'payload-too-large': 'The request was too large, so nothing was deleted.',
          'invalid-json': 'The request was malformed, so nothing was deleted.',
          internal: 'Delete failed (internal error). See the log for details.',
        },
      },
    }

    function copy() {
      const raw = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase()
      return raw.startsWith('zh') ? COPY.zh : COPY.en
    }

    /* ---------------------------------------------------------------- *
     * Pending-request store (menu row → overlay dialog)
     * ---------------------------------------------------------------- */

    let pending = null
    const pendingListeners = new Set()

    function setPending(next) {
      pending = next
      for (const listener of [...pendingListeners]) listener()
    }

    function subscribePending(listener) {
      pendingListeners.add(listener)
      return () => {
        pendingListeners.delete(listener)
      }
    }

    function usePending() {
      return React.useSyncExternalStore(subscribePending, () => pending, () => null)
    }

    /**
     * Open the confirmation dialog for one Session row.
     *
     * Called from the context-menu action, which runs after the menu took the
     * click. The trigger is captured here — while the popup still marks its
     * opener `aria-expanded` — so the dialog can hand focus back on close.
     */
    function openDeleteConfirm(sessionId, displayTitle) {
      const trigger = document.querySelector('[aria-expanded="true"][aria-haspopup]')
        ?? document.querySelector(`[data-row-key="session:${sessionId}"]`)
      setPending({
        sessionId,
        displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
        returnFocus: trigger instanceof HTMLElement ? trigger : null,
      })
    }

    /**
     * Drop the deleted row from the sidebar's own Session snapshot.
     *
     * The Host also emits `api-session/removed`, which normally removes the row
     * by itself; this call keeps the page correct even if that notice is missed,
     * and both paths are idempotent (`recordMutation` filters the id out of the
     * summary list).
     */
    let dropRow = () => {}

    /**
     * Close the main panel when the session being deleted is the one on screen —
     * the same thing the shipped archive action does for the archive it performs.
     * Without it the open conversation would outlive its own session.
     */
    let closeOpenSession = () => {}

    /** Remember the ids just deleted so their rows stay hidden. */
    let rememberDeleted = () => {}

    /**
     * Ids the Host has deleted while the Session was still live.
     *
     * The Host cannot dispose a live Session (an Agent belongs to the app-lifetime
     * registry), and `sessionQuery.listSessions()` merges live Sessions with the
     * stored ones — so such a Session keeps coming back in every list refresh even
     * though its bytes are gone. The Host remembers those ids for its run; this
     * half keeps re-applying the removal whenever the list brings one back.
     *
     * The set is mirrored into localStorage and resynced on every connection
     * generation: a wake from sleep can reload the renderer or leave the Host
     * unreachable for far longer than any fixed retry window, and losing the set
     * inside that window is exactly what let a deleted Session reappear.
     */
    let ghosts = new Set()
    let ghostSuppressing = false
    /** id -> consecutive suppression passes in which the row refused to disappear. */
    const suppressAttempts = new Map()
    let retryTimer = null
    let retryDelay = RETRY_MIN_MS
    /**
     * Whether a Host/page version mismatch was already reported. Both halves stamp
     * the same version, so a mismatch means the page is running a stale bundle —
     * exactly the question that was unanswerable while only the Host had a build id.
     */
    let buildMismatchReported = false
    let disposed = false
    /** Bumped per install so a superseded instance's disposer cannot disarm the live one. */
    let installToken = 0
    /** The Client root context, captured in apply: the store subscriber receives no ctx. */
    let clientCtx = null

    /**
     * One greppable breadcrumb per meaningful step. The sleep/wake failure this
     * guards against is invisible from the Host's log (a request that never arrived
     * leaves no trace), so the page console is the only place that can show whether
     * an install, a resync and a suppression actually happened.
     */
    function logGhosts(event, detail) {
      try {
        console.info(`[dsh-del] ${event}`, Date.now(), `ghosts=${ghosts.size}`, detail ?? '')
      } catch {
        /* logging never breaks the plugin */
      }
    }

    /* ---------------- persisted ghost ids ---------------- */

    /** Read the persisted ids, oldest first. Never throws. */
    function loadStoredGhosts() {
      try {
        const raw = globalThis.localStorage?.getItem(GHOST_STORAGE_KEY)
        if (typeof raw !== 'string' || raw.length === 0) return []
        const parsed = JSON.parse(raw)
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : []
        return list.filter((id) => typeof id === 'string' && id.length > 0).slice(-GHOST_STORAGE_LIMIT)
      } catch {
        return []
      }
    }

    /**
     * Mirror the current set, oldest evicted first. The oldest-first cap IS the time
     * policy: ids are never reused, a Host restart makes them meaningless, and the
     * bound keeps the entry from growing without limit.
     */
    function storeGhosts() {
      try {
        globalThis.localStorage?.setItem(GHOST_STORAGE_KEY, JSON.stringify({
          v: GHOST_STORAGE_VERSION,
          ids: [...ghosts].slice(-GHOST_STORAGE_LIMIT),
        }))
      } catch {
        /* private mode or quota: suppression still works for this page */
      }
    }

    /** Add ids (never removing), persist, and suppress whatever is on screen. */
    function rememberGhosts(ids) {
      let changed = false
      for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || ghosts.has(id)) continue
        ghosts.add(id)
        changed = true
      }
      if (changed) storeGhosts()
      suppressGhostRows()
      return changed
    }

    /* ---------------- suppression ---------------- */

    /** Re-apply removal for every ghost the current list snapshot carries. */
    function suppressGhostRows() {
      if (ghostSuppressing || ghosts.size === 0 || clientCtx === null) return
      let service
      try {
        service = clientCtx.get('sessions')
      } catch {
        return
      }
      const byId = service?.list?.getSnapshot?.()?.byId
      if (byId === undefined || byId === null) return
      ghostSuppressing = true
      let hidden = 0
      try {
        for (const id of ghosts) {
          if (byId[id] === undefined) {
            // The row is gone: re-arm so a later reappearance is handled again.
            suppressAttempts.delete(id)
            continue
          }
          // The store notifies on a MICROTASK (`markDirty` -> schedule('microtask')),
          // so an id whose row does not actually disappear would re-enter this
          // function forever and spin the renderer at 100% CPU. A removal that does
          // not take effect within a few attempts is not going to: stop asking, and
          // let the Host-side filter be the authority for that row.
          const attempts = (suppressAttempts.get(id) ?? 0) + 1
          suppressAttempts.set(id, attempts)
          if (attempts > SUPPRESS_ATTEMPT_LIMIT) {
            if (attempts === SUPPRESS_ATTEMPT_LIMIT + 1) logGhosts('stuck-row', `id=${id}`)
            continue
          }
          try {
            service.handleSessionRemoved?.(id)
          } catch (error) {
            console.warn('delete-session: hiding a deleted session failed:', error)
          }
          // The open conversation must not outlive the Session it shows either.
          closeOpenSession(id)
          hidden += 1
        }
      } finally {
        ghostSuppressing = false
      }
      if (hidden > 0) logGhosts('suppressed', `rows=${hidden}`)
    }

    /* ---------------- resync ---------------- */

    /** Ask the Host which remembered deletions are still missing from disk. */
    async function syncGhosts() {
      if (disposed) return false
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-delete-session' },
          body: JSON.stringify({ op: 'ghosts', client: CLIENT_BUILD }),
        })
        const payload = await response.json()
        if (payload !== null && payload.ok === true && Array.isArray(payload.ghosts)) {
          retryDelay = RETRY_MIN_MS
          logGhosts('synced', `host=${payload.ghosts.length}`)
          if (typeof payload.build === 'string' && payload.build !== CLIENT_BUILD && !buildMismatchReported) {
            buildMismatchReported = true
            console.info(`[dsh-del] build-mismatch host=${payload.build} client=${CLIENT_BUILD}`)
          }
          // Merge, never replace: a read sent before a delete finished must not
          // drop the id `rememberGhosts` just added.
          rememberGhosts(payload.ghosts)
          return true
        }
        throw new Error(payload !== null && typeof payload.code === 'string' ? payload.code : `http-${response.status}`)
      } catch (error) {
        if (disposed) return false
        // Keep trying for as long as the page lives, doubling from RETRY_MIN_MS to
        // RETRY_MAX_MS. Giving up after a few seconds is what let a deleted Session
        // come back when the machine woke with a dead link.
        const delay = retryDelay
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
        console.warn('delete-session: reading deleted-session ids failed:', error)
        logGhosts('sync-failed', `retry=${delay}ms`)
        scheduleGhostSync(delay)
        return false
      }
    }

    /** (Re)arm the single resync timer; an already pending timer is replaced. */
    function scheduleGhostSync(delayMs) {
      if (disposed) return
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null
        void syncGhosts()
      }, Math.max(0, delayMs))
    }

    /** A new connection generation is the moment the Host is reachable again. */
    function syncGhostsNow() {
      if (disposed) return
      retryDelay = RETRY_MIN_MS
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      void syncGhosts()
    }

    /** Settle the page after a confirmed deletion: clear the view, then drop the row. */
    function installSessionCleanup(ctx) {
      // A re-applied plugin (renderer reload, HMR) takes over the module state; any
      // disposer still held by the previous instance must not disarm this one.
      const token = ++installToken
      disposed = false
      buildMismatchReported = false
      clientCtx = ctx
      // The persisted ids come first: even if the Host stays unreachable for hours
      // after a wake, the rows are already known and get suppressed on the next
      // list change.
      ghosts = new Set(loadStoredGhosts())
      dropRow = (sessionId) => {
        try {
          ctx.get('sessions')?.handleSessionRemoved?.(sessionId)
        } catch (error) {
          console.warn('delete-session: dropping the row failed:', error)
        }
      }
      closeOpenSession = (sessionId) => {
        try {
          const workspace = ctx.get('uiWorkspace')
          if (workspace?.mainReference?.sessionId === sessionId) workspace.clearMain()
        } catch (error) {
          console.warn('delete-session: closing the open session failed:', error)
        }
      }
      rememberDeleted = (...ids) => {
        rememberGhosts(ids)
      }
      // Every list refresh (reconnect, page load, host push) re-adds live ghosts;
      // the subscription puts them back out of sight immediately.
      try {
        const store = clientCtx.get('sessions')?.list
        if (typeof store?.subscribe === 'function') {
          ctx.effect(() => store.subscribe(suppressGhostRows), 'delete-session: ghost suppression')
        }
      } catch (error) {
        console.warn('delete-session: watching the session list failed:', error)
      }
      // `api-session/removed` carries deletions made in any window, so this half
      // learns about them even when it did not perform the request.
      try {
        const remote = clientCtx.get('remote')
        if (typeof remote?.$on === 'function') {
          ctx.effect(() => remote.$on('api-session/removed', (sessionId) => {
            if (typeof sessionId === 'string' && sessionId.length > 0) rememberDeleted(sessionId)
          }), 'delete-session: removal notices')
        }
      } catch (error) {
        console.warn('delete-session: subscribing to removal notices failed:', error)
      }
      // A wake from sleep ends one connection generation and starts another; the
      // reconnect is followed by a full list pull, so this is the moment the ghost
      // list must be re-read rather than trusted to a fixed retry window.
      try {
        const generation = clientCtx.get('connection')?.generation
        if (generation !== undefined && typeof generation?.subscribe === 'function') {
          let seen = generation.getSnapshot?.()
          ctx.effect(() => generation.subscribe(() => {
            const current = generation.getSnapshot?.()
            if (current === undefined || current === seen) return
            seen = current
            logGhosts('generation', `id=${current?.id ?? '?'}`)
            // Hide with what is already known BEFORE the async read: the reconnect's
            // full list pull can land while the read is still in flight.
            suppressGhostRows()
            syncGhostsNow()
          }), 'delete-session: connection generation')
        }
      } catch (error) {
        console.warn('delete-session: watching the connection generation failed:', error)
      }
      ctx.effect(() => () => {
        if (installToken !== token) return
        disposed = true
        installToken += 1
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        // A fetch still in flight at unload must not act on a disposed context.
        clientCtx = null
        dropRow = () => {}
        closeOpenSession = () => {}
        rememberDeleted = () => {}
        setPending(null)
      }, 'delete-session: timers')
      logGhosts('install', `client=${CLIENT_BUILD} stored=${ghosts.size}`)
      suppressGhostRows()
      void syncGhosts()
    }

    /* ---------------------------------------------------------------- *
     * Host call
     * ---------------------------------------------------------------- */

    async function callDelete(sessionId, stopActivity) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-plugin': 'dsh-delete-session',
        },
        body: JSON.stringify({ sessionId, confirm: true, stopActivity: stopActivity === true }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const code = payload !== null && typeof payload.code === 'string' ? payload.code : `http-${response.status}`
        // Known codes speak the UI's language; the Host's (Chinese) text is only the fallback.
        const known = copy().codes[code]
        const message = typeof known === 'string'
          ? known
          : payload !== null && typeof payload.message === 'string' && payload.message.length > 0
            ? payload.message
            : copy().failed(response.status)
        const failure = new Error(message)
        failure.code = code
        // A partial failure still removed some descendants; the caller drops those rows.
        failure.deletedIds = Array.isArray(payload?.deletedIds) ? payload.deletedIds : []
        throw failure
      }
      return payload
    }

    /* ---------------------------------------------------------------- *
     * Icons (paths copied from the shipped outline icon set)
     * ---------------------------------------------------------------- */

    function TrashIcon(props) {
      const size = props.size ?? 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      },
      h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
      h('path', { d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833', stroke: 'currentColor' }),
      h('path', { d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831', stroke: 'currentColor' }),
      h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
      h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }))
    }

    function CloseIcon(props) {
      const size = props.size ?? 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      },
      h('path', { d: 'M2.5 2.5L13.5 13.5', stroke: 'currentColor' }),
      h('path', { d: 'M13.5 2.5L2.5 13.5', stroke: 'currentColor' }))
    }

    function WarningIcon(props) {
      const size = props.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      },
      h('path', { d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z', stroke: 'currentColor' }),
      h('path', { d: 'M8 4.75V9', stroke: 'currentColor' }),
      h('path', { d: 'M8 11.4V11.5', stroke: 'currentColor' }))
    }

    /* ---------------------------------------------------------------- *
     * Styles (shipped modal metrics under a `dsh-del-` prefix)
     * ---------------------------------------------------------------- */

    const DIALOG_CSS = `
.dsh-del-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px; }
.dsh-del-mask { position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0; background: var(--dsw-alias-bg-mask-1, var(--dsw-alias-bg-overlay)); backdrop-filter: var(--dsw-mask-blur, none); }
.dsh-del-dialog { position: relative; z-index: 1; box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); padding: 0 0 24px; overflow: hidden; border-radius: var(--dsw-radius-panel, 12px); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent, none); }
.dsh-del-dialog:focus { outline: none; }
.dsh-del-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsh-del-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-del-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dsh-del-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-del-body { display: flex; flex-direction: column; gap: 10px; padding: 0 24px; }
.dsh-del-text { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-del-hint { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
.dsh-del-hint svg { flex: none; margin-top: 2px; }
.dsh-del-error { margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dsh-del-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dsh-del-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md, 8px); background: transparent; cursor: pointer; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dsh-del-button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-del-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-del-outline { border: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-del-danger { border: 0.5px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-del-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
`

    /* ---------------------------------------------------------------- *
     * Confirmation dialog
     * ---------------------------------------------------------------- */

    function DeleteConfirmDialog() {
      const request = usePending()
      if (request === null) return null
      return h(React.Fragment, null,
        h('style', { key: 'style' }, DIALOG_CSS),
        h(DeleteConfirmForm, { key: request.sessionId, request }))
    }

    function DeleteConfirmForm({ request }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [canStop, setCanStop] = React.useState(false)
      const dialogRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const strings = copy()

      const close = React.useCallback(() => {
        if (!busy) setPending(null)
      }, [busy])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!busy) setPending(null)
            return
          }
          // Focus trap: aria-modal promises Tab never leaves the dialog.
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
          if (focusable.length === 0) {
            event.preventDefault()
            dialogRef.current.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (!dialogRef.current.contains(active)) {
            event.preventDefault()
            first.focus()
          } else if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy])

      React.useEffect(() => {
        const node = cancelRef.current ?? dialogRef.current
        node?.focus?.()
        const returnTo = request.returnFocus
        return () => {
          // Give focus back to the row's trigger instead of dropping it on <body>.
          if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus()
        }
      }, [])

      const run = React.useCallback((stopActivity) => {
        setBusy(true)
        setError(null)
        callDelete(request.sessionId, stopActivity).then((receipt) => {
          setBusy(false)
          closeOpenSession(request.sessionId)
          // Same as the partial path: every deleted id is dropped explicitly, not only
          // the ones the current list snapshot happens to carry.
          const deleted = Array.isArray(receipt?.deletedIds) && receipt.deletedIds.length > 0
            ? receipt.deletedIds
            : [request.sessionId]
          for (const id of new Set([request.sessionId, ...deleted])) dropRow(id)
          rememberDeleted(...deleted)
          setPending(null)
          // Ask the Host again so its own ghost bookkeeping is the authority for this page.
          syncGhostsNow()
        }, (reason) => {
          setBusy(false)
          setError(reason)
          // Descendants removed before a partial failure are gone: hide their rows too.
          if (Array.isArray(reason?.deletedIds) && reason.deletedIds.length > 0) {
            for (const id of reason.deletedIds) dropRow(id)
            rememberDeleted(...reason.deletedIds)
          }
          const code = reason !== null && typeof reason === 'object' ? reason.code : undefined
          setCanStop(code === 'active' || code === 'descendant-running')
        })
      }, [request.sessionId])

      const title = request.displayTitle.length > 0 ? request.displayTitle : request.sessionId
      const ids = React.useMemo(() => {
        const base = `dsh-del-${Math.random().toString(36).slice(2, 10)}`
        return { title: `${base}-title`, body: `${base}-body`, hint: `${base}-hint` }
      }, [])
      const body = h('div', { className: 'dsh-del-body' },
        h('p', { className: 'dsh-del-text', id: ids.body }, strings.body(title)),
        h('p', { className: 'dsh-del-hint', id: ids.hint }, h(WarningIcon, { size: 16 }), h('span', null, strings.hint)),
        // role=alert: the Host's refusal is announced, not only painted.
        error !== null && h('p', { className: 'dsh-del-error', role: 'alert' }, canStop ? strings.active(error.message) : error.message))

      const cancel = h('button', {
        key: 'cancel',
        type: 'button',
        ref: cancelRef,
        className: 'dsh-del-button dsh-del-outline',
        disabled: busy,
        onClick: close,
      }, strings.cancel)

      const confirm = canStop
        ? h('button', {
          key: 'confirm',
          type: 'button',
          className: 'dsh-del-button dsh-del-danger',
          disabled: busy,
          onClick: () => run(true),
        }, busy ? strings.busy : strings.stopAndConfirm)
        : h('button', {
          key: 'confirm',
          type: 'button',
          className: 'dsh-del-button dsh-del-danger',
          disabled: busy,
          onClick: () => run(false),
        }, busy ? strings.busy : strings.confirm)

      const dialog = h('div', { className: 'dsh-del-root', role: 'presentation' },
        h('div', { className: 'dsh-del-mask', 'aria-hidden': true, onClick: close }),
        h('div', {
          ref: dialogRef,
          tabIndex: -1,
          // macOS Desktop (0.2.2-rc.1+): a body portal must declare its own
          // window region, or clicking the dialog over the header drags the window.
          'data-window-drag-exclude': '',
          className: 'dsh-del-dialog',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': ids.title,
          'aria-describedby': `${ids.body} ${ids.hint}`,
          'aria-busy': busy ? 'true' : 'false',
        },
        h('div', null,
          h('div', { className: 'dsh-del-header' },
            h('h2', { className: 'dsh-del-title', id: ids.title }, strings.title),
            h('button', {
              type: 'button',
              className: 'dsh-del-close',
              'aria-label': strings.cancel,
              disabled: busy,
              onClick: close,
            }, h(CloseIcon, { size: 14 }))),
          body),
        h('div', { className: 'dsh-del-footer' }, cancel, confirm)))

      return createPortal(dialog, document.body)
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'connection', 'contextMenus'],
      apply(ctx) {
        installSessionCleanup(ctx)

        // Glyph for the menu action; the overlay renders it by key.
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: MENU_ICON_KEY,
        }, TrashIcon))

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: MENU_TARGET,
          order: MENU_ORDER,
          resolve: ({ sessionId, displayTitle }) => [{
            id: 'delete',
            label: copy().menu,
            icon: { key: MENU_ICON_KEY },
            danger: true,
            separatorBefore: true,
            run: () => openDeleteConfirm(sessionId, displayTitle),
          }],
        }), 'delete-session: session menu action')

        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'delete-session-confirm',
        }, DeleteConfirmDialog))
      },
    }
  },
})
