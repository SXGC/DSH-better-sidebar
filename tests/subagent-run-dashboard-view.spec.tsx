// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SubagentView } from '../src/client/SubagentView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { timelineTicks } from '../src/client/agent-timeline.ts'
import type { AgentDetailResult, AgentTimelineResult } from '../src/agent-timeline-routes.ts'
import type { Context, SidebarJobView, SidebarSessionList } from '../src/context-types.ts'

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

function makeCtx(
  list: ListStore,
  history: () => void = () => {},
  controls: Partial<Context['sessions']> = {},
): Context {
  return {
    sessions: {
      list,
      setSubagentCatalogOpen: () => {},
      openSubagent: () => {},
      open: () => {},
      refreshSubagents: async () => {},
      ...controls,
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

function mount(node: ReactNode): { container: HTMLDivElement; render: (next: ReactNode) => void; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    render: (next: ReactNode) => {
      act(() => { root.render(next) })
    },
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

/**
 * The dashboard picks its layout from the PANEL width, not the window: the
 * split tree + gantt canvas only appears once the panel can carry both.
 * Gantt-specific tests must therefore widen the panel explicitly.
 */
function wideStore(width = 900) {
  const store = createSidebarStore()
  store.setSession('root')
  store.update((draft) => { draft.width = width })
  return store
}

let fetchQueue: AgentTimelineResult[]
let detailQueue: AgentDetailResult[]
let detailFailures: number
const fetchCalls: string[] = []
const scrollIntoViewTargets: Element[] = []

beforeEach(() => {
  localStorage.clear()
  fetchQueue = [baseTimeline]
  const detail: AgentDetailResult = {
    sessionId: 'child',
    initialTask: { available: true, text: 'build <strong>needle</strong>\nsecond block' },
    backend: 'subagent-next',
    forkTurns: 'none',
    requestedModelSelection: { provider: 'deepseek', model: 'gpt-5.5', reasoningEffort: 'high' },
    effectiveModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
    allowedTools: ['bash', 'read'],
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    filesystemPolicy: 'closed',
  }
  detailQueue = [detail, detail]
  detailFailures = 0
  fetchCalls.length = 0
  scrollIntoViewTargets.length = 0
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrollIntoViewTargets.push(this)
  }
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
    if (method === 'agents.detail') {
      if (detailFailures > 0) {
        detailFailures -= 1
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error: { code: 'internal', message: 'detail temporarily unavailable' } }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: detailQueue.shift() ?? detailQueue[0] }),
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
  localStorage.clear()
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
    expect(container.textContent).toContain('活跃时长')
    expect(container.textContent).toContain('墙钟')
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

      // The path lives in the title tooltip now, not in the row text.
      const rootTitle = () => container.querySelector('[data-run-dashboard-row-id="root"] [title*="/restored-root"]')
      expect(fetchCalls).toEqual(['agents.timeline'])
      expect(rootTitle()).not.toBeNull()
      expect(container.textContent).not.toContain('/root · end')

      await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })

      expect(fetchCalls).toEqual(['agents.timeline'])
      expect(rootTitle()).not.toBeNull()
      expect(container.textContent).toContain(new Date(9_999).toLocaleTimeString())
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports splitter keyboard resizing through persisted sidebar state', async () => {
    const list = makeList(baseSnapshot())
    const store = wideStore()
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
    const store = wideStore()
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
    const store = wideStore()
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})
    const scroller = container.querySelector('[data-timeline-scroller]') as HTMLElement
    scroller.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
      if (typeof options === 'number') this.scrollLeft = options
      else if (options?.left !== undefined) this.scrollLeft = options.left
    }
    const zoomIn = container.querySelector('button[aria-label="放大"]') as HTMLButtonElement
    const panRight = container.querySelector('button[aria-label="向右平移"]') as HTMLButtonElement
    const fit = container.querySelector('button[aria-label="适配全部"]') as HTMLButtonElement
    const now = container.querySelector('button[aria-label="回到现在"]') as HTMLButtonElement

    await act(async () => { zoomIn.click() })
    await act(async () => {})
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

  it('fits all to the viewport: the drawn activity fills the panel and the blank tail stays off-screen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    try {
      const snapshot = baseSnapshot()
      snapshot.byId.root = { ...snapshot.byId.root!, running: false }
      const list = makeList(snapshot)
      const store = wideStore()
      const { container, unmount } = mount(
        createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
      )
      await act(async () => {})
      const scroller = container.querySelector('[data-timeline-scroller]') as HTMLElement
      scroller.scrollLeft = 40

      const fit = container.querySelector('button[aria-label="适配全部"]') as HTMLButtonElement
      await act(async () => { fit.click() })

      // The range runs to now=20_000 (the child's open cold tail) but drawn
      // activity ends at the root's 10_000. Fit stretches the canvas until
      // the active 9/19 of the range fills the stubbed 320px viewport minus
      // the 24px trailing padding; the blank tail scrolls off to the right.
      const width = Number((container.querySelector('[data-timeline-canvas]') as HTMLElement).dataset.timelineWidth)
      expect(width).toBe(Math.round((19_000 / 9_000) * (320 - 24)))
      expect(scroller.scrollLeft).toBe(0)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the mobile fallback list with the same row actions but without the shared gantt area', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    fetchQueue = [{
      ...baseTimeline,
      agents: baseTimeline.agents.map(agent => ({
        ...agent,
        state: { residency: 'live', turn: { kind: 'running' } },
        statePoints: [
          ...agent.statePoints,
          { seq: 5, time: 7_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
        ],
      })),
    }]
    const snapshot = baseSnapshot()
    snapshot.jobsBySession = {
      root: [
        { id: 'bash-mobile', kind: 'bash', label: 'mobile job', status: 'running', startedAt: 1_000 },
      ],
    }
    const list = makeList(snapshot)
    const store = createSidebarStore()
    store.setSession('root')
    const openChild = vi.fn()
    const openSubagent = vi.fn()
    const interruptSubagent = vi.fn(async () => 'accepted' as const)
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root',
        active: true,
        ctx: makeCtx(list, () => {}, { interruptSubagent, openSubagent } as Partial<Context['sessions']>),
        store,
        onOpenChild: openChild,
      }),
    )
    await act(async () => {})

    expect(container.querySelector('[data-run-dashboard-list]')).not.toBeNull()
    expect(container.querySelector('[data-timeline-scroller]')).toBeNull()
    // The full path rides the title tooltip; the row text keeps the leaf only.
    expect(container.querySelector('[data-run-dashboard-row-id="child"] [title*="/root/child"]')).not.toBeNull()
    expect(container.textContent).toContain('活跃时长')
    expect(container.textContent).toContain('后台任务')
    expect(container.textContent).toContain('mobile job')
    await act(async () => {
      ;(container.querySelector('button[aria-label="打开聊天 worker"]') as HTMLButtonElement).click()
    })
    expect(openChild).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    })
    // The shell hook only ARMS the jump-back; the official switch must still
    // fire or the button is a no-op.
    expect(openSubagent).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    })

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(fetchCalls).toEqual(['agents.timeline', 'agents.detail'])
    expect(container.textContent).toContain('build <strong>needle</strong>')

    const interrupt = container.querySelector('button[aria-label="中断 worker"]') as HTMLButtonElement
    expect(interrupt.disabled).toBe(false)
    await act(async () => { interrupt.click() })
    expect(interruptSubagent).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    })

    await act(async () => {
      ;(container.querySelector('button[aria-label="定位 owner Root task"]') as HTMLButtonElement).click()
    })
    const rootRow = container.querySelector('[data-run-dashboard-row-id="root"]') as HTMLElement
    expect(rootRow.dataset.ownerHighlighted).toBe('true')
    expect(scrollIntoViewTargets).toContain(rootRow)
    unmount()
  })

  it('keeps filters, owner location, details, refresh, and viewport controls stable at 100 agents and 100 jobs over 24h', async () => {
    const day = 24 * 60 * 60 * 1_000
    const states = [
      { residency: 'live', turn: { kind: 'provisioning' } },
      { residency: 'live', turn: { kind: 'running' } },
      { residency: 'live', turn: { kind: 'waiting', reason: 'mailbox', since: 0, deadline: 0 } },
      { residency: 'live', turn: { kind: 'idle' } },
      { residency: 'live', turn: { kind: 'completed' } },
      { residency: 'live', turn: { kind: 'interrupted' } },
      { residency: 'live', turn: { kind: 'errored', code: 'E_SCALE' } },
      { residency: 'cold', lastTurn: 'idle' },
      { residency: 'closed' },
    ] satisfies AgentTimelineResult['agents'][number]['state'][]
    const largeTimeline = (asOfSeq: number): AgentTimelineResult => ({
      root: { sessionId: 'root', path: '/root', startedAt: 1_000, lastEventAt: 1_000 + day + 90_000 },
      asOfSeq,
      agents: Array.from({ length: 100 }, (_, index) => {
        const declaredAt = 10_000 + index * 60_000
        const state = states[index % states.length]!
        return {
          sessionId: `agent-${index}`,
          parentSessionId: 'root',
          path: `/root/agent-${index}`,
          mode: 'continuable',
          label: `Worker ${index}`,
          state,
          modelSelection: { provider: 'deepseek', model: index % 2 === 0 ? 'gpt-5.5' : 'gpt-5.5-mini' },
          hasChildren: false,
          declaredAt,
          declarationSeq: index + 1,
          statePoints: [
            { seq: 200 + index * 3, time: declaredAt + 1_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
            { seq: 201 + index * 3, time: declaredAt + 2 * 60 * 60 * 1_000, transition: 'became-cold', state: { residency: 'cold', lastTurn: 'idle' } },
            { seq: 202 + index * 3, time: declaredAt + 3 * 60 * 60 * 1_000, transition: 'ready', state },
          ],
        }
      }),
    })
    const byId: SidebarSessionList['byId'] = { root: { id: 'root', displayTitle: 'Root task', running: false } }
    for (let index = 0; index < 100; index += 1) {
      byId[`agent-${index}`] = {
        id: `agent-${index}`,
        displayTitle: `Agent ${index}`,
        origin: 'subagent',
        parentId: 'root',
        running: index % 3 === 0,
      }
    }
    const jobsBySession: Record<string, SidebarJobView[]> = {
      root: [{ id: 'job-root', kind: 'bash', label: 'scale job root', status: 'running', startedAt: 1_000 }],
    }
    for (let index = 0; index < 99; index += 1) {
      jobsBySession[`agent-${index}`] = [{
        id: `job-${index}`,
        kind: index % 2 === 0 ? 'bash' : 'python',
        label: `scale job ${index}`,
        status: index % 2 === 0 ? 'running' : 'completed',
        startedAt: 1_000 + index,
        ...(index % 2 === 0 ? {} : { finishedAt: 2_000 + index }),
      }]
    }
    fetchQueue = [largeTimeline(100), largeTimeline(101)]
    const list = makeList({
      current: 'root',
      byId,
      subagentsByParent: {
        root: {
          state: 'ready',
          parentAvailable: true,
          error: null,
          entries: Array.from({ length: 100 }, (_, index) => ({
            kind: 'child',
            id: `agent-${index}`,
            activity: index % 3 === 0 ? 'running' : 'inactive',
            hasChildren: false,
            mode: 'continuable',
            label: `Worker ${index}`,
          })),
        },
      },
      jobsBySession,
    })
    const store = wideStore()
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    expect(container.querySelectorAll('[data-run-dashboard-row-id]')).toHaveLength(101)
    expect(container.querySelectorAll('button[aria-label*="scale job"]')).toHaveLength(100)
    expect(container.textContent).toContain('100 个后台任务')
    for (const label of ['创建中', '运行中', '等待中', '空闲', '已完成', '已中断', '出错', '已卸载', '已关闭']) {
      expect(container.textContent).toContain(label)
    }
    expect(Number((container.querySelector('[data-timeline-canvas]') as HTMLElement).dataset.timelineRangeMs)).toBeGreaterThan(day)

    const scroller = container.querySelector('[data-timeline-scroller]') as HTMLElement
    scroller.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
      if (typeof options === 'number') this.scrollLeft = options
      else if (options?.left !== undefined) this.scrollLeft = options.left
    }
    await act(async () => {
      ;(container.querySelector('button[aria-label="放大"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    scroller.scrollLeft = 77
    await act(async () => {
      ;(container.querySelector('button[aria-label="刷新"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(scroller.scrollLeft).toBe(77)
    await act(async () => {
      ;(container.querySelector('button[aria-label="向右平移"]') as HTMLButtonElement).click()
    })
    expect(scroller.scrollLeft).toBeGreaterThan(77)

    const pathFilter = container.querySelector('[aria-label="路径筛选"]') as HTMLInputElement
    await act(async () => {
      pathFilter.value = '/root/agent-99'
      pathFilter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-run-dashboard-row-id="root"]')).not.toBeNull()
    expect(container.querySelector('[data-run-dashboard-row-id="agent-99"]')).not.toBeNull()
    expect(container.querySelector('[data-run-dashboard-row-id="agent-1"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[aria-label="定位 owner Agent 98"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(pathFilter.value).toBe('')
    expect((container.querySelector('[data-run-dashboard-row-id="agent-98"]') as HTMLElement).dataset.ownerHighlighted).toBe('true')
    expect((container.querySelector('[data-run-dashboard-lane-id="agent-98"]') as HTMLElement).dataset.ownerHighlighted).toBe('true')
    expect(scrollIntoViewTargets.some(target => (target as HTMLElement).dataset.runDashboardRowId === 'agent-98')).toBe(true)

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 Worker 99"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(fetchCalls).toContain('agents.detail')
    expect(container.textContent).toContain('build <strong>needle</strong>')
    unmount()
  })

  it('filters by status, model, path, text, and long-running while keeping ancestors', async () => {
    fetchQueue = [{
      root: { sessionId: 'root', path: '/root', startedAt: 1_000, lastEventAt: 2_000 },
      asOfSeq: 20,
      agents: [
        {
          sessionId: 'parent',
          parentSessionId: 'root',
          path: '/root/parent',
          mode: 'continuable',
          label: 'parent',
          state: { residency: 'live', turn: { kind: 'idle' } },
          modelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
          hasChildren: true,
          declaredAt: 1_000,
          declarationSeq: 1,
          statePoints: [{ seq: 2, time: 1_100, transition: 'ready', state: { residency: 'live', turn: { kind: 'idle' } } }],
        },
        {
          sessionId: 'match',
          parentSessionId: 'parent',
          path: '/root/parent/needle-path',
          mode: 'continuable',
          label: 'Needle task',
          state: { residency: 'live', turn: { kind: 'running' } },
          modelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
          hasChildren: false,
          declaredAt: 2_000,
          declarationSeq: 2,
          statePoints: [{ seq: 3, time: 2_100, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } }],
        },
        {
          sessionId: 'sibling',
          parentSessionId: 'root',
          path: '/root/sibling',
          mode: 'continuable',
          label: 'Sibling',
          state: { residency: 'live', turn: { kind: 'running' } },
          modelSelection: { provider: 'other', model: 'small' },
          hasChildren: false,
          declaredAt: 3_000,
          declarationSeq: 3,
          statePoints: [{ seq: 4, time: 3_100, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } }],
        },
      ],
    }]
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
    await act(async () => {
      byLabel('状态筛选').value = 'running'
      byLabel('状态筛选').dispatchEvent(new Event('change', { bubbles: true }))
      byLabel('模型筛选').value = 'gpt-5.5'
      byLabel('模型筛选').dispatchEvent(new Event('input', { bubbles: true }))
      byLabel('路径筛选').value = 'needle-path'
      byLabel('路径筛选').dispatchEvent(new Event('input', { bubbles: true }))
      byLabel('文本筛选').value = 'Needle'
      byLabel('文本筛选').dispatchEvent(new Event('input', { bubbles: true }))
      ;(byLabel('仅长运行') as HTMLInputElement).checked = true
      byLabel('仅长运行').dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.querySelector('[role="treegrid"]')?.textContent).toContain('parent')
    expect(container.querySelector('[role="treegrid"]')?.textContent).toContain('Needle task')
    expect(container.querySelector('[role="treegrid"]')?.textContent).not.toContain('Sibling')
    unmount()
  })

  it('loads whitelisted details, renders task text as text, and clears details when the root changes', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, render, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(fetchCalls).toEqual(['agents.timeline', 'agents.detail'])
    expect(container.textContent).toContain('build <strong>needle</strong>')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toContain('subagent-next')
    expect(container.textContent).toContain('workspace-write')
    expect(container.textContent).not.toContain('credentialRef')
    expect(container.textContent).not.toContain('operationId')

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 worker"]') as HTMLButtonElement).click()
    })

    expect(fetchCalls).toEqual(['agents.timeline', 'agents.detail'])
    expect(container.textContent).not.toContain('build <strong>needle</strong>')

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(fetchCalls).toEqual(['agents.timeline', 'agents.detail', 'agents.detail'])
    expect(container.textContent).toContain('build <strong>needle</strong>')

    const nextList = baseSnapshot()
    nextList.current = 'other'
    nextList.byId = { other: { id: 'other', displayTitle: 'Other root', running: true } }
    nextList.subagentsByParent = {}
    list.set(nextList)
    render(createElement(SubagentView, { sessionId: 'other', active: true, ctx: makeCtx(list), store }))

    expect(container.textContent).not.toContain('build <strong>needle</strong>')
    unmount()
  })

  it('shows task-unavailable detail state and lets the user retry failed detail reads', async () => {
    detailFailures = 1
    detailQueue = [{
      sessionId: 'child',
      initialTask: { available: false, reason: 'not-accepted' },
      backend: 'subagent-next',
      forkTurns: 'none',
      requestedModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
      effectiveModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
      allowedTools: [],
      sandboxMode: null,
      approvalPolicy: null,
      filesystemPolicy: 'closed',
    }]
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="查看详情 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(container.textContent).toContain('detail temporarily unavailable')
    await act(async () => {
      const retry = [...container.querySelectorAll('button')].find(button => button.textContent === '重试')
      expect(retry).toBeDefined()
      retry!.click()
    })
    await act(async () => {})

    expect(container.textContent).toContain('初始任务不可用（创建前失败）')
    unmount()
  })

  it('opens a recoverable descendant chat from the dashboard row', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const openChild = vi.fn()
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root',
        active: true,
        ctx: makeCtx(list),
        store,
        onOpenChild: openChild,
      }),
    )
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="打开聊天 worker"]') as HTMLButtonElement).click()
    })

    expect(openChild).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    })
    unmount()
  })

  it('opens nested descendants by direct parent but controls them through the root with localized feedback', async () => {
    fetchQueue = [{
      root: { sessionId: 'root', path: '/root', startedAt: 1_000, lastEventAt: 4_000 },
      asOfSeq: 30,
      agents: [
        {
          sessionId: 'parent',
          parentSessionId: 'root',
          path: '/root/parent',
          mode: 'continuable',
          label: 'Parent',
          state: { residency: 'live', turn: { kind: 'idle' } },
          modelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
          hasChildren: true,
          declaredAt: 1_000,
          declarationSeq: 1,
          statePoints: [{ seq: 2, time: 1_100, transition: 'ready', state: { residency: 'live', turn: { kind: 'idle' } } }],
        },
        {
          sessionId: 'grandchild',
          parentSessionId: 'parent',
          path: '/root/parent/grandchild',
          mode: 'continuable',
          label: 'Grandchild',
          state: { residency: 'live', turn: { kind: 'running' } },
          modelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
          hasChildren: false,
          declaredAt: 2_000,
          declarationSeq: 2,
          statePoints: [{ seq: 3, time: 2_100, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } }],
        },
      ],
    }]
    const snapshot = baseSnapshot()
    snapshot.byId = {
      root: { id: 'root', displayTitle: 'Root task', running: true },
      parent: { id: 'parent', displayTitle: 'Parent task', origin: 'subagent', parentId: 'root', running: true },
      grandchild: { id: 'grandchild', displayTitle: 'Grandchild task', origin: 'subagent', parentId: 'parent', running: true },
    }
    snapshot.subagentsByParent = {
      root: {
        state: 'ready',
        parentAvailable: true,
        error: null,
        entries: [
          { kind: 'child', id: 'parent', activity: 'running', hasChildren: true, mode: 'continuable', label: 'Parent' },
        ],
      },
      parent: {
        state: 'ready',
        parentAvailable: true,
        error: null,
        entries: [
          { kind: 'child', id: 'grandchild', activity: 'running', hasChildren: false, mode: 'continuable', label: 'Grandchild' },
        ],
      },
    }
    const list = makeList(snapshot)
    const store = createSidebarStore()
    store.setSession('root')
    const openChild = vi.fn()
    const interruptSubagent = vi.fn(async () => 'not-live' as const)
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root',
        active: true,
        ctx: makeCtx(list, () => {}, { interruptSubagent } as Partial<Context['sessions']>),
        store,
        onOpenChild: openChild,
      }),
    )
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="打开聊天 Grandchild"]') as HTMLButtonElement).click()
    })
    expect(openChild).toHaveBeenCalledWith({
      parentSessionId: 'parent',
      childSessionId: 'grandchild',
      mode: 'continuable',
    })

    await act(async () => {
      ;(container.querySelector('button[aria-label="中断 Grandchild"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(interruptSubagent).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'grandchild',
      mode: 'continuable',
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('代理当前不可中断或关闭')
    expect(container.textContent).not.toContain('not-live')
    unmount()
  })

  it('interrupts and closes continuable agents with result feedback and close confirmation surviving refresh', async () => {
    fetchQueue = [
      {
        ...baseTimeline,
        agents: [{
          ...baseTimeline.agents[0]!,
          state: { residency: 'live', turn: { kind: 'running' } },
          statePoints: [
            { seq: 3, time: 3_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
          ],
        }],
      },
      {
        ...baseTimeline,
        asOfSeq: 11,
        agents: [{
          ...baseTimeline.agents[0]!,
          state: { residency: 'live', turn: { kind: 'running' } },
          statePoints: [
            { seq: 3, time: 3_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
          ],
        }],
      },
    ]
    const list = makeList(baseSnapshot())
    const interruptSubagent = vi.fn(async () => 'accepted' as const)
    const closeSubagent = vi.fn(async () => 'closed' as const)
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, {
        sessionId: 'root',
        active: true,
        ctx: makeCtx(list, () => {}, { interruptSubagent, closeSubagent } as Partial<Context['sessions']>),
        store,
      }),
    )
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="中断 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(interruptSubagent).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    })
    expect(container.textContent).toContain('已请求中断代理')

    await act(async () => {
      ;(container.querySelector('button[aria-label="关闭 worker"]') as HTMLButtonElement).click()
    })
    expect(closeSubagent).not.toHaveBeenCalled()

    await act(async () => {
      ;(container.querySelector('button[aria-label="刷新"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    await act(async () => {
      ;(container.querySelector('button[aria-label="确认关闭 worker"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(closeSubagent).toHaveBeenCalledWith({
      parentSessionId: 'root',
      childSessionId: 'child',
      mode: 'continuable',
    }, expect.any(String))
    expect(container.textContent).toContain('代理已关闭')
    expect(container.textContent).not.toContain('restart')
    expect(container.textContent).not.toContain('重新运行')
    unmount()
  })
  it('picks its layout from the panel width, not the window width, and follows a resize', async () => {
    // The regression: a 360px sidebar inside a 900px window used to claim the
    // desktop split, so the tree column ate the canvas and both were stubs.
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    store.update((draft) => { draft.width = 360 })
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    expect(window.innerWidth).toBe(900)
    expect(container.querySelector('[data-run-dashboard-list]')).not.toBeNull()
    expect(container.querySelector('[data-timeline-scroller]')).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
    // The viewport controls only exist next to a canvas they can move.
    expect(container.querySelector('button[aria-label="放大"]')).toBeNull()
    // Every row still carries its comparable span as a spark strip.
    expect(container.querySelectorAll('[data-segment-state]').length).toBeGreaterThan(0)

    await act(async () => { store.update((draft) => { draft.width = 900 }) })

    expect(container.querySelector('[data-run-dashboard-list]')).toBeNull()
    expect(container.querySelector('[data-timeline-scroller]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="放大"]')).not.toBeNull()

    await act(async () => { store.update((draft) => { draft.width = 360 }) })
    expect(container.querySelector('[data-run-dashboard-list]')).not.toBeNull()
    unmount()
  })

  it('exposes tree depth on every row so nesting is not invisible', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const root = container.querySelector('[data-run-dashboard-row-id="root"]') as HTMLElement
    const child = container.querySelector('[data-run-dashboard-row-id="child"]') as HTMLElement
    expect(root.style.getPropertyValue('--run-depth')).toBe('0')
    expect(child.style.getPropertyValue('--run-depth')).toBe('1')
    expect(root.getAttribute('aria-level')).toBe('1')
    expect(child.getAttribute('aria-level')).toBe('2')
    unmount()
  })

  it('positions every axis stamp and gridline on its own tick ratio', async () => {
    const list = makeList(baseSnapshot())
    const store = wideStore()
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const canvas = container.querySelector('[data-timeline-canvas]') as HTMLElement
    const width = Number(canvas.dataset.timelineWidth)
    const range = Number(canvas.dataset.timelineRangeMs)
    const expected = timelineTicks({ start: 0, end: range }, width)
    const stamps = [...canvas.querySelectorAll<HTMLElement>('[data-timeline-tick]')]
    const gridlines = [...canvas.querySelectorAll<HTMLElement>('[data-timeline-gridline]')]

    expect(stamps).toHaveLength(expected.length)
    expect(gridlines).toHaveLength(expected.length)
    // A stamp laid out by the flow would ignore `left` entirely, which is how
    // the axis silently drifted away from the bars it labels.
    for (const stamp of stamps) expect(stamp.style.left).toMatch(/%$/)
    for (const line of gridlines) expect(line.style.left).toMatch(/%$/)
    expect(stamps.map(stamp => stamp.style.left)).toEqual(gridlines.map(line => line.style.left))
    unmount()
  })

  it('signals status by shape and word, not colour alone, on every row', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    // Shape channel: every row carries a per-state mark that survives
    // greyscale and colour-blind rendering.
    const marks = [...container.querySelectorAll<HTMLElement>('[data-run-dashboard-row-id] [data-shape]')]
    expect(marks.map(mark => mark.dataset.shape)).toEqual(['running', 'cold'])
    // Word channel: the active root spells its state beside the duration; the
    // settled child keeps the word for readers and tooltips instead of the row.
    const rootRow = container.querySelector('[data-run-dashboard-row-id="root"]') as HTMLElement
    const childRow = container.querySelector('[data-run-dashboard-row-id="child"]') as HTMLElement
    const rootStatus = rootRow.querySelector('[data-status-tier]') as HTMLElement
    const childStatus = childRow.querySelector('[data-status-tier]') as HTMLElement
    expect(rootStatus.dataset.statusTier).toBe('active')
    expect(rootStatus.textContent).toContain('运行中')
    expect(childStatus.dataset.statusTier).toBe('muted')
    expect(childStatus.textContent).toContain('已卸载')
    expect(childStatus.title).toContain('已卸载')
    unmount()
  })

  it('marks open-ended spans and keeps the narrow spark strip wordless', async () => {
    fetchQueue = [{
      ...baseTimeline,
      agents: baseTimeline.agents.map(agent => ({
        ...agent,
        state: { residency: 'live', turn: { kind: 'running' } },
        statePoints: [
          { seq: 3, time: 3_000, transition: 'turn-started', state: { residency: 'live', turn: { kind: 'running' } } },
        ],
      })),
    }] as AgentTimelineResult[]
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, render, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const sparkSegments = [...container.querySelectorAll<HTMLElement>('[data-segment-state]')]
    expect(sparkSegments.length).toBeGreaterThan(0)
    // A still-running span has no right edge to draw.
    expect(sparkSegments.some(segment => segment.dataset.segmentOpen === 'true')).toBe(true)
    // Words inside a 6px strip are the "table fragment" look: never there.
    for (const segment of sparkSegments) expect(segment.textContent).toBe('')

    await act(async () => { store.update((draft) => { draft.width = 900 }) })
    render(createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }))
    await act(async () => {})

    const laneSegments = [...container.querySelectorAll<HTMLElement>('[data-run-dashboard-lane-id] [data-segment-state]')]
    expect(laneSegments.length).toBeGreaterThan(0)
    // The wide canvas has room, so a bar wide enough carries its state word.
    expect(laneSegments.some(segment => segment.textContent !== '')).toBe(true)
    unmount()
  })

  it('keeps the duration on the row and demotes the raw clock figures', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const child = container.querySelector('[data-run-dashboard-row-id="child"]') as HTMLElement
    const durations = [...child.querySelectorAll<HTMLElement>('[title*="墙钟"]')]
    // Exactly one element carries the full active/wall/segments summary as a
    // tooltip; the row itself shows a single number.
    expect(durations.length).toBeGreaterThan(0)
    expect(durations[0]?.title).toContain('活跃')
    expect(durations[0]?.title).toContain('段')
    expect(durations[0]?.textContent).toContain('活跃时长')
    expect(durations[0]?.textContent).toContain('4 秒')
    // The clock span stays announced and hoverable, just not competing.
    expect(child.textContent).toContain('墙钟')
    unmount()
  })

  it('keeps the crowded filters mounted and labelled behind a disclosure', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const more = container.querySelector('details') as HTMLDetailsElement
    expect(more).not.toBeNull()
    expect(more.open).toBe(false)
    expect(more.textContent).toContain('更多筛选')
    // Text + status are the two that always fit a 360px row.
    const search = container.querySelector('[aria-label="文本筛选"]') as HTMLInputElement
    const state = container.querySelector('[aria-label="状态筛选"]') as HTMLSelectElement
    expect(more.contains(search)).toBe(false)
    expect(more.contains(state)).toBe(false)
    // The rest stay in the DOM, addressable, and still filter while collapsed.
    for (const label of ['模型筛选', '路径筛选', '仅长运行']) {
      const field = container.querySelector(`[aria-label="${label}"]`) as HTMLElement
      expect(field).not.toBeNull()
      expect(more.contains(field)).toBe(true)
    }
    expect(container.textContent).not.toContain('项生效')

    const path = container.querySelector('[aria-label="路径筛选"]') as HTMLInputElement
    await act(async () => {
      path.value = '/root/child'
      path.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-run-dashboard-row-id="child"]')).not.toBeNull()
    // Collapsed filters must announce that they are narrowing the tree.
    expect(container.textContent).toContain('1 项生效')

    await act(async () => {
      search.value = 'worker'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('2 项生效')
    unmount()
  })

  it('gives each row a labelled action group and only renders applicable controls', async () => {
    const list = makeList(baseSnapshot())
    const store = createSidebarStore()
    store.setSession('root')
    const { container, unmount } = mount(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(list), store }),
    )
    await act(async () => {})

    const child = container.querySelector('[data-run-dashboard-row-id="child"]') as HTMLElement
    const group = child.querySelector('[role="group"]') as HTMLElement
    expect(group.getAttribute('aria-label')).toBe('worker 的操作')
    // Open/details are always offered; a cold agent can never be interrupted,
    // so no dead "中断" button is rendered — close (recoverable) remains.
    for (const label of ['打开聊天 worker', '查看详情 worker', '关闭 worker']) {
      expect(container.querySelector(`button[aria-label="${label}"]`)).not.toBeNull()
    }
    expect(container.querySelector('button[aria-label="中断 worker"]')).toBeNull()
    // The destructive control sits apart from open/details in its own span.
    const close = container.querySelector('button[aria-label="关闭 worker"]') as HTMLElement
    expect(close.parentElement).not.toBe(group)
    expect(group.contains(close)).toBe(true)
    unmount()
  })
})
