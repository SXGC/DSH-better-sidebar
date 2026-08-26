// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SubagentView } from '../src/client/SubagentView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { AgentDetailResult, AgentTimelineResult } from '../src/agent-timeline-routes.ts'
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

let fetchQueue: AgentTimelineResult[]
let detailQueue: AgentDetailResult[]
let detailFailures: number
const fetchCalls: string[] = []

beforeEach(() => {
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
})
