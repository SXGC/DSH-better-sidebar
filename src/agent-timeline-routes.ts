import type { Context, SidebarSessionEvent } from './context-types.ts'
import { requireString, SidebarError } from './wire.ts'

export type AgentState =
  | { residency: 'live'; turn: { kind: 'provisioning' } }
  | { residency: 'live'; turn: { kind: 'running' } }
  | { residency: 'live'; turn: { kind: 'waiting'; reason: 'mailbox'; since: number; deadline: number } }
  | { residency: 'live'; turn: { kind: 'idle' } }
  | { residency: 'live'; turn: { kind: 'completed'; stopReason?: 'completed' } }
  | { residency: 'live'; turn: { kind: 'interrupted' } }
  | { residency: 'live'; turn: { kind: 'errored'; code: string } }
  | { residency: 'cold'; lastTurn: 'idle' | 'completed' | 'interrupted' | 'errored' }
  | { residency: 'closed' }

export type AgentStateTransition =
  | 'declared'
  | 'ready'
  | 'turn-started'
  | 'wait-started'
  | 'wait-ended'
  | 'turn-settled'
  | 'interrupted'
  | 'became-cold'
  | 'resumed'
  | 'closed'
  | 'errored'

export interface SpawnModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
  serviceTier?: string
}

export interface TimelineStatePoint {
  seq: number
  time: number
  transition: AgentStateTransition
  state: AgentState
}

export interface AgentTimelineRow {
  sessionId: string
  parentSessionId: string
  path: string
  mode: 'one-shot' | 'continuable'
  label?: string
  state: AgentState
  modelSelection: SpawnModelSelection
  hasChildren: boolean
  declaredAt: number
  declarationSeq: number
  statePoints: TimelineStatePoint[]
}

export interface AgentTimelineResult {
  root: {
    sessionId: string
    path: '/root'
    startedAt: number | null
    lastEventAt: number | null
  }
  asOfSeq: number
  agents: AgentTimelineRow[]
}

export interface AgentDetailResult {
  sessionId: string
  initialTask:
    | { available: true; text: string }
    | { available: false; reason: 'not-accepted' | 'session-unavailable' }
  backend: string
  forkTurns: 'none' | 'all' | number
  requestedModelSelection: SpawnModelSelection
  effectiveModelSelection: SpawnModelSelection
  allowedTools: string[]
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  approvalPolicy: 'never' | null
  filesystemPolicy: 'closed'
}

export interface SidebarAgentTimelineRoutes {
  timeline(payload: unknown): Promise<AgentTimelineResult>
  detail(payload: unknown): Promise<AgentDetailResult>
}

interface SessionSnapshot {
  header: {
    id?: unknown
    createdAt?: unknown
    parentSession?: unknown
  }
  events: readonly SidebarSessionEvent[]
}

interface SessionPersistenceLike {
  inspect(id: string, signal?: AbortSignal): Promise<{
    meta: SessionSnapshot['header']
    events: readonly SidebarSessionEvent[]
  }>
}

interface DelegationPolicyLike {
  requestedModelSelection: SpawnModelSelection
  effectiveModelSelection: SpawnModelSelection
  allowedTools: readonly string[]
  sandboxMode: AgentDetailResult['sandboxMode']
  approvalPolicy: AgentDetailResult['approvalPolicy']
  filesystemPolicy: 'closed'
}

interface SpawnNodeLike {
  path: string
  parentSessionId: string
  childSessionId: string
  backend: string
  forkTurns: AgentDetailResult['forkTurns']
  delegationPolicy: DelegationPolicyLike
  receipt?: { messageId?: unknown }
}

interface AgentSummaryLike {
  sessionId: string
  parentSessionId: string
  path: string
  mode?: 'one-shot' | 'continuable'
  label?: string
  state: AgentState
  modelSelection: SpawnModelSelection
  hasChildren: boolean
}

interface FoldStateLike {
  nodesByPath: Map<string, SpawnNodeLike>
  projection: {
    asOfSeq: number
    agents: readonly AgentSummaryLike[]
  }
}

type FoldLoader = () => Promise<{
  foldSubagentNext(rootSessionId: string, events: readonly SidebarSessionEvent[]): FoldStateLike
}>

const BASELINE_COMMIT = '5cf09d3a0a'

const defaultFoldLoader: FoldLoader = async () => {
  const specifier = '@deepseek-ai/dsh-subagent-next'
  return await import(specifier) as {
    foldSubagentNext(rootSessionId: string, events: readonly SidebarSessionEvent[]): FoldStateLike
  }
}

export function buildAgentTimelineApi(ctx: Context, loadFold: FoldLoader = defaultFoldLoader): SidebarAgentTimelineRoutes {
  const readRoot = async (sessionId: string): Promise<SessionSnapshot> => {
    const snapshot = await readSession(ctx, sessionId)
    if (snapshot.header.parentSession !== undefined) {
      throw new SidebarError('not-found', 'agent timeline root not found', 404)
    }
    return snapshot
  }

  const foldRoot = async (rootSessionId: string, events: readonly SidebarSessionEvent[]): Promise<FoldStateLike> => {
    let module: Awaited<ReturnType<FoldLoader>>
    try {
      module = await loadFold()
    } catch {
      throw new SidebarError(
        'agent-error',
        `agent timeline requires DSH subagent-next public API at or after ${BASELINE_COMMIT}`,
        409,
      )
    }
    try {
      return module.foldSubagentNext(rootSessionId, events)
    } catch (error) {
      if (error instanceof SidebarError) throw error
      throw new SidebarError('agent-error', 'agent timeline is unavailable', 409)
    }
  }

  const rootState = async (rootSessionId: string): Promise<{ snapshot: SessionSnapshot; fold: FoldStateLike }> => {
    let snapshot: SessionSnapshot
    try {
      snapshot = await readRoot(rootSessionId)
    } catch (error) {
      if (isPersistenceRootJournalError(error)) {
        throw new SidebarError('agent-error', 'agent timeline is unavailable', 409)
      }
      if (error instanceof SidebarError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new SidebarError('internal', message, 500)
    }
    return { snapshot, fold: await foldRoot(rootSessionId, snapshot.events) }
  }

  return {
    async timeline(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const { snapshot, fold } = await rootState(sessionId)
      return timelineResult(sessionId, snapshot, fold)
    },
    async detail(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const agentSessionId = requireString(payload, 'agentSessionId')
      if (agentSessionId === sessionId) {
        throw new SidebarError('not-found', 'agent not found', 404)
      }
      const { fold } = await rootState(sessionId)
      const node = nodeBySession(fold, agentSessionId)
      if (node === undefined) {
        throw new SidebarError('not-found', 'agent not found', 404)
      }
      return detailResult(ctx, node)
    },
  }
}

async function readSession(ctx: Context, sessionId: string): Promise<SessionSnapshot> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    return { header: live.header, events: live.events ?? [] }
  }
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  if (persistence === undefined || typeof persistence.inspect !== 'function') {
    throw new SidebarError('not-found', 'session not found', 404)
  }
  try {
    const loaded = await persistence.inspect(sessionId)
    return { header: loaded.meta, events: loaded.events }
  } catch (error) {
    if (looksNotFound(error)) {
      throw new SidebarError('not-found', 'session not found', 404)
    }
    throw error
  }
}

function looksNotFound(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /^session "[^"]+" not found$/.test(message)
}

function isPersistenceRootJournalError(error: unknown): boolean {
  const name = error !== null && typeof error === 'object'
    ? (error as { name?: unknown }).name
    : undefined
  return name === 'SessionPersistenceCorruptionError' || name === 'SessionFormatUnsupportedError'
}

function timelineResult(rootSessionId: string, snapshot: SessionSnapshot, fold: FoldStateLike): AgentTimelineResult {
  return {
    root: {
      sessionId: rootSessionId,
      path: '/root',
      startedAt: firstEventAt(snapshot.events),
      lastEventAt: lastEventAt(snapshot.events),
    },
    asOfSeq: fold.projection.asOfSeq,
    agents: treeSortedRows(rootSessionId, snapshot.events, fold),
  }
}

function firstEventAt(events: readonly SidebarSessionEvent[]): number | null {
  return events[0]?.time ?? null
}

function lastEventAt(events: readonly SidebarSessionEvent[]): number | null {
  let last: number | null = null
  for (const event of events) {
    if (last === null || event.time > last) last = event.time
  }
  return last
}

function treeSortedRows(rootSessionId: string, events: readonly SidebarSessionEvent[], fold: FoldStateLike): AgentTimelineRow[] {
  const declarations = declarationsOf(events)
  const statePoints = statePointsOf(events)
  const summaries = new Map(fold.projection.agents.map(agent => [agent.sessionId, agent]))
  const rows = [...fold.nodesByPath.values()].map((node): AgentTimelineRow => {
    const declaration = declarations.get(node.childSessionId)
    const points = statePoints.get(node.childSessionId) ?? []
    const summary = summaries.get(node.childSessionId)
    return {
      sessionId: node.childSessionId,
      parentSessionId: node.parentSessionId,
      path: node.path,
      mode: summary?.mode ?? 'continuable',
      ...(summary?.label !== undefined ? { label: summary.label } : {}),
      state: points.at(-1)?.state ?? summary?.state ?? { residency: 'live', turn: { kind: 'provisioning' } },
      modelSelection: cloneModelSelection(summary?.modelSelection ?? node.delegationPolicy.effectiveModelSelection),
      hasChildren: summary?.hasChildren ?? [...fold.nodesByPath.values()].some(child => child.parentSessionId === node.childSessionId),
      declaredAt: declaration?.time ?? 0,
      declarationSeq: declaration?.seq ?? -1,
      statePoints: points,
    }
  })
  return sortRowsAsTree(rootSessionId, rows)
}

function declarationsOf(events: readonly SidebarSessionEvent[]): Map<string, { seq: number; time: number }> {
  const declarations = new Map<string, { seq: number; time: number }>()
  for (const event of events) {
    if (event.type !== 'subagent-next/agent-declared') continue
    const childSessionId = event.data.childSessionId
    if (typeof childSessionId === 'string') declarations.set(childSessionId, { seq: event.seq, time: event.time })
  }
  return declarations
}

function statePointsOf(events: readonly SidebarSessionEvent[]): Map<string, TimelineStatePoint[]> {
  const points = new Map<string, TimelineStatePoint[]>()
  for (const event of events) {
    if (event.type !== 'subagent-next/state-changed') continue
    const data = event.data as Record<string, unknown>
    if (typeof data.agentSessionId !== 'string'
      || !isAgentStateTransition(data.transition)
      || !isAgentState(data.state)) {
      continue
    }
    let list = points.get(data.agentSessionId)
    if (list === undefined) points.set(data.agentSessionId, list = [])
    list.push({ seq: event.seq, time: event.time, transition: data.transition, state: cloneState(data.state) })
  }
  for (const list of points.values()) list.sort((left, right) => left.seq - right.seq)
  return points
}

function sortRowsAsTree(rootSessionId: string, rows: AgentTimelineRow[]): AgentTimelineRow[] {
  const children = new Map<string, AgentTimelineRow[]>()
  for (const row of rows) {
    let list = children.get(row.parentSessionId)
    if (list === undefined) children.set(row.parentSessionId, list = [])
    list.push(row)
  }
  for (const list of children.values()) {
    list.sort((left, right) => (
      left.declaredAt - right.declaredAt
      || left.declarationSeq - right.declarationSeq
      || left.path.localeCompare(right.path)
    ))
  }
  const sorted: AgentTimelineRow[] = []
  const seen = new Set<string>()
  const visit = (parentSessionId: string): void => {
    for (const row of children.get(parentSessionId) ?? []) {
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      sorted.push(row)
      visit(row.sessionId)
    }
  }
  visit(rootSessionId)
  for (const row of [...rows].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!seen.has(row.sessionId)) {
      seen.add(row.sessionId)
      sorted.push(row)
    }
  }
  return sorted
}

function nodeBySession(fold: FoldStateLike, sessionId: string): SpawnNodeLike | undefined {
  for (const node of fold.nodesByPath.values()) {
    if (node.childSessionId === sessionId) return node
  }
  return undefined
}

async function detailResult(ctx: Context, node: SpawnNodeLike): Promise<AgentDetailResult> {
  const base = {
    sessionId: node.childSessionId,
    backend: node.backend,
    forkTurns: node.forkTurns,
    requestedModelSelection: cloneModelSelection(node.delegationPolicy.requestedModelSelection),
    effectiveModelSelection: cloneModelSelection(node.delegationPolicy.effectiveModelSelection),
    allowedTools: [...node.delegationPolicy.allowedTools],
    sandboxMode: node.delegationPolicy.sandboxMode,
    approvalPolicy: node.delegationPolicy.approvalPolicy,
    filesystemPolicy: node.delegationPolicy.filesystemPolicy,
  }
  const messageId = node.receipt?.messageId
  if (typeof messageId !== 'string' || messageId === '') {
    return { ...base, initialTask: { available: false, reason: 'not-accepted' } }
  }
  try {
    const child = await readSession(ctx, node.childSessionId)
    const text = initialTaskText(child.events, messageId)
    return text === undefined
      ? { ...base, initialTask: { available: false, reason: 'session-unavailable' } }
      : { ...base, initialTask: { available: true, text } }
  } catch {
    return { ...base, initialTask: { available: false, reason: 'session-unavailable' } }
  }
}

function initialTaskText(events: readonly SidebarSessionEvent[], messageId: string): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const message = event.data as { id?: unknown; content?: unknown }
    if (message.id !== messageId || !Array.isArray(message.content)) continue
    const parts: string[] = []
    for (const block of message.content) {
      if (block === null || typeof block !== 'object') continue
      const candidate = block as { type?: unknown; text?: unknown }
      if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
    }
    return parts.join('')
  }
  return undefined
}

function cloneModelSelection(selection: SpawnModelSelection): SpawnModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(selection.serviceTier !== undefined ? { serviceTier: selection.serviceTier } : {}),
  }
}

function cloneState(state: AgentState): AgentState {
  switch (state.residency) {
    case 'closed':
      return { residency: 'closed' }
    case 'cold':
      return { residency: 'cold', lastTurn: state.lastTurn }
    case 'live':
      switch (state.turn.kind) {
        case 'provisioning':
          return { residency: 'live', turn: { kind: 'provisioning' } }
        case 'running':
          return { residency: 'live', turn: { kind: 'running' } }
        case 'waiting':
          return {
            residency: 'live',
            turn: {
              kind: 'waiting',
              reason: 'mailbox',
              since: state.turn.since,
              deadline: state.turn.deadline,
            },
          }
        case 'idle':
          return { residency: 'live', turn: { kind: 'idle' } }
        case 'completed':
          return {
            residency: 'live',
            turn: {
              kind: 'completed',
              ...(state.turn.stopReason !== undefined ? { stopReason: state.turn.stopReason } : {}),
            },
          }
        case 'interrupted':
          return { residency: 'live', turn: { kind: 'interrupted' } }
        case 'errored':
          return { residency: 'live', turn: { kind: 'errored', code: state.turn.code } }
        default:
          return assertNever(state.turn)
      }
    default:
      return assertNever(state)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled agent timeline value ${JSON.stringify(value)}`)
}

function isAgentStateTransition(value: unknown): value is AgentStateTransition {
  return value === 'declared'
    || value === 'ready'
    || value === 'turn-started'
    || value === 'wait-started'
    || value === 'wait-ended'
    || value === 'turn-settled'
    || value === 'interrupted'
    || value === 'became-cold'
    || value === 'resumed'
    || value === 'closed'
    || value === 'errored'
}

function isAgentState(value: unknown): value is AgentState {
  if (value === null || typeof value !== 'object') return false
  const record = value as { residency?: unknown; turn?: { kind?: unknown }; lastTurn?: unknown }
  if (record.residency === 'closed') return true
  if (record.residency === 'cold') {
    return record.lastTurn === 'idle'
      || record.lastTurn === 'completed'
      || record.lastTurn === 'interrupted'
      || record.lastTurn === 'errored'
  }
  if (record.residency !== 'live' || record.turn === null || typeof record.turn !== 'object') return false
  return record.turn.kind === 'provisioning'
    || record.turn.kind === 'running'
    || record.turn.kind === 'waiting'
    || record.turn.kind === 'idle'
    || record.turn.kind === 'completed'
    || record.turn.kind === 'interrupted'
    || record.turn.kind === 'errored'
}
