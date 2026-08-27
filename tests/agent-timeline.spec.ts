import { describe, expect, it } from 'vitest'
import {
  buildTimelineDisplay,
  countActiveFilters,
  filterTimelineDisplay,
  formatAgentState,
  normalizeLongRunningMinutes,
  timelineContentEnd,
  type TimelineDisplayRow,
} from '../src/client/agent-timeline.ts'
import type { AgentState, AgentTimelineResult, AgentTimelineRow } from '../src/agent-timeline-routes.ts'
import type { SidebarSubagentCatalog } from '../src/context-types.ts'

const model = { provider: 'deepseek', model: 'gpt-5.5' }

function state(kind: 'provisioning' | 'running' | 'idle' | 'completed' | 'interrupted' | 'errored'): AgentState {
  if (kind === 'errored') return { residency: 'live', turn: { kind, code: 'boom' } }
  return { residency: 'live', turn: kind === 'completed' ? { kind, stopReason: 'completed' } : { kind } } as AgentState
}

function agent(partial: Partial<AgentTimelineRow> & { sessionId: string; parentSessionId: string; path: string; declaredAt: number; declarationSeq: number }): AgentTimelineRow {
  return {
    mode: 'continuable',
    state: state('running'),
    modelSelection: model,
    hasChildren: false,
    statePoints: [],
    ...partial,
  }
}

function timeline(agents: AgentTimelineRow[]): AgentTimelineResult {
  return {
    root: { sessionId: 'root', path: '/root', startedAt: 1_000, lastEventAt: 20_000 },
    asOfSeq: 99,
    agents,
  }
}

function ids(rows: TimelineDisplayRow[]): string[] {
  return rows.map(row => row.id)
}

describe('agent timeline client projection', () => {
  it('does not invent a running root segment before the first turn starts', () => {
    const result: AgentTimelineResult = {
      root: { sessionId: 'root', path: '/root', startedAt: null, lastEventAt: 5_000 },
      asOfSeq: 3,
      agents: [],
    }

    const root = buildTimelineDisplay({ timeline: result, rootRunning: true, now: 20_000 }).rows[0]!

    expect(root.segments).toEqual([])
    expect(root.activeDurationMs).toBe(0)
    expect(root.wallDurationMs).toBe(0)
  })

  it('keeps root first, orders native descendants as a stable tree, and appends catalog-only descendants as diagnostics', () => {
    const result = timeline([
      agent({ sessionId: 'b', parentSessionId: 'root', path: '/root/b', declaredAt: 2_000, declarationSeq: 2 }),
      agent({ sessionId: 'a2', parentSessionId: 'a', path: '/root/a/a2', declaredAt: 4_000, declarationSeq: 4 }),
      agent({ sessionId: 'a1', parentSessionId: 'a', path: '/root/a/a1', declaredAt: 4_000, declarationSeq: 3 }),
      agent({ sessionId: 'a', parentSessionId: 'root', path: '/root/a', declaredAt: 1_500, declarationSeq: 1 }),
    ])
    const catalogs: Record<string, SidebarSubagentCatalog> = {
      root: {
        state: 'ready',
        parentAvailable: true,
        error: null,
        entries: [
          { kind: 'child', id: 'a', activity: 'running', hasChildren: true, mode: 'continuable' },
          { kind: 'child', id: 'legacy', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'legacy row' },
          { kind: 'diagnostic', id: 'broken', reason: 'corrupt' },
        ],
      },
    }

    const display = buildTimelineDisplay({
      timeline: result,
      catalogs,
      rootTitle: 'Root task',
      now: 30_000,
    })

    expect(ids(display.rows)).toEqual(['root', 'a', 'a1', 'a2', 'b', 'legacy', 'broken'])
    expect(display.rows.map(row => row.depth)).toEqual([0, 1, 2, 2, 1, 1, 1])
    expect(display.rows[0]).toMatchObject({ kind: 'root', title: 'Root task', path: '/root' })
    const legacy = display.rows.find(row => row.id === 'legacy')!
    expect(legacy).toMatchObject({ kind: 'diagnostic', title: 'legacy row' })
    expect(legacy.path).toBeUndefined()
    expect(legacy.model).toBeUndefined()
    expect(legacy.startedAt).toBeUndefined()
  })

  it('builds ordered non-overlapping live/cold/live/closed segments and separates active from wall duration', () => {
    const result = timeline([
      agent({
        sessionId: 'worker',
        parentSessionId: 'root',
        path: '/root/worker',
        declaredAt: 1_000,
        declarationSeq: 1,
        state: { residency: 'closed' },
        statePoints: [
          { seq: 2, time: 2_000, transition: 'turn-started', state: state('running') },
          { seq: 3, time: 5_000, transition: 'became-cold', state: { residency: 'cold', lastTurn: 'idle' } },
          { seq: 4, time: 8_000, transition: 'resumed', state: state('running') },
          { seq: 5, time: 12_000, transition: 'closed', state: { residency: 'closed' } },
        ],
      }),
    ])

    const row = buildTimelineDisplay({ timeline: result, now: 20_000 }).rows.find(item => item.id === 'worker')!

    expect(row.segments).toEqual([
      { start: 1_000, end: 2_000, state: state('provisioning') },
      { start: 2_000, end: 5_000, state: state('running') },
      { start: 5_000, end: 8_000, state: { residency: 'cold', lastTurn: 'idle' } },
      { start: 8_000, end: 12_000, state: state('running') },
      { start: 12_000, end: 12_000, state: { residency: 'closed' } },
    ])
    expect(row.activeDurationMs).toBe(8_000)
    expect(row.wallDurationMs).toBe(11_000)
  })

  it('leaves an open cold tail undrawn: durations and the end stamp stop where the agent went cold', () => {
    const result = timeline([
      agent({
        sessionId: 'cold-worker',
        parentSessionId: 'root',
        path: '/root/cold-worker',
        declaredAt: 1_000,
        declarationSeq: 1,
        state: { residency: 'cold', lastTurn: 'idle' },
        statePoints: [
          { seq: 2, time: 2_000, transition: 'turn-started', state: state('running') },
          { seq: 3, time: 5_000, transition: 'became-cold', state: { residency: 'cold', lastTurn: 'idle' } },
        ],
      }),
    ])

    const row = buildTimelineDisplay({ timeline: result, now: 11_000 }).rows.find(item => item.id === 'cold-worker')!

    expect(row.segments.at(-1)).toEqual({ start: 5_000, state: { residency: 'cold', lastTurn: 'idle' } })
    expect(row.activeDurationMs).toBe(4_000)
    expect(row.wallDurationMs).toBe(4_000)
    expect(row.endedAt).toBe(5_000)
  })

  it('grows wall duration with the clock only while the tail is still live', () => {
    const result = timeline([
      agent({
        sessionId: 'live-worker',
        parentSessionId: 'root',
        path: '/root/live-worker',
        declaredAt: 1_000,
        declarationSeq: 1,
        state: state('running'),
        statePoints: [
          { seq: 2, time: 2_000, transition: 'turn-started', state: state('running') },
        ],
      }),
    ])

    const row = buildTimelineDisplay({ timeline: result, now: 11_000 }).rows.find(item => item.id === 'live-worker')!

    expect(row.wallDurationMs).toBe(10_000)
    expect(row.endedAt).toBeUndefined()
  })

  it('reports the last drawn instant: open live tails run to now, open cold tails stop at their start', () => {
    const coldTail = {
      segments: [
        { start: 1_000, end: 4_000, state: state('running') },
        { start: 4_000, state: { residency: 'cold', lastTurn: 'idle' } },
      ],
    } as TimelineDisplayRow
    const liveTail = { segments: [{ start: 2_000, state: state('running') }] } as TimelineDisplayRow

    expect(timelineContentEnd([coldTail], 30_000)).toBe(4_000)
    expect(timelineContentEnd([coldTail, liveTail], 30_000)).toBe(30_000)
    expect(timelineContentEnd([], 30_000)).toBeUndefined()
  })

  it('formats all dashboard states including cold as unloaded in both locales', () => {
    expect(formatAgentState({ residency: 'cold', lastTurn: 'idle' }, 'zh')).toBe('已卸载')
    expect(formatAgentState({ residency: 'cold', lastTurn: 'idle' }, 'en')).toBe('Unloaded')
    expect([
      state('provisioning'),
      state('running'),
      { residency: 'live', turn: { kind: 'waiting', reason: 'mailbox', since: 1, deadline: 2 } } satisfies AgentState,
      state('idle'),
      state('completed'),
      state('interrupted'),
      state('errored'),
      { residency: 'closed' } satisfies AgentState,
    ].map(item => formatAgentState(item, 'en'))).toEqual([
      'Provisioning',
      'Running',
      'Waiting',
      'Idle',
      'Completed',
      'Interrupted',
      'Errored',
      'Closed',
    ])
  })

  it('marks long-running live agents with a configurable minutes threshold', () => {
    const result = timeline([
      agent({
        sessionId: 'slow',
        parentSessionId: 'root',
        path: '/root/slow',
        declaredAt: 1_000,
        declarationSeq: 1,
        statePoints: [
          { seq: 2, time: 2_000, transition: 'turn-started', state: state('running') },
        ],
      }),
    ])

    expect(normalizeLongRunningMinutes(undefined)).toBe(60)
    expect(normalizeLongRunningMinutes('bad')).toBe(60)
    expect(normalizeLongRunningMinutes(0)).toBe(0)
    expect(normalizeLongRunningMinutes(10_081)).toBe(60)
    expect(buildTimelineDisplay({ timeline: result, now: 62 * 60 * 1_000 }).rows.find(row => row.id === 'slow')?.longRunning).toBe(true)
    expect(buildTimelineDisplay({ timeline: result, now: 62 * 60 * 1_000, longRunningMinutes: 0 }).rows.find(row => row.id === 'slow')?.longRunning).toBe(false)
    expect(buildTimelineDisplay({ timeline: result, now: 31 * 60 * 1_000, longRunningMinutes: 30 }).rows.find(row => row.id === 'slow')?.longRunning).toBe(true)
  })

  it('filters by state, model, path, text, and long-running while retaining ancestors and spawn order', () => {
    const result = timeline([
      agent({
        sessionId: 'parent',
        parentSessionId: 'root',
        path: '/root/parent',
        label: 'Parent',
        declaredAt: 1_000,
        declarationSeq: 1,
        state: state('idle'),
        statePoints: [{ seq: 2, time: 1_100, transition: 'ready', state: state('idle') }],
      }),
      agent({
        sessionId: 'match',
        parentSessionId: 'parent',
        path: '/root/parent/needle-path',
        label: 'Needle task',
        declaredAt: 2_000,
        declarationSeq: 2,
        statePoints: [{ seq: 3, time: 2_100, transition: 'turn-started', state: state('running') }],
      }),
      agent({
        sessionId: 'sibling',
        parentSessionId: 'root',
        path: '/root/sibling',
        label: 'Sibling',
        declaredAt: 3_000,
        declarationSeq: 3,
        modelSelection: { provider: 'other', model: 'small' },
        statePoints: [{ seq: 4, time: 3_100, transition: 'turn-started', state: state('running') }],
      }),
    ])
    const display = buildTimelineDisplay({ timeline: result, now: 70 * 60 * 1_000 })

    const filtered = filterTimelineDisplay(display, {
      state: 'running',
      model: 'gpt-5.5',
      path: 'needle-path',
      text: 'Needle',
      longRunningOnly: true,
    })

    expect(ids(filtered.rows)).toEqual(['root', 'parent', 'match'])
    expect(filtered.rows.find(row => row.id === 'root')?.contextOnly).toBe(false)
    expect(filtered.rows.find(row => row.id === 'parent')?.contextOnly).toBe(true)
    expect(filtered.rows.find(row => row.id === 'match')?.contextOnly).toBe(false)
    expect(filtered.rows.find(row => row.id === 'parent')?.longRunning).toBe(false)
    expect(filtered.rows.find(row => row.id === 'match')?.longRunning).toBe(true)
  })
})

describe('countActiveFilters', () => {
  it('counts only the filters that actually narrow the tree', () => {
    expect(countActiveFilters({})).toBe(0)
    expect(countActiveFilters({ state: 'all', model: '', path: '  ', text: '', longRunningOnly: false })).toBe(0)
    expect(countActiveFilters({ state: 'running' })).toBe(1)
    expect(countActiveFilters({ longRunningOnly: true })).toBe(1)
    expect(countActiveFilters({ state: 'running', model: 'gpt', path: '/root', text: 'x', longRunningOnly: true })).toBe(5)
    // Whitespace-only input is not a filter the user can see the effect of.
    expect(countActiveFilters({ model: '   ', text: ' needle ' })).toBe(1)
  })
})
