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

/** One spawn declaration, read straight from the root journal's
 * `subagent-next/agent-declared` event (the fold's SpawnNode is a verbatim
 * copy of this payload); the receipt messageId arrives with `agent-ready`. */
interface SpawnDeclaration {
  childSessionId: string
  backend: string
  forkTurns: AgentDetailResult['forkTurns']
  delegationPolicy: DelegationPolicyLike
  receiptMessageId?: string
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

interface SubagentNextProjectionLike {
  asOfSeq: number
  agents: readonly AgentSummaryLike[]
}

/**
 * The minimal slice of the host's `subagentNext` cordis service these routes
 * consume: the authoritative content-free collaboration projection of one
 * root session (live session first, persistence fallback, root identity
 * checked — all owned by the host). Consumed through `ctx.get` like
 * `sessionPersistence`, never by importing DSH internals.
 */
interface SubagentNextServiceLike {
  snapshot(rootSessionId: string, signal?: AbortSignal): Promise<SubagentNextProjectionLike>
}

const BASELINE_COMMIT = '5cf09d3a0a'

export function buildAgentTimelineApi(ctx: Context): SidebarAgentTimelineRoutes {
  const readRoot = async (sessionId: string): Promise<SessionSnapshot> => {
    let snapshot: SessionSnapshot
    try {
      snapshot = await readSession(ctx, sessionId)
    } catch (error) {
      if (isPersistenceRootJournalError(error)) {
        throw new SidebarError('agent-error', 'agent timeline is unavailable', 409)
      }
      if (error instanceof SidebarError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new SidebarError('internal', message, 500)
    }
    if (snapshot.header.parentSession !== undefined) {
      throw new SidebarError('not-found', 'agent timeline root not found', 404)
    }
    return snapshot
  }

  // The projection comes from the host's own runtime, so a deployment
  // without subagent-next degrades to one explicit 409 instead of a
  // module-resolution accident.
  const serviceProjection = async (rootSessionId: string): Promise<SubagentNextProjectionLike> => {
    const runtime = ctx.get('subagentNext') as SubagentNextServiceLike | undefined
    if (runtime === undefined || typeof runtime.snapshot !== 'function') {
      throw new SidebarError(
        'agent-error',
        `agent timeline requires the DSH subagentNext service (baseline ${BASELINE_COMMIT})`,
        409,
      )
    }
    try {
      return await runtime.snapshot(rootSessionId)
    } catch (error) {
      if (error instanceof SidebarError) throw error
      throw new SidebarError('agent-error', 'agent timeline is unavailable', 409)
    }
  }

  return {
    async timeline(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const snapshot = await readRoot(sessionId)
      const projection = await serviceProjection(sessionId)
      return timelineResult(sessionId, snapshot, projection)
    },
    async detail(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const agentSessionId = requireString(payload, 'agentSessionId')
      if (agentSessionId === sessionId) {
        throw new SidebarError('not-found', 'agent not found', 404)
      }
      // The spawn declaration IS the root journal event payload: no
      // projection or fold needed to answer a detail read.
      const snapshot = await readRoot(sessionId)
      const declaration = spawnDeclarationOf(snapshot.events, agentSessionId)
      if (declaration === undefined) {
        throw new SidebarError('not-found', 'agent not found', 404)
      }
      return detailResult(ctx, declaration)
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

function timelineResult(
  rootSessionId: string,
  snapshot: SessionSnapshot,
  projection: SubagentNextProjectionLike,
): AgentTimelineResult {
  return {
    root: {
      sessionId: rootSessionId,
      path: '/root',
      startedAt: firstEventAt(snapshot.events),
      lastEventAt: lastEventAt(snapshot.events),
    },
    asOfSeq: projection.asOfSeq,
    agents: treeSortedRows(rootSessionId, snapshot.events, projection),
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

function treeSortedRows(
  rootSessionId: string,
  events: readonly SidebarSessionEvent[],
  projection: SubagentNextProjectionLike,
): AgentTimelineRow[] {
  const declarations = declarationsOf(events)
  const statePoints = statePointsOf(events)
  const rows = projection.agents
    .filter(agent => agent.sessionId !== rootSessionId)
    .map((agent): AgentTimelineRow => {
      const declaration = declarations.get(agent.sessionId)
      const points = statePoints.get(agent.sessionId) ?? []
      return {
        sessionId: agent.sessionId,
        parentSessionId: agent.parentSessionId,
        path: agent.path,
        mode: agent.mode ?? 'continuable',
        ...(agent.label !== undefined ? { label: agent.label } : {}),
        state: points.at(-1)?.state ?? cloneState(agent.state),
        modelSelection: cloneModelSelection(agent.modelSelection),
        hasChildren: agent.hasChildren,
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

/**
 * Read one child's spawn declaration straight from the root journal:
 * `agent-declared` carries the whole whitelisted configuration, and the
 * matching `agent-ready` receipt names the initial-task message.
 */
function spawnDeclarationOf(
  events: readonly SidebarSessionEvent[],
  agentSessionId: string,
): SpawnDeclaration | undefined {
  let operationId: string | undefined
  let declaration: SpawnDeclaration | undefined
  for (const event of events) {
    if (event.type === 'subagent-next/agent-declared') {
      const data = event.data as Record<string, unknown>
      if (data.childSessionId !== agentSessionId) continue
      if (typeof data.operationId !== 'string'
        || typeof data.backend !== 'string'
        || !isForkTurns(data.forkTurns)
        || !isDelegationPolicy(data.delegationPolicy)) {
        continue
      }
      operationId = data.operationId
      declaration = {
        childSessionId: agentSessionId,
        backend: data.backend,
        forkTurns: data.forkTurns,
        delegationPolicy: data.delegationPolicy,
      }
      continue
    }
    if (event.type === 'subagent-next/agent-ready' && declaration !== undefined) {
      const data = event.data as { operationId?: unknown; receipt?: unknown }
      if (data.operationId !== operationId) continue
      const receipt = data.receipt as { messageId?: unknown } | undefined
      const messageId = receipt?.messageId
      if (typeof messageId === 'string' && messageId !== '') declaration.receiptMessageId = messageId
    }
  }
  return declaration
}

function isForkTurns(value: unknown): value is AgentDetailResult['forkTurns'] {
  return value === 'none' || value === 'all' || (typeof value === 'number' && Number.isFinite(value))
}

function isDelegationPolicy(value: unknown): value is DelegationPolicyLike {
  if (value === null || typeof value !== 'object') return false
  const policy = value as Record<string, unknown>
  return isModelSelection(policy.requestedModelSelection)
    && isModelSelection(policy.effectiveModelSelection)
    && Array.isArray(policy.allowedTools)
    && policy.allowedTools.every(tool => typeof tool === 'string')
    && (policy.sandboxMode === null || policy.sandboxMode === 'read-only'
      || policy.sandboxMode === 'workspace-write' || policy.sandboxMode === 'danger-full-access')
    && (policy.approvalPolicy === null || policy.approvalPolicy === 'never')
    && policy.filesystemPolicy === 'closed'
}

function isModelSelection(value: unknown): value is SpawnModelSelection {
  if (value === null || typeof value !== 'object') return false
  const selection = value as Record<string, unknown>
  return typeof selection.provider === 'string' && typeof selection.model === 'string'
}

async function detailResult(ctx: Context, declaration: SpawnDeclaration): Promise<AgentDetailResult> {
  const base = {
    sessionId: declaration.childSessionId,
    backend: declaration.backend,
    forkTurns: declaration.forkTurns,
    requestedModelSelection: cloneModelSelection(declaration.delegationPolicy.requestedModelSelection),
    effectiveModelSelection: cloneModelSelection(declaration.delegationPolicy.effectiveModelSelection),
    allowedTools: [...declaration.delegationPolicy.allowedTools],
    sandboxMode: declaration.delegationPolicy.sandboxMode,
    approvalPolicy: declaration.delegationPolicy.approvalPolicy,
    filesystemPolicy: declaration.delegationPolicy.filesystemPolicy,
  }
  const messageId = declaration.receiptMessageId
  if (messageId === undefined) {
    return { ...base, initialTask: { available: false, reason: 'not-accepted' } }
  }
  try {
    const child = await readSession(ctx, declaration.childSessionId)
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
