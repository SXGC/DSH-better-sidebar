import { describe, expect, it, vi } from 'vitest'
import { buildAgentTimelineApi } from '../src/agent-timeline-routes.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

const model = {
  provider: 'deepseek-official',
  model: 'deepseek-v4',
  reasoningEffort: 'high',
  serviceTier: 'priority',
}

const policy = {
  requestedModelSelection: model,
  effectiveModelSelection: { ...model, model: 'deepseek-v4-flash' },
  credentialRef: 'secret/model-key',
  allowedTools: ['bash', 'read'],
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  filesystemPolicy: 'closed',
}

function event(type: string, seq: number, data: Record<string, unknown>, time = 1_000 + seq): SidebarSessionEvent {
  return { type, seq, time, data }
}

function declared(seq: number, childSessionId: string, parentSessionId = 'root', path = `/root/${childSessionId}`): SidebarSessionEvent {
  return event('subagent-next/agent-declared', seq, {
    version: 1,
    rootSessionId: 'root',
    operationId: `op-${childSessionId}`,
    requestHash: 'a'.repeat(64),
    path,
    parentSessionId,
    childSessionId,
    backend: 'subagent-next',
    forkTurns: 'none',
    delegationPolicy: policy,
  })
}

function ready(seq: number, childSessionId: string, path = `/root/${childSessionId}`, parentSessionId = 'root'): SidebarSessionEvent {
  return event('subagent-next/agent-ready', seq, {
    version: 1,
    rootSessionId: 'root',
    operationId: `op-${childSessionId}`,
    receipt: {
      operationId: `op-${childSessionId}`,
      path,
      parentSessionId,
      childSessionId,
      messageId: `msg-${childSessionId}`,
    },
  })
}

function state(seq: number, childSessionId: string, transition: string, stateValue: unknown, path = `/root/${childSessionId}`): SidebarSessionEvent {
  return event('subagent-next/state-changed', seq, {
    version: 1,
    rootSessionId: 'root',
    agentSessionId: childSessionId,
    path,
    transition,
    state: stateValue,
    stateVersion: seq,
  })
}

function childTask(id: string, text: string): SidebarSessionEvent {
  return event('user/message', 1, {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text },
      { type: 'image', url: 'file:///secret.png' },
      { type: 'text', text: '\nsecond block' },
    ],
  })
}

/** Mirrors the host SubagentNextRuntime.snapshot projection semantics. */
function projectionOf(rootSessionId: string, events: readonly SidebarSessionEvent[]) {
  if (rootSessionId !== 'root') throw new Error('unexpected root')
  const nodes = new Map<string, Record<string, unknown>>()
  const latest = new Map<string, { state: unknown }>()
  for (const entry of events) {
    if (entry.type === 'subagent-next/agent-declared') {
      nodes.set(String(entry.data.childSessionId), entry.data as Record<string, unknown>)
    } else if (entry.type === 'subagent-next/state-changed') {
      latest.set(String(entry.data.agentSessionId), { state: entry.data.state })
    }
  }
  return {
    asOfSeq: events.reduce((max, item) => Math.max(max, item.seq), -1),
    agents: [...nodes.values()].map(node => ({
      sessionId: node.childSessionId,
      parentSessionId: node.parentSessionId,
      path: node.path,
      mode: 'continuable',
      label: String(node.path).slice(String(node.path).lastIndexOf('/') + 1),
      state: latest.get(String(node.childSessionId))?.state ?? { residency: 'live', turn: { kind: 'provisioning' } },
      modelSelection: (node.delegationPolicy as { effectiveModelSelection: unknown }).effectiveModelSelection,
      hasChildren: [...nodes.values()].some(child => child.parentSessionId === node.childSessionId),
    })),
  }
}

function ctxWith(options: {
  live?: Record<string, { header: Record<string, unknown>; events: SidebarSessionEvent[] }>
  persisted?: Record<string, { meta: Record<string, unknown>; events: SidebarSessionEvent[] }>
  inspectError?: Error
  /** Override the subagentNext service; 'absent' models a deployment without it. */
  subagentNext?: { snapshot(rootSessionId: string): Promise<unknown> | unknown } | 'absent'
}): Context {
  const eventsFor = (id: string): SidebarSessionEvent[] =>
    options.live?.[id]?.events ?? options.persisted?.[id]?.events ?? []
  const subagentNext = options.subagentNext
    ?? { snapshot: async (rootSessionId: string) => projectionOf(rootSessionId, eventsFor(rootSessionId)) }
  return {
    sessions: {
      get: (id: string) => options.live?.[id],
    },
    get: (key: string) => key === 'sessionPersistence'
      ? {
          inspect: vi.fn(async (id: string) => {
            if (options.inspectError !== undefined) throw options.inspectError
            const found = options.persisted?.[id]
            if (found === undefined) throw new Error(`session "${id}" not found`)
            return found
          }),
        }
      : key === 'subagentNext' && subagentNext !== 'absent'
        ? subagentNext
        : undefined,
  } as unknown as Context
}

describe('agents.timeline route', () => {
  it('projects restored native descendants with spawn order, all state points, cold/completed states, and no sensitive fields', async () => {
    const rootEvents = [
      declared(1, 'b', 'root', '/root/b'),
      declared(2, 'a', 'root', '/root/a'),
      declared(3, 'a1', 'a', '/root/a/a1'),
      ready(4, 'b', '/root/b'),
      state(5, 'b', 'ready', { residency: 'live', turn: { kind: 'running' } }, '/root/b'),
      state(6, 'b', 'became-cold', { residency: 'cold', lastTurn: 'idle' }, '/root/b'),
      state(7, 'b', 'resumed', { residency: 'live', turn: { kind: 'idle' } }, '/root/b'),
      state(8, 'b', 'turn-settled', { residency: 'live', turn: { kind: 'completed', stopReason: 'completed' } }, '/root/b'),
      ready(9, 'a', '/root/a'),
      state(10, 'a', 'ready', { residency: 'live', turn: { kind: 'idle' } }, '/root/a'),
      ready(11, 'a1', '/root/a/a1', 'a'),
      state(12, 'a1', 'closed', { residency: 'closed' }, '/root/a/a1'),
    ]
    const api = buildAgentTimelineApi(ctxWith({
      persisted: { root: { meta: { id: 'root', version: 0, createdAt: 999_999 }, events: rootEvents } },
    }))

    const value = await api.timeline({ sessionId: 'root' })

    expect(value.root).toEqual({ sessionId: 'root', path: '/root', startedAt: 1001, lastEventAt: 1012 })
    expect(value.asOfSeq).toBe(12)
    expect(value.agents.map(row => row.sessionId)).toEqual(['b', 'a', 'a1'])
    const b = value.agents[0]!
    expect(b.declaredAt).toBe(1001)
    expect(b.declarationSeq).toBe(1)
    expect(b.hasChildren).toBe(false)
    expect(b.state).toEqual({ residency: 'live', turn: { kind: 'completed', stopReason: 'completed' } })
    expect(b.statePoints.map(point => point.transition)).toEqual(['ready', 'became-cold', 'resumed', 'turn-settled'])
    expect(JSON.stringify(value)).not.toContain('credentialRef')
    expect(JSON.stringify(value)).not.toContain('requestHash')
    expect(JSON.stringify(value)).not.toContain('operationId')
    expect(JSON.stringify(value)).not.toContain('secret/model-key')
  })

  it('rejects non-root sessions and corrupted root journals with the specified errors', async () => {
    const api = buildAgentTimelineApi(ctxWith({
      live: { child: { header: { id: 'child', parentSession: 'root' }, events: [] } },
    }))
    await expect(api.timeline({ sessionId: 'child' })).rejects.toMatchObject({ code: 'not-found', status: 404 })

    const corrupt = buildAgentTimelineApi(ctxWith({
      live: { root: { header: { id: 'root' }, events: [] } },
      subagentNext: { snapshot: () => { throw new Error('bad native journal') } },
    }))
    await expect(corrupt.timeline({ sessionId: 'root' })).rejects.toMatchObject({ code: 'agent-error', status: 409 })
  })

  it('maps persistence missing, corruption, unsupported, and unclassified root reads distinctly', async () => {
    const missing = buildAgentTimelineApi(ctxWith({
      inspectError: new Error('session "missing-root" not found'),
    }))
    await expect(missing.timeline({ sessionId: 'missing-root' }))
      .rejects.toMatchObject({ code: 'not-found', status: 404 })

    const corruptionError = new Error('stored session log is corrupt')
    corruptionError.name = 'SessionPersistenceCorruptionError'
    const corrupt = buildAgentTimelineApi(ctxWith({ inspectError: corruptionError }))
    await expect(corrupt.timeline({ sessionId: 'corrupt-root' }))
      .rejects.toMatchObject({ code: 'agent-error', status: 409 })

    const unsupportedError = new Error('unsupported session format')
    unsupportedError.name = 'SessionFormatUnsupportedError'
    const unsupported = buildAgentTimelineApi(ctxWith({ inspectError: unsupportedError }))
    await expect(unsupported.timeline({ sessionId: 'old-root' }))
      .rejects.toMatchObject({ code: 'agent-error', status: 409 })

    const unknownVersion = buildAgentTimelineApi(ctxWith({
      inspectError: new Error('unknown session event version'),
    }))
    await expect(unknownVersion.timeline({ sessionId: 'root' }))
      .rejects.toMatchObject({ code: 'internal', status: 500 })
  })
})

describe('agents.detail route', () => {
  it('reads the child initial task by receipt messageId and returns only whitelisted run properties', async () => {
    const rootEvents = [
      declared(1, 'child'),
      ready(2, 'child'),
      state(3, 'child', 'ready', { residency: 'live', turn: { kind: 'running' } }),
    ]
    const api = buildAgentTimelineApi(ctxWith({
      live: { root: { header: { id: 'root', createdAt: 999 }, events: rootEvents } },
      persisted: {
        child: {
          meta: { id: 'child', parentSession: 'root' },
          events: [
            childTask('wrong-message', 'wrong text'),
            childTask('msg-child', 'first block'),
          ],
        },
      },
    }))

    const value = await api.detail({ sessionId: 'root', agentSessionId: 'child' })

    expect(value).toEqual({
      sessionId: 'child',
      initialTask: { available: true, text: 'first block\nsecond block' },
      backend: 'subagent-next',
      forkTurns: 'none',
      requestedModelSelection: model,
      effectiveModelSelection: { ...model, model: 'deepseek-v4-flash' },
      allowedTools: ['bash', 'read'],
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      filesystemPolicy: 'closed',
    })
    expect(JSON.stringify(value)).not.toContain('credentialRef')
    expect(JSON.stringify(value)).not.toContain('requestHash')
    expect(JSON.stringify(value)).not.toContain('operationId')
  })

  it('uses the failure matrix for not-accepted, temporarily unavailable, root, unknown, and foreign children', async () => {
    const rootEvents = [declared(1, 'failed-child')]
    const api = buildAgentTimelineApi(ctxWith({
      live: { root: { header: { id: 'root' }, events: rootEvents } },
    }))

    await expect(api.detail({ sessionId: 'root', agentSessionId: 'root' }))
      .rejects.toMatchObject({ code: 'not-found', status: 404 })
    await expect(api.detail({ sessionId: 'root', agentSessionId: 'unknown' }))
      .rejects.toMatchObject({ code: 'not-found', status: 404 })
    await expect(api.detail({ sessionId: 'other-root', agentSessionId: 'failed-child' }))
      .rejects.toMatchObject({ code: 'not-found', status: 404 })
    await expect(api.detail({ sessionId: 'root', agentSessionId: 'failed-child' }))
      .resolves.toMatchObject({ initialTask: { available: false, reason: 'not-accepted' } })

    const readyApi = buildAgentTimelineApi(ctxWith({
      live: { root: { header: { id: 'root' }, events: [declared(1, 'child'), ready(2, 'child')] } },
      inspectError: new Error('temporarily unavailable'),
    }))
    await expect(readyApi.detail({ sessionId: 'root', agentSessionId: 'child' }))
      .resolves.toMatchObject({ initialTask: { available: false, reason: 'session-unavailable' } })
  })

  it('fails explicitly when the host has no subagentNext service', async () => {
    const api = buildAgentTimelineApi(ctxWith({
      live: { root: { header: { id: 'root' }, events: [] } },
      subagentNext: 'absent',
    }))

    await expect(api.timeline({ sessionId: 'root' })).rejects.toMatchObject({
      code: 'agent-error',
      status: 409,
    })
    await expect(api.timeline({ sessionId: 'root' })).rejects.toThrow(/5cf09d3a0a/)
  })
})
