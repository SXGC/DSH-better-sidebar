import { describe, expect, it } from 'vitest'
import {
  buildTimelineDisplay,
  formatAgentState,
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

  it('leaves the last live or cold segment open and renders it against now', () => {
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
    expect(row.wallDurationMs).toBe(10_000)
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
})
