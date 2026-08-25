/**
 * Sidebar crash tests — the two failure modes behind issue #31.
 *
 * 1. Official-layout isolation: the workbench never writes the legacy
 *    `--dsh-sidebar-width/--dsh-sidebar-height` geometry variables.
 *
 * 2. Tab crash containment: a render error inside ONE tab's content must not
 *    take down the whole sidebar. The per-tab boundary shows a strip inside
 *    that tab's pane while the other tabs and workbench panel stay alive;
 *    the retry button recovers a transient crash. The overlay toggle is a
 *    separate slot contribution covered by occupant.spec.tsx.
 *
 * Rendered with the REAL Sidebar shell + real store/service against a minimal
 * fake context (createRoot + act(), the repo's jsdom pattern).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { t } from '../src/client/locales.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

interface MountedSidebar {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  unmount: () => void
}

/** Unique per-test session ids (see the comment inside). */
let sessionSeq = 0

/** Mount the real Sidebar shell against a minimal context (real store + service). */
function mountSidebar({ current }: { current: string | undefined } = { current: 'active' }): MountedSidebar {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Fresh-session seed: open the panel explicitly (openByDefault defaults off).
  store.setPrefs({ ...store.getPrefs(), openByDefault: true })
  // Unique session per test — the store persists per-session state to
  // localStorage (200ms debounce); a shared id lets a previous test's late
  // write leak into this store's setSession restore.
  const sessionId = current === undefined ? undefined : `${current}-${++sessionSeq}`
  store.setSession(sessionId)
  // useSyncExternalStore requires STABLE snapshots across calls (the real DSH
  // services return stable objects) — a fresh object per call loops forever.
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: sessionId,
    // cwd present → api.sessionCwd is never called in these tests.
    byId: sessionId === undefined ? {} : { [sessionId]: { cwd: '/tmp' } },
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(Sidebar, {
      ctx: ctx as never,
      store,
      collapsed: false,
      revealDockedSurface: () => {},
    }))
  })
  return {
    container,
    store,
    service,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  // Belt and braces: drop any persisted layout a pending 200ms debounce
  // write left behind between tests (unique session ids already isolate).
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('official-layout isolation', () => {
  it('shows guidance when no conversation is active', () => {
    const { container, unmount } = mountSidebar({ current: undefined })
    expect(container.textContent).toContain(t('noSession'))
    unmount()
  })

  it('does not write legacy --dsh-sidebar-width/--dsh-sidebar-height geometry', () => {
    const { unmount } = mountSidebar()
    const htmlStyle = document.documentElement.style
    expect(htmlStyle.getPropertyValue('--dsh-sidebar-width')).toBe('')
    expect(htmlStyle.getPropertyValue('--dsh-sidebar-height')).toBe('')
    unmount()
    expect(htmlStyle.getPropertyValue('--dsh-sidebar-width')).toBe('')
    expect(htmlStyle.getPropertyValue('--dsh-sidebar-height')).toBe('')
  })
})

describe('tab crash containment', () => {
  it('a crashing tab shows an in-pane strip while the workbench panel survives', () => {
    const { container, service } = mountSidebar()
    service.registerTab({
      id: 'crash',
      title: 'Crash',
      component: () => { throw new Error('boom') },
    })
    act(() => { service.openTab({ type: 'crash', title: 'Crash' }) })
    // The strip lives inside the tab's pane — the crash is contained.
    expect(container.textContent).toContain('boom')
    expect(container.textContent).toContain(t('terminalRetry'))
    // The surrounding panel survived (no full-tree swap): its tab-strip
    // action is still there and no legacy layout push leaked.
    expect(container.querySelector(`[aria-label="${t('newTab')}"]`)).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsh-sidebar-width')).toBe('')
  })

  it('the retry button recovers a tab whose crash has since been fixed', () => {
    // A PERSISTENT render error reaches the boundary strip (React 18.2
    // auto-recovers transient throws — one bad render followed by a good
    // retry is swallowed as a recoverable error and never shows a strip).
    let shouldThrow = true
    const { container, service } = mountSidebar()
    service.registerTab({
      id: 'crash-until-fixed',
      title: 'Crash until fixed',
      component: () => {
        if (shouldThrow) throw new Error('transient')
        return createElement('div', null, 'recovered')
      },
    })
    act(() => { service.openTab({ type: 'crash-until-fixed', title: 'Crash until fixed' }) })
    expect(container.textContent).toContain('transient')
    const retry = [...container.querySelectorAll('button')]
      .find(button => button.textContent === t('terminalRetry'))
    expect(retry).toBeDefined()
    // The crash condition is gone (e.g. the data arrived): the retry button
    // remounts the tab's content and the strip clears.
    shouldThrow = false
    act(() => { retry!.click() })
    expect(container.textContent).toContain('recovered')
    expect(container.textContent).not.toContain('transient')
  })
})
