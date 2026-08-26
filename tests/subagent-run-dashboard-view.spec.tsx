// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SubagentView } from '../src/client/SubagentView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { AgentTimelineResult } from '../src/agent-timeline-routes.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

function makeList(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next: SidebarSessionList) {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

type ListStore = ReturnType<typeof makeList>

function makeCtx(list: ListStore, history: () => void = () => {}): Context {
  return {
    sessions: {
      list,
      setSubagentCatalogOpen: () => {},
      openSubagent: () => {},
      open: () => {},
      refreshSubagents: async () => {},
    },
    connection: {
      api: {
        subagents: {
          history: async () => {
            history()
            return { result: { ok: true, value: { events: [], hasMore: false } } }
          },
        },
      },
    },
  } as unknown as Context
}

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

const baseTimeline: AgentTimelineResult = {
  root: { sessionId: 'root', path: '/root', startedAt: 1_000, lastEventAt: 10_000 },
  asOfSeq: 10,
  agents: [
    {
      sessionId: 'child',
      parentSessionId: 'root',
      path: '/root/child',
      mode: 'continuable',
      label: 'worker',
      state: { residency: 'cold', lastTurn: 'idle' },
      modelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
      hasChildren: false,
      declaredAt: 2_000,
      declarationSeq: 1,
      statePoints: [
        { seq: 3, time: 3_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
        { seq: 4, time: 6_000, transition: 'became-cold', state: { residency: 'cold', lastTurn: 'idle' } },
      ],
    },
  ],
}

function baseSnapshot(): SidebarSessionList {
  return {
    current: 'root',
    byId: {
      root: { id: 'root', displayTitle: 'Root task', running: true },
      child: { id: 'child', displayTitle: 'Child task', origin: 'subagent', parentId: 'root', running: false },
    },
    subagentsByParent: {
      root: {
        state: 'ready',
        parentAvailable: true,
        error: null,
        entries: [
          { kind: 'child', id: 'child', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'worker' },
        ],
      },
    },
    jobsBySession: {},
  }
}

let fetchQueue: AgentTimelineResult[]
const fetchCalls: string[] = []

beforeEach(() => {
  fetchQueue = [baseTimeline]
  fetchCalls.length = 0
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? ''
    fetchCalls.push(method)
    if (method === 'agents.timeline') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: fetchQueue.shift() ?? baseTimeline }),
      } as unknown as Response
    }
    throw new Error(`unexpected fetch ${String(url)} ${String(init?.body)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 320 })
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    if (typeof options === 'number') this.scrollLeft = options
    else if (options?.left !== undefined) this.scrollLeft = options.left
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('Run Dashboard view', () => {
  it('renders root and agent rows from agents.timeline without polling old subagent history', async () => {
    const list = makeList(baseSnapshot())
    const history = vi.fn()
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list, history), store }),
    )

    await act(async () => {})

    expect(fetchCalls).toEqual(['agents.timeline'])
    expect(history).not.toHaveBeenCalled()
    expect(container.querySelector('[role="treegrid"]')?.textContent).toContain('Root task')
    expect(container.querySelector('[role="treegrid"]')?.textContent).toContain('worker')
    expect(container.textContent).toContain('已卸载')
    expect(container.textContent).toContain('active')
    expect(container.textContent).toContain('wall')
    expect(container.querySelectorAll('[data-segment-state="cold"]')).toHaveLength(1)
    unmount()
  })

  it('does not request a new timeline while the page is hidden', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: false, ctx: makeCtx(list), store }),
    )

    await act(async () => {})

    expect(fetchCalls).toEqual([])
    unmount()
  })

  it('keeps the original root path and end after the local now tick without refetching', async () => {
    vi.useFakeTimers()
    try {
      fetchQueue = [{
        ...baseTimeline,
        root: {
          sessionId: 'root',
          path: '/restored-root',
          startedAt: 1_111,
          lastEventAt: 9_999,
        },
      } as unknown as AgentTimelineResult]
      const snapshot = baseSnapshot()
      snapshot.byId.root = { ...snapshot.byId.root!, running: false }
      const list = makeList(snapshot)
      const store = createSidebarStore()
      store.setSession('root')
      const { container, unmount } = mount(
        createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
      )
      await act(async () => {})

      expect(fetchCalls).toEqual(['agents.timeline'])
      expect(container.textContent).toContain('/restored-root')
      expect(container.textContent).not.toContain('/root · end')

      await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })

      expect(fetchCalls).toEqual(['agents.timeline'])
      expect(container.textContent).toContain('/restored-root')
      expect(container.textContent).toContain(new Date(9_999).toLocaleTimeString())
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports splitter keyboard resizing through persisted sidebar state', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})
    const separator = container.querySelector('[role="separator"]') as HTMLElement
    expect(separator.getAttribute('aria-valuemin')).toBe('128')
    const before = store.getSnapshot().state!.runDashboardTreeWidth

    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    expect(store.getSnapshot().state!.runDashboardTreeWidth).toBe(before + 16)
    expect(separator.getAttribute('aria-valuenow')).toBe(String(before + 16))
    unmount()
  })

  it('supports splitter pointer dragging through persisted sidebar state', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})
    const separator = container.querySelector('[role="separator"]') as HTMLElement
    const before = store.getSnapshot().state!.runDashboardTreeWidth

    await act(async () => {
      separator.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 42, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    expect(store.getSnapshot().state!.runDashboardTreeWidth).toBe(before + 32)
    expect(separator.getAttribute('aria-valuenow')).toBe(String(before + 32))
    unmount()
  })

  it('keeps user viewport on refresh, rejects lower asOfSeq responses, and offers zoom, pan, fit, and now', async () => {
    fetchQueue = [
      baseTimeline,
      { ...baseTimeline, asOfSeq: 9, agents: [] },
      { ...baseTimeline, asOfSeq: 12, root: { ...baseTimeline.root, lastEventAt: 20_000 } },
    ]
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})
    const scroller = container.querySelector('[data-timeline-scroller]') as HTMLElement
    const zoomIn = container.querySelector('button[aria-label="放大"]') as HTMLButtonElement
    const panRight = container.querySelector('button[aria-label="向右平移"]') as HTMLButtonElement
    const fit = container.querySelector('button[aria-label="适配全部"]') as HTMLButtonElement
    const now = container.querySelector('button[aria-label="回到现在"]') as HTMLButtonElement

    await act(async () => { zoomIn.click() })
    const zoomedWidth = Number((container.querySelector('[data-timeline-canvas]') as HTMLElement).dataset.timelineWidth)
    scroller.scrollLeft = 40
    await act(async () => { list.set({ ...baseSnapshot(), byId: { ...baseSnapshot().byId, child: { ...baseSnapshot().byId.child!, running: true } } }) })
    await act(async () => {})

    expect(container.textContent).toContain('worker')
    expect(scroller.scrollLeft).toBe(40)
    expect(Number((container.querySelector('[data-timeline-canvas]') as HTMLElement).dataset.timelineWidth)).toBe(zoomedWidth)

    await act(async () => { panRight.click() })
    expect(scroller.scrollLeft).toBeGreaterThan(40)
    await act(async () => { fit.click() })
    expect(scroller.scrollLeft).toBe(0)
    await act(async () => { now.click() })
    expect(scroller.scrollLeft).toBeGreaterThan(0)
    unmount()
  })

  it('renders the mobile fallback list without the shared gantt area', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    expect(container.querySelector('[data-mobile-run-dashboard]')).not.toBeNull()
    expect(container.querySelector('[data-timeline-scroller]')).toBeNull()
    expect(container.textContent).toContain('segments')
    expect(container.textContent).toContain('active')
    unmount()
  })
})
