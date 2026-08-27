/**
 * The docked workbench rendered inside DSH's official right-sidebar slot.
 * AppFrame owns the outer column geometry. This component owns the tab tree
 * and the column-internal bottom workbench only. Free windows render through
 * {@link FloatingLayer} in the independent shell.overlay surface below.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer). Tabs live in one tree only —
 * they never cross panels; only the panel sizes drag against each other.
 *
 * Narrow (mobile, <768px) viewports show ONLY the right sidebar: entering
 * narrow migrates the bottom panel's tabs INTO the right tree
 * (migrateBottomTabs) — one workbench, the bottom tabs thrown into its
 * strips. The right panel becomes a full-width drawer, the bottom panel
 * and its toggle button disappear, and the layout push is disabled (the
 * drawer floats). Widening does not migrate back: the tabs keep living in
 * the right tree.
 */
import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarSessionList } from '../context-types.ts'
import { appendToDraft } from './conversation-draft.ts'
import {
  BOTTOM_MIN, PANEL_MIN, agentUuidOf, closeFloatByTab, closeTab, dockFloat, firstLeaf, floatTab, isAgentTabId, leafWithTab, migrateBottomTabs,
  moveFloat, moveTab, moveTabToEdge, openDiffTab, raiseFloat, reconcileAgentTerminals,
  resizeFloat, resizeSplitIn, setBottomHeight, setTabPin, toggleBottomPanel, toggleExpanded,
  type DropZone, type SidebarState, type SidebarStore, type SidebarTab, type SplitNode,
} from './state.ts'
import { collectPinnedTabs, createPinnedVirtualTab, getPinnedHomeScope, injectPinnedIntoTree, isPinnedVirtualId, parsePinnedVirtualId, type PinnedTabEntry } from './pinned.ts'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import { isNarrowWidth, useViewportSize } from './breakpoints.ts'
import { parseDesktopEnv } from './desktop-env.ts'
import { getWcoSnapshot, subscribeWco } from './wco.ts'
import { getShellPreset } from './shell-presets.ts'
import { computeTitleBarStrip } from './titlebar-strip.ts'
import type { NewTabOption } from './TabBar.tsx'
import { TAB_DRAG_TYPE, parseDrag, type TabDragPayload } from './TabBar.tsx'
import { FreeWindow } from './FreeWindow.tsx'
import { relativeTo } from './paths.ts'
import { OrphanedTab } from './OrphanedTab.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { tabContentCompare, type TabContentMemoKey } from './tab-content-memo.ts'
import { detectNewDirectSubagent } from './subagent-detect.ts'
import { detectNewJob } from './subagent-jobs.ts'
import { t } from './locales.ts'
import { api, type SessionScope } from './api.ts'
import css from './sidebar.module.css'

/** How many consecutive reconnect failures stop the agent-terminals push loop
 * (mirror of the terminal view's own cap; the loop restarts on session switch). */
const FAILURE_LIMIT = 3

/**
 * Subagent auto-open debounce (ms). The host delivers a new child's origin
 * and its title in SEPARATE frames: a Side Chat thread's first visible
 * frame still shows a fallback title (no 'Side: ' prefix), so an immediate
 * 0→N decision mistakes it for a genuine subagent and pops the task page.
 * The trigger therefore re-evaluates against the live snapshot once the
 * title frame has had time to land.
 */
const AUTO_OPEN_DEBOUNCE_MS = 500

/**
 * OS file drags over the sidebar belong to the sidebar, not to the chat:
 * DSH's composer (InputBar) listens for file drags on the DOCUMENT and
 * answers with a full-screen "drop image here" mask plus image intake on
 * drop. Both docked and floating render sites swallow the whole event quartet —
 * enter/over/leave/drop — so the region is a black hole to that document
 * listener. All four must be stopped: InputBar keeps an enter/leave depth
 * counter, and a leave that escapes without its matching enter unbalances
 * the count (this was the full-screen mask flickering over the sidebar).
 * The conversation column keeps DSH's native overlay and intake untouched;
 * gated on the 'Files' type so in-app drags (tab reorder, split zones)
 * propagate exactly as before.
 */
const swallowOsFileDrag = (event: ReactDragEvent): void => {
  if (!(event.dataTransfer?.types.includes('Files') ?? false)) return
  event.preventDefault()
  event.stopPropagation()
}

/** The four drag events a file drag must never carry past a plugin surface. */
const osFileDragShield = {
  onDragEnter: swallowOsFileDrag,
  onDragOver: swallowOsFileDrag,
  onDragLeave: swallowOsFileDrag,
  onDrop: swallowOsFileDrag,
}

/**
 * Append one user-space stylesheet (preset or custom CSS) as a tagged
 * `<style>` element. The tag attribute carries the source identity so the
 * running configuration is inspectable in DevTools; the returned tag is
 * removed by the caller's effect cleanup.
 */
function injectUserCss(attr: string, id: string, cssText: string): HTMLStyleElement {
  const tag = document.createElement('style')
  tag.setAttribute(attr, id)
  tag.textContent = cssText
  document.head.appendChild(tag)
  return tag
}

/** Props of one tab's content cell = the memo key (tab-content-memo.ts) plus
 *  the runtime objects/callbacks the cell renders with. The memo comparator
 *  is the pure `tabContentCompare`; anything in the key decides a re-render
 *  must propagate, anything outside it must be a stable object (ctx/store)
 *  or covered by a compared field (paneId covers onOpenDiff's captured
 *  pane; sessionId/cwd cover onReferenceFile). */
interface TabContentProps extends TabContentMemoKey {
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string) => void
  ctx: Context
  store: SidebarStore
  /** Fired before a topology node jumps to its child session (see Sidebar). */
  onSubagentJump: (childSessionId: string) => void
  /** Open a diff tab from the git panel (placement handled by the store). */
  onOpenDiff: (tab: SidebarTab) => void
}

/** Render the content of one tab (dispatched by type). */
const TabContent = memo(function TabContent(props: TabContentProps) {
  const { tab, effectiveTabId, sessionId, cwd, expanded, revealed, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff } = props
  const scope = { sessionId, cwd }
  const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
  if (descriptor === undefined) {
    return <OrphanedTab ctx={ctx} store={store} scope={scope} tab={tab} visible={visible} />
  }
  // For pinned virtual tabs, the tab descriptor's component (e.g. TerminalView)
  // must receive the ORIGINAL tab id so it connects to the home session's PTY.
  // The virtual tab's own id is a unique display key (prefixed); effectiveTabId
  // restores the real id at the component boundary.
  const componentTab = effectiveTabId !== undefined ? { ...tab, id: effectiveTabId } : tab
  return createElement(
    RenderBoundary,
    { className: css.tabBoundaryError },
    createElement(descriptor.component, {
      ctx, store, scope, tab: componentTab, visible, expanded, revealed,
      onToggleDir, onReferenceFile, onOpenDiff, onSubagentJump,
    }),
  )
}, tabContentCompare)

/** The + menu options for the current state, driven by the tab registry.
 * Hidden tabs (editor/diff) never show; `available` returning false shows
 * a disabled row (e.g. terminal at capacity) instead of hiding the option.
 * Tabs the user disabled in the side card settings are filtered out
 * entirely — re-enabling them is the settings page's job. */
function buildNewTabOptions(state: SidebarState, ctx: Context, scope: SessionScope): NewTabOption[] {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
      icon: typeof d.icon === 'function' ? d.icon(16) : d.icon,
    }))
}

export function Sidebar(props: {
  ctx: Context
  store: SidebarStore
  collapsed: boolean
  revealDockedSurface: () => void
}) {
  const { ctx, store, collapsed, revealDockedSurface } = props

  // Copy freshness: re-render the whole tree when the DSH locale switches.
  // The module-level t() reads the active locale at call time, so a root
  // re-render alone re-localizes every panel (no memo barriers below).
  const localeRevision = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.locale.subscribe(callback), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  void localeRevision

  // better-locale override freshness: when @huanlin/dsh-plugin-better-locale
  // is installed and the user picks an override language (e.g. ja), the
  // store's `active` changes but the DSH locale's `active` does NOT —
  // better-locale keeps the dsh active value (zh/en) unchanged and only
  // patches `LocaleRuntime.prototype.lookup`. The localeRevision uSES
  // above reads `getSnapshot().active`, so it sees no change and skips
  // re-render. This second uSES reads the better-locale store's `active`
  // directly, so an override switch fires a full re-render and t() picks
  // up the new override text. Optional: ctx.get returns undefined when
  // better-locale is absent (or when ctx is a minimal test mock without
  // a `get` method), in which case this is a no-op uSES.
  type BetterLocaleStore = {
    readonly active: string | undefined
    subscribe(listener: () => void): () => void
  }
  const betterLocaleStore = typeof ctx.get === 'function'
    ? (ctx as unknown as {
        get(name: 'betterLocale'): BetterLocaleStore | undefined
      }).get('betterLocale')
    : undefined
  const betterLocaleActive = useSyncExternalStore(
    useMemo(() => {
      const store = betterLocaleStore
      if (store === undefined) return (_cb: () => void) => () => {}
      return (callback: () => void) => store.subscribe(callback)
    }, [betterLocaleStore]),
    useMemo(() => {
      const store = betterLocaleStore
      if (store === undefined) return () => undefined
      return () => store.active
    }, [betterLocaleStore]),
  )
  void betterLocaleActive

  // Tab-registry revision: TabContent memo cells must pick up a descriptor
  // a plugin registers/disposes after mount (the + menu / icons already read
  // the registry at render). Rare events (plugin (un)mount), so one full
  // re-render per change is fine — this is what keeps the memoized cells
  // from going stale, mirroring the localeRevision mechanism above.
  const [tabsVersion, setTabsVersion] = useState(0)
  useEffect(() => {
    const service = ctx.get('betterSidebar')
    if (service === undefined) return
    return service.subscribe(() => setTabsVersion(version => version + 1))
  }, [ctx])

  // Narrow (mobile) viewports collapse the two panels into one: the right
  // panel becomes a full-width drawer holding BOTH workbenches, the bottom
  // panel (and its toggle button) disappears, and the layout push is
  // disabled (the drawer floats over the app shell). Entering narrow
  // MIGRATES the bottom tree's tabs into the right tree (migrateBottomTabs)
  // — the merged display is the right sidebar alone, the bottom tabs thrown
  // into its strips. Widening never rewrites the migrated state: the tabs
  // keep living in the right tree.
  const viewport = useViewportSize()
  const narrow = isNarrowWidth(viewport.width)

  // On-screen keyboard / visual-viewport inset (mobile, split-screen, …):
  // when the visual viewport shrinks below the layout viewport, bottom-
  // anchored panels would hide under the keyboard. Track the inset and
  // offset the bottom-anchored surfaces by it. The obscured bottom strip is
  // innerHeight − (vv.height + vv.offsetTop): offsetTop is nonzero while
  // the visual viewport is scrolled/zoomed under browser chrome, so
  // omitting it would over-lift the panels (CR #232 P2). offsetTop changes
  // through the viewport's scroll event too, so both events are listened.
  // Guarded: browsers without visualViewport (older WebViews, jsdom) stay
  // at 0. rAF-throttled, same pattern as useNarrowViewport.
  const [keyboardInset, setKeyboardInset] = useState(0)
  const [visualViewportHeight, setVisualViewportHeight] = useState<number | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      setKeyboardInset(inset > 1 ? Math.round(inset) : 0)
      setVisualViewportHeight(Math.max(0, Math.round(vv.height)))
    }
    const onResize = (): void => { if (frame === null) frame = requestAnimationFrame(measure) }
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    measure()
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  // The bottom panel is offset above the on-screen keyboard. Cap its height
  // against that same visible area, not the taller layout viewport, so the
  // conversation keeps PANEL_MIN even on wide touch devices.
  const layoutViewportHeight = visualViewportHeight ?? viewport.height

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useEffect(() => { store.setSession(current) }, [current, store])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd

  // Title-bar / shell compatibility (the "位置兼容模式" scheme):
  //   auto    — CONSERVATIVE: only the standard Window Controls Overlay
  //             geometry contributes (the real caption-overlay height,
  //             reactive to maximize/restore). No URL stamp, no preset, no
  //             guess — plain browsers see zero modification.
  //   preset  — an opt-in built-in shell preset (shell-presets.ts) adds its
  //             per-shell strip as the no-WCO fallback.
  //   custom  — the user's own CSS (injected below) + the legacy manual
  //             strip px.
  // The resolved strip drives the SAME body attribute + CSS variable as the
  // legacy boolean did, so the CSS contract is unchanged (layout.css /
  // sidebar.module.css); only the value source changed. The cleanup removes
  // both on unmount/boundary swap so a crashed sidebar never leaves them
  // behind.
  const desktopEnv = parseDesktopEnv()
  const wco = useSyncExternalStore(
    useMemo(() => subscribeWco, []),
    getWcoSnapshot,
  )
  const scheme = snapshot.prefs.titleBarScheme
  const preset = scheme === 'preset' ? getShellPreset(snapshot.prefs.titleBarPresetId) : undefined
  const titleBarStrip = computeTitleBarStrip(
    desktopEnv, wco, scheme, preset, snapshot.prefs.titleBarStripPx,
  )
  const titleBarCompat = titleBarStrip > 0
  useEffect(() => {
    const root = document.documentElement
    if (titleBarCompat) {
      document.body.setAttribute('data-dsh-title-bar-compat', '')
      root.style.setProperty('--dsh-title-bar-strip', `${titleBarStrip}px`)
    } else {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
    return () => {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
  }, [titleBarCompat, titleBarStrip])

  // User-space CSS injection (the escape hatch): preset CSS (scheme
  // `preset`) and free-form custom CSS (scheme `custom`) are appended AFTER
  // the plugin's own styles — later in the cascade wins ties, and
  // `!important` can override the JS-written inline strip variable. Each
  // source gets its own tagged <style> so the running configuration stays
  // inspectable; tags are removed on change/unmount so a stale stylesheet
  // never outlives its fiber (HMR-safe).
  const presetCss = scheme === 'preset' ? preset?.css ?? '' : ''
  const customCss = scheme === 'custom' ? snapshot.prefs.customCss : ''
  useEffect(() => {
    const tags: HTMLStyleElement[] = []
    if (presetCss !== '') tags.push(injectUserCss('data-dsh-preset-css', preset?.id ?? '', presetCss))
    if (customCss !== '') tags.push(injectUserCss('data-dsh-custom-css', 'custom', customCss))
    return () => { for (const tag of tags) tag.remove() }
  }, [presetCss, customCss, preset?.id])

  /**
   * Bottom-panel merge on narrow viewports: whenever a session is current
   * while narrow (mount, session switch, or a desktop→narrow transition),
   * throw the bottom tree's tabs into the right tree. Idempotent — after
   * the first migration the bottom tree is empty and the reducer returns
   * the same reference, so this effect settles immediately.
   */
  useEffect(() => {
    if (!narrow || sessionId === undefined) return
    store.reduce(migrateBottomTabs)
  }, [narrow, sessionId, store])

  // While the session's header is still hydrating (or the session is blank),
  // the list summary may carry no cwd; ask the host once (it falls back to
  // the process cwd) so the explorer root and terminal cwd are real from
  // first paint instead of showing "no session".
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setFetchedCwd(result.cwd) })
      .catch(() => { /* the explorer/git rows surface their own errors */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  /**
   * Agent terminals push: subscribe to the host's live list of agent-owned
   * terminals for this session (created by the model through the
   * `terminal_create` tool). The host pushes a JSON array on every
   * create / close / exit; the sidebar reconciles the list into tabs
   * (id `agent:<uuid>`, title from the agent). A disconnected socket
   * retries with a short backoff so a refresh or transient drop reattaches
   * the same shell without losing the agent's work — capped like the
   * terminal view's own reconnect loop, so a refused endpoint never spins
   * forever (the next session switch restarts the loop).
   * While the terminal tab type is disabled in settings, pushes are
   * ignored (no auto-added tabs); re-enabling makes the next push converge.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean }>
          if (!Array.isArray(list)) return
          store.reduce(s => ctx.get('betterSidebar')?.isTabEnabled('terminal') === false
            ? s
            : reconcileAgentTerminals(s, list))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, store])

  /**
   * Agent opens push: subscribe to the host's `sidebar_open` requests for
   * this session (the model actively opens a file / folder / HTTP(S) page).
   * The host pushes one JSON request per open; the sidebar routes it to the
   * matching built-in tab: a file opens in the editor (per-path dedupe), a
   * folder opens a file window whose tree is rooted at the folder
   * (`meta.dir`), and a URL opens in the browser tab. A disconnected socket
   * retries with a short backoff (mirror of the agent-terminals loop): the
   * host queue keeps undelivered requests and replays them on the first
   * attach, so a refresh or a session switch lands the opens the model
   * queued while no view was connected.
   * While the side-card setting is off, pushes are ignored as a defensive
   * gate — the host already unregisters the tool and drains the queue.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-opens', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const request = JSON.parse(event.data) as { kind?: unknown; target?: unknown; title?: unknown }
          if (request === null || typeof request !== 'object') return
          if (request.kind !== 'file' && request.kind !== 'folder' && request.kind !== 'url') return
          if (typeof request.target !== 'string' || request.target === '') return
          if (store.getPrefs().agentOpenTools !== true) return
          const scope = { sessionId }
          const title = typeof request.title === 'string' && request.title !== '' ? request.title : undefined
          if (request.kind === 'url') {
            ctx.get('betterSidebar')?.openTab({ type: 'browser', url: request.target, title }, scope)
          } else if (request.kind === 'folder') {
            ctx.get('betterSidebar')?.openTab({
              type: 'editor',
              title,
              path: request.target,
              id: `editor:${request.target}`,
              meta: { dir: true },
            }, scope)
          } else {
            ctx.get('betterSidebar')?.openFile(scope, request.target, title)
          }
        } catch {
          // Malformed push: ignore (the next push carries its own request).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-opens connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, store])

  /**
   * Subagent auto-activation: the moment the current conversation spawns its
   * FIRST direct subagent (a 0 → N transition on the list feed), the "auto
   * open" pref is on, and the Subagent tab type is enabled in settings,
   * open the panel (if collapsed) and focus the Subagent page
   * (single-instance: an existing tab is focused, never duplicated).
   * Switching to a session that already has subagents never triggers — its
   * baseline starts at the current count — so a deliberate layout is never
   * fought.
   *
   * The decision is DEBOUNCED (AUTO_OPEN_DEBOUNCE_MS): a Side Chat thread
   * is also a subagent-origin child, and its 'Side: ' title lands one frame
   * after its origin — an immediate check would misread that first frame as
   * a new subagent and pop this page on every thread creation. The timer
   * re-evaluates the ORIGINAL baseline against the live snapshot; by then
   * the title filter (isSideThreadSummary) sees the settled label.
   */
  const listBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  const autoOpenPendingRef = useRef<{ baseline: SidebarSessionList; timer: number } | null>(null)
  useEffect(() => {
    const prev = listBaselineRef.current
    listBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (autoOpenPendingRef.current !== null) return
    if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return
    const baseline = prev
    const timer = window.setTimeout(() => {
      autoOpenPendingRef.current = null
      if (!detectNewDirectSubagent(baseline, ctx.sessions.list.getSnapshot(), sessionId)) return
      if (!store.getPrefs().autoOpenSubagent) return
      if (ctx.get('betterSidebar')?.isTabEnabled('subagent') === false) return
      revealDockedSurface()
      // Pin the landing to the right panel: the auto-opened Subagent page must
      // appear where the panel just expanded, not in a bottom-panel pane the
      // user last touched.
      store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
      ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
    }, AUTO_OPEN_DEBOUNCE_MS)
    autoOpenPendingRef.current = { baseline, timer }
  }, [sessionList, sessionId, store, ctx, revealDockedSurface])

  // A session switch (or unmount) voids any armed auto-open recheck.
  useEffect(() => () => {
    const pending = autoOpenPendingRef.current
    if (pending !== null) window.clearTimeout(pending.timer)
    autoOpenPendingRef.current = null
  }, [sessionId])

  /**
   * Job auto-activation: the moment a NEW background job appears for the
   * current conversation (a job id the previous snapshot lacked), the
   * auto-open pref is on, and the Jobs tab type is enabled, open the panel
   * (if collapsed) and focus the Jobs page. Unlike the subagent trigger
   * (0 → N only), ANY new job id triggers: the agent may start several
   * jobs in one session, and each should surface. A fresh page load never
   * triggers — its baseline starts at the current snapshot.
   */
  const jobBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    const prev = jobBaselineRef.current
    jobBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewJob(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenJobs) return
    if (ctx.get('betterSidebar')?.isTabEnabled('subagent') === false) return
    revealDockedSurface()
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx, revealDockedSurface])

  /**
   * Topology jump-back: clicking a subagent node on the Subagent page calls
   * the official `openSubagent`, which switches the sidebar to that child
   * session's OWN layout (a fresh child session defaults to the explorer).
   * The README contract says the Subagent page must stay open with the jumped
   * node highlighted — so once the current session becomes the recorded jump
   * target, re-open the Subagent page on top of the child's layout (expanding
   * the panel first if it is collapsed). Only this explicit node click arms
   * the flag, so switching to a subagent session by any other means keeps
   * that session's own layout untouched.
   */
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = subagentJumpRef.current
    if (pending === undefined || sessionId !== pending) return
    subagentJumpRef.current = undefined
    revealDockedSurface()
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionId, store, ctx, revealDockedSurface])

  /**
    * Inline pinned terminals (v0.17.0+): pinned tabs from OTHER sessions
    * inject as VIRTUAL tabs into the first leaf of the right panel's split
    * tree. The virtual tabs have unique ids (prefixed with the home session)
    * and carry the home scope in meta. Clicking a virtual tab sets
    * `activePinnedTabId` — the augmented tree overrides the leaf's `active`
    * so the pinned tab's content renders in-place (TerminalView connects to
    * the home session's PTY via WS, no session jump).
    *
    * Closing/unpinning a virtual tab targets the HOME session via reduceFor
    * (which doesn't notify — targeted opens must not re-render the active
    * session). The `pinnedRevision` state bump forces the pinnedEntries
    * useMemo to recompute after such an action.
    */
  const [activePinnedTabId, setActivePinnedTabId] = useState<string | null>(null)
  const [pinnedRevision, setPinnedRevision] = useState(0)

  /**
   * Cross-session pinned-tab collection. Recomputed on every store notify,
   * session-list change, and pinned action (the revision bump covers
   * reduceFor updates that don't notify). Only tabs from OTHER sessions —
   * the viewer's own pinned tabs are already on its tab strip.
   */
  const pinnedEntries: readonly PinnedTabEntry[] = useMemo(() => {
    if (sessionId === undefined) return []
    return collectPinnedTabs(store.getSessionStates(), { sessionId, cwd })
  }, [store, sessionId, cwd, snapshot, pinnedRevision])

  /** Virtual SidebarTab objects for the pinned entries (stable references
   *  via useMemo so TabContent's memo comparator holds). */
  const pinnedVirtualTabs = useMemo(
    () => pinnedEntries.map(createPinnedVirtualTab),
    [pinnedEntries],
  )

  /** The right panel's split tree with pinned virtual tabs injected into the
   *  first leaf. When `activePinnedTabId` is set, that leaf's `active` is
   *  overridden so the pinned tab's content is visible. */
  const augmentedTree = useMemo(
    () => state === undefined ? undefined : injectPinnedIntoTree(state.splits, pinnedVirtualTabs, activePinnedTabId),
    [state, pinnedVirtualTabs, activePinnedTabId],
  )

  /**
   * Bottom-panel first-expansion auto terminal: the FIRST time the user
   * expands the bottom panel in a session, try to open a fresh terminal tab
   * there. "Try" is literal — the terminal's own quota and enable switch
   * gate the attempt (a full quota or a disabled terminal type makes it a
   * no-op). Gated on the bottomPanelAutoTerminal pref (the terminal tab's
   * nested settings toggle, default on). Only a false→true TRANSITION fires
   * (a panel persisted open never counts as an expansion), and the session's
   * bottomOpenedOnce flag is set atomically with the first fire so later
   * expansions never repeat it.
   */
  const bottomWasOpenRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    // The bottom panel does not exist on narrow viewports (the two
    // workbenches merge into one panel), so the first-expansion auto
    // terminal is a desktop-only behavior.
    if (narrow || !snapshot.prefs.bottomPanelEnabled) return
    if (state === undefined) return
    const wasOpen = bottomWasOpenRef.current
    bottomWasOpenRef.current = state.bottomOpen
    if (wasOpen === undefined || wasOpen || !state.bottomOpen) return
    if (state.bottomOpenedOnce) return
    if (store.getPrefs().bottomPanelAutoTerminal === false) return
    if (ctx.get('betterSidebar')?.isTabEnabled('terminal') === false) return
    // Land the tab in the bottom panel's first pane; the once-flag is set
    // atomically so later expansions never repeat the auto-open.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id, bottomOpenedOnce: true }))
    ctx.get('betterSidebar')?.openTab({ type: 'terminal' })
  }, [state, store, ctx, narrow])

  // Only the column-internal bottom divider is plugin-owned. DSH owns the
  // official right-column width and its outer resize handle.
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const bottomDrag = useRef({ startY: 0, startHeight: 0 })
  const [draggingBottom, setDraggingBottom] = useState(false)
  const dragFrame = useRef<number | null>(null)
  const pendingHeight = useRef<number | null>(null)
  const dragCommitted = useRef(false)

  const clampHeight = (height: number): number =>
    Math.min(
      Math.max(BOTTOM_MIN, Math.round(height)),
      Math.max(BOTTOM_MIN, layoutViewportHeight - PANEL_MIN),
    )

  const applyBottomHeight = (height: number): void => {
    bottomRef.current?.style.setProperty('height', `${height}px`)
  }

  const scheduleBottomHeight = (height: number): void => {
    pendingHeight.current = height
    if (dragFrame.current !== null) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null
      const pending = pendingHeight.current
      pendingHeight.current = null
      if (pending !== null) applyBottomHeight(pending)
    })
  }

  const stopBottomDrag = (): void => {
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = null
    }
    pendingHeight.current = null
  }

  const commitBottomHeight = (height: number): void => {
    const next = clampHeight(height)
    stopBottomDrag()
    applyBottomHeight(next)
    store.reduce(state => setBottomHeight(state, next))
  }

  useEffect(() => () => { stopBottomDrag() }, [])

  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      // Terminal tabs may live in EITHER tree (the bottom panel hosts them
      // too) — the pty-release lookup covers both, or the HTTP fallback is
      // skipped for a bottom-panel terminal whose WS frame never arrived.
      const leaf = current === undefined
        ? undefined
        : leafWithTab(current.splits, tabId) ?? leafWithTab(current.bottomSplits, tabId)
      const tab = leaf?.tabs.find(candidate => candidate.id === tabId)
      // Route through the service: the tab-bar close is the canonical close
      // path (finds the pane itself, fires descriptor.onClose); the session
      // scope (with its cwd) rides to the callback.
      ctx.get('betterSidebar')?.closeTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
      if (tab?.type === 'terminal') {
        if (isAgentTabId(tabId)) {
          const uuid = agentUuidOf(tabId)
          void api.agentPtyClose(uuid).catch(() => { /* the host may already have released it */ })
        } else if (sessionId !== undefined) {
          void api.ptyClose({ sessionId, cwd }, tabId).catch(() => { /* the host may already have released it */ })
        }
      }
    },
    activateTab: (paneId, tabId) => {
      // Route through the service: same reducer (finds the pane in EITHER
      // tree, sets the active pane) and fires descriptor.onActivate; the
      // session scope (with its cwd) rides to the callback.
      ctx.get('betterSidebar')?.activateTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.splits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
    // The tab context menu's "move to free window": no drop point exists, so
    // the window is born over the conversation column's center (the user's
    // focus area; clamped into the viewport by the reducer) — the same
    // landing the drag-out gesture produces.
    floatTab: (tabId) => {
      const col = document.querySelector<HTMLElement>('#root [data-slot="conversation"]')?.parentElement
      const rect = col?.getBoundingClientRect()
      const x = rect !== undefined ? (rect.left + rect.right) / 2 : window.innerWidth / 2
      const y = rect !== undefined ? (rect.top + rect.bottom) / 2 : window.innerHeight / 2
      store.reduce(s => floatTab(s, tabId, x, y))
    },
    // Pin/unpin a terminal tab (v0.17.0+): the home cwd is snapshotted at
    // pin time so a workspace-scoped pin only resurfaces in sessions whose
    // cwd matches. Unpin passes null — the tab stays open in its home
    // session, just unmarked.
    pinTab: (tabId, scope) => {
      store.reduce(s => setTabPin(s, tabId, scope === null ? null : { scope, homeCwd: cwd }))
    },
  }), [store, sessionId, cwd])

  /**
   * Wrap the base actions to intercept pinned VIRTUAL tab ids (injected from
   * other sessions). Regular tab ids pass through unchanged. Virtual ids are
   * detected by the `pinned:` prefix and routed to the HOME session via
   * reduceFor (which doesn't notify — the revision bump is the local signal).
   */
  const wrappedActions = useMemo<WorkbenchActions>(() => {
    if (pinnedVirtualTabs.length === 0) return actions
    const closePinnedInHome = (virtualId: string): void => {
      const { homeSessionId, tabId: originalId } = parsePinnedVirtualId(virtualId)
      // The home cwd lives in the virtual tab's meta (snapshotted at pin
      // time) — pass it to ptyClose so the host resolves the PTY in the
      // correct workspace container (same scope the WS open used).
      const vtab = pinnedVirtualTabs.find(t => t.id === virtualId)
      const homeCwd = vtab !== undefined ? getPinnedHomeScope(vtab)?.cwd : undefined
      store.reduceFor(homeSessionId, s => {
        const leaf = leafWithTab(s.splits, originalId) ?? leafWithTab(s.bottomSplits, originalId)
        if (leaf !== undefined) return closeTab(s, leaf.id, originalId)
        if (s.floats.some(f => f.tab.id === originalId)) return closeFloatByTab(s, originalId)
        return s
      })
      if (isAgentTabId(originalId)) {
        void api.agentPtyClose(agentUuidOf(originalId)).catch(() => { /* already released */ })
      } else {
        void api.ptyClose({ sessionId: homeSessionId, ...(homeCwd !== undefined ? { cwd: homeCwd } : {}) }, originalId).catch(() => { /* already released */ })
      }
      if (activePinnedTabId === virtualId) setActivePinnedTabId(null)
      setPinnedRevision(v => v + 1)
    }
    return {
      ...actions,
      activateTab: (paneId, tabId) => {
        if (isPinnedVirtualId(tabId)) {
          setActivePinnedTabId(tabId)
        } else {
          setActivePinnedTabId(null)
          actions.activateTab(paneId, tabId)
        }
      },
      closeTab: (paneId, tabId) => {
        if (isPinnedVirtualId(tabId)) {
          closePinnedInHome(tabId)
        } else {
          actions.closeTab(paneId, tabId)
        }
      },
      moveTabBefore: (payload, toPane, beforeTabId) => {
        if (isPinnedVirtualId(payload.tabId)) return
        if (isPinnedVirtualId(beforeTabId)) {
          actions.moveTabToEdge(payload, toPane, 'center')
        } else {
          actions.moveTabBefore(payload, toPane, beforeTabId)
        }
      },
      moveTabToEdge: (payload, toPane, zone) => {
        if (isPinnedVirtualId(payload.tabId)) return
        actions.moveTabToEdge(payload, toPane, zone)
      },
      floatTab: (tabId) => {
        if (isPinnedVirtualId(tabId)) return
        actions.floatTab(tabId)
      },
      pinTab: (tabId, scope) => {
        if (isPinnedVirtualId(tabId)) {
          if (scope !== null) return
          const { homeSessionId, tabId: originalId } = parsePinnedVirtualId(tabId)
          store.reduceFor(homeSessionId, s => setTabPin(s, originalId, null))
          if (activePinnedTabId === tabId) setActivePinnedTabId(null)
          setPinnedRevision(v => v + 1)
        } else {
          actions.pinTab?.(tabId, scope)
        }
      },
    }
  }, [actions, pinnedVirtualTabs, activePinnedTabId, store])

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). The conversation service is
   * resolved lazily through `ctx.get` (the inject-free read — the app's own
   * plugins read 'conversation' the same way); a missing service or scope
   * degrades to a logged no-op, never a crash. Defined above the no-session
   * early return — a hook must never sit behind a conditional return
   * (React counts hooks per render).
   */
  const referenceInChat = useCallback((path: string): void => {
    if (sessionId === undefined) return
    appendToDraft(ctx, sessionId, `@${relativeTo(cwd ?? '', path)}`)
  }, [ctx, sessionId, cwd])

  if (state === undefined || sessionId === undefined) {
    return <div className={css.editorPlaceholder}>{t('noSession')}</div>
  }

  const bottomPanelHeight = clampHeight(state.bottomHeight)

  const onNewTab = (optionId: string): void => {
    const service = ctx.get('betterSidebar')
    const descriptor = service?.getTab(optionId)
    if (service === undefined || descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    // The session scope rides along: lifecycle callbacks receive it (and
    // the open stays in the current session, as before).
    service.openTab({ type: optionId, title }, { sessionId, cwd })
  }

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). Resolves the session-scope
   * ctx and the conversation input service at click time; a missing service
   * or scope degrades to a logged no-op, never a crash.
   */
  /** The tab icon from the tab-type registry (shared by every workbench). */
  const tabIconOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
    if (descriptor === undefined) return null
    return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
  }

  /**
   * The tab badge from the tab-type registry: a count (99+ capped) or a
   * short text pill. A throwing badge is swallowed (no pill) — the tab
   * strip must never break because a plugin's badge computation failed.
   */
  const tabBadgeOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
    if (descriptor?.badge === undefined) return null
    let value: string | number | null | undefined
    try {
      value = descriptor.badge(ctx, { sessionId, cwd }, state)
    } catch (error) {
      console.error('[dsh-better-sidebar] tab badge error:', error)
      return null
    }
    if (value === null || value === undefined || value === '') return null
    const text = typeof value === 'number' ? (value > 99 ? '99+' : String(value)) : String(value)
    return <span className={css.tabBadge}>{text}</span>
  }

  /**
   * Render one tab's content. `active` (from the workbench) tells whether
   * this tab is the active one in its pane; combined with the panel's
   * open/closed state it gates live views (the Subagent topology pauses its
   * polling while the page is not actually visible). The pane id travels
   * with the tab so diff tabs can split below their source pane.
   */
  // `placement` decides the visibility contract handed to the tab component:
  // pane tabs are visible while their panel is open and they are active, but
  // a free window is its own surface — its tab stays visible no matter what
  // the panels do (the AGENTS §7.5 contract; plugin components honor
  // `visible` to pause work, so tying floats to panelOpen would blank them
  // the moment the sidebar collapses).
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string, placement: 'top' | 'bottom' | 'float' = 'top') => {
    // Pinned virtual tabs: pass the home session's scope (sessionId + cwd) so
    // TerminalView's WS URL resolves to the home PTY, and effectiveTabId so
    // the descriptor component receives the ORIGINAL tab id (the virtual id
    // is only a display key). Regular tabs: effectiveTabId is undefined (no
    // override), scope is the current session's.
    const home = getPinnedHomeScope(tab)
    return (
      <TabContent
        tab={tab}
        effectiveTabId={home?.tabId}
        paneId={paneId}
        sessionId={home?.sessionId ?? sessionId}
        cwd={home?.cwd ?? cwd}
        expanded={state.expanded}
        revealed={state.revealed ?? []}
        onToggleDir={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
        onReferenceFile={referenceInChat}
        ctx={ctx}
        store={store}
        visible={
          placement === 'float'
            ? true
            : placement === 'bottom'
              ? state.bottomOpen && active
              : state.panelOpen && active
        }
        onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
        onOpenDiff={(diffTab) => { store.reduce(s => openDiffTab(s, paneId, diffTab)) }}
        localeRevision={localeRevision}
        tabsVersion={tabsVersion}
      />
    )
  }

  return (
    <div className={css.dockedSurface} data-dsh-docked-workbench {...osFileDragShield}>
      <div className={css.panel} data-dsh-panel data-collapsed={collapsed || undefined}>
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={augmentedTree}
            newTabOptions={buildNewTabOptions(state, ctx, { sessionId, cwd })}
            actions={wrappedActions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
      </div>
      {!narrow && snapshot.prefs.bottomPanelEnabled && (
        <div
          ref={bottomRef}
          className={clsx(css.bottomPanel, !state.bottomOpen && css.bottomPanelHidden)}
          data-dsh-panel
          data-dsh-bottom-panel
          style={{ height: state.bottomOpen ? bottomPanelHeight : 0 }}
          data-dragging={draggingBottom || undefined}
        >
          <div
            className={clsx(css.bottomResize, draggingBottom && css.bottomResizeActive)}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragCommitted.current = false
              bottomDrag.current = { startY: event.clientY, startHeight: state.bottomHeight }
              setDraggingBottom(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const { startY, startHeight } = bottomDrag.current
              scheduleBottomHeight(clampHeight(startHeight + (startY - event.clientY)))
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || dragCommitted.current) return
              dragCommitted.current = true
              event.currentTarget.releasePointerCapture(event.pointerId)
              const { startY, startHeight } = bottomDrag.current
              commitBottomHeight(startHeight + (startY - event.clientY))
              setDraggingBottom(false)
            }}
            onPointerCancel={(event) => {
              if (dragCommitted.current) return
              dragCommitted.current = true
              commitBottomHeight(bottomDrag.current.startHeight + (bottomDrag.current.startY - event.clientY))
              setDraggingBottom(false)
            }}
            onLostPointerCapture={() => {
              if (dragCommitted.current) return
              dragCommitted.current = true
              commitBottomHeight(pendingHeight.current ?? state.bottomHeight)
              setDraggingBottom(false)
            }}
          />
          <Tooltip label={t('collapseBottomPanel')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.bottomClose}
              aria-label={t('collapseBottomPanel')}
              onClick={() => { store.reduce(toggleBottomPanel) }}
            >
              <IconCloseFill14 />
            </button>
          </Tooltip>
          <div className={css.panelBody}>
            <Workbench
              state={state}
              tree={state.bottomSplits}
              newTabOptions={buildNewTabOptions(state, ctx, { sessionId, cwd })}
              actions={actions}
              onNewTab={onNewTab}
              renderTab={(tab, active, paneId) => renderTab(tab, active, paneId, 'bottom')}
              getTabIcon={tabIconOf}
              getTabBadge={tabBadgeOf}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Viewport-wide free-window surface. It is mounted in DSH's shell.overlay,
 * outside the official right-sidebar occupant, so collapsing that column
 * cannot clip or hide a floating tab.
 */
export function FloatingLayer(props: {
  ctx: Context
  store: SidebarStore
  revealDockedSurface: () => void
}) {
  const { ctx, store, revealDockedSurface } = props
  const overlayViewport = useViewportSize()
  const narrow = isNarrowWidth(overlayViewport.width)
  const localeRevision = useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.locale.subscribe(listener), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  const sessionList = useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.sessions.list.subscribe(listener), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const [tabsVersion, setTabsVersion] = useState(0)
  useEffect(() => {
    const service = ctx.get('betterSidebar')
    if (service === undefined) return
    return service.subscribe(() => { setTabsVersion(version => version + 1) })
  }, [ctx])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const cwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = subagentJumpRef.current
    if (pending === undefined || pending !== sessionId) return
    subagentJumpRef.current = undefined
    revealDockedSurface()
    store.reduce(current => ({ ...current, activePane: firstLeaf(current.splits).id }))
    ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
  }, [ctx, revealDockedSurface, sessionId, store])

  const [floatHint, setFloatHint] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const floatHintRef = useRef(false)
  useEffect(() => {
    if (narrow || sessionId === undefined) return
    const overConversation = (event: DragEvent): DOMRect | null => {
      if (event.target instanceof Element
        && event.target.closest('[data-dsh-better-sidebar], [data-dsh-better-sidebar-overlay]') !== null) {
        return null
      }
      const conversation = document.querySelector<HTMLElement>('#root [data-slot="conversation"]')?.parentElement
      const rect = conversation?.getBoundingClientRect()
      if (rect === undefined || rect.width === 0 || rect.height === 0) return null
      const { clientX: x, clientY: y } = event
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? rect : null
    }
    const clear = (): void => {
      floatHintRef.current = false
      setFloatHint(null)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!document.body.hasAttribute('data-dsh-tab-dragging')) return
      const rect = overConversation(event)
      if (rect === null) {
        if (floatHintRef.current) clear()
        return
      }
      event.preventDefault()
      floatHintRef.current = true
      setFloatHint({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    const onDrop = (event: DragEvent): void => {
      if (!floatHintRef.current) return
      const rect = overConversation(event)
      clear()
      if (rect === null) return
      event.preventDefault()
      event.stopPropagation()
      const payload = parseDrag(event.dataTransfer?.getData(TAB_DRAG_TYPE) ?? '')
      if (payload !== null) store.reduce(current => floatTab(current, payload.tabId, event.clientX, event.clientY))
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [narrow, sessionId, store])

  if (state === undefined || sessionId === undefined) {
    return <div className={css.floatingLayer} />
  }

  const tabIconOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
    if (descriptor === undefined) return null
    return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
  }
  const referenceInChat = (path: string): void => {
    appendToDraft(ctx, sessionId, `@${relativeTo(cwd ?? '', path)}`)
  }
  const renderTab = (tab: SidebarTab, _active: boolean, paneId: string): ReactNode => (
    <TabContent
      tab={tab}
      effectiveTabId={undefined}
      paneId={paneId}
      sessionId={sessionId}
      cwd={cwd}
      expanded={state.expanded}
      revealed={state.revealed ?? []}
      onToggleDir={(path) => { store.reduce(current => toggleExpanded(current, path)) }}
      onReferenceFile={referenceInChat}
      ctx={ctx}
      store={store}
      visible
      onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
      onOpenDiff={(diffTab) => {
        store.reduce(current => openDiffTab(current, firstLeaf(current.splits).id, diffTab))
        revealDockedSurface()
      }}
      localeRevision={localeRevision}
      tabsVersion={tabsVersion}
    />
  )

  return (
    <div className={css.floatingLayer} {...osFileDragShield}>
      {state.floats.map(float => (
        <FreeWindow
          key={float.id}
          float={float}
          renderTab={renderTab}
          getTabIcon={tabIconOf}
          onRaise={() => { store.reduce(current => raiseFloat(current, float.id)) }}
          onMove={(x, y) => { store.reduce(current => moveFloat(current, float.id, x, y)) }}
          onResize={(w, h) => { store.reduce(current => resizeFloat(current, float.id, w, h)) }}
          onDock={(paneId) => {
            store.reduce(current => dockFloat(current, float.id, paneId ?? undefined))
            revealDockedSurface()
          }}
          onClose={() => {
            ctx.get('betterSidebar')?.closeTab(float.tab.id, { sessionId, cwd })
          }}
        />
      ))}
      {floatHint !== null && (
        <div
          className={css.floatDropHint}
          style={{ left: floatHint.left, top: floatHint.top, width: floatHint.width, height: floatHint.height }}
        >
          <span className={css.floatDropHintLabel}>{t('floatDropHint')}</span>
        </div>
      )}
    </div>
  )
}
