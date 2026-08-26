import type {
  AgentState,
  AgentTimelineResult,
  AgentTimelineRow,
  SpawnModelSelection,
  TimelineStatePoint,
} from '../agent-timeline-routes.ts'
import type { SidebarSubagentCatalog } from '../context-types.ts'

export interface TimelineSegment {
  start: number
  end?: number
  state: AgentState
}

export interface TimelineDisplayRow {
  id: string
  kind: 'root' | 'agent' | 'diagnostic'
  title: string
  depth: number
  path?: string
  model?: SpawnModelSelection
  state?: AgentState
  startedAt?: number
  endedAt?: number
  segments: TimelineSegment[]
  activeDurationMs: number
  wallDurationMs: number
  contextOnly: boolean
  longRunning: boolean
}

export interface TimelineDisplay {
  asOfSeq: number
  rows: TimelineDisplayRow[]
  range: { start: number; end: number } | null
}

export interface TimelineDisplayFilters {
  state?: string
  model?: string
  path?: string
  text?: string
  longRunningOnly?: boolean
}

export interface BuildTimelineDisplayOptions {
  timeline: AgentTimelineResult
  catalogs?: Readonly<Record<string, SidebarSubagentCatalog>>
  rootTitle?: string
  rootRunning?: boolean
  now: number
  longRunningMinutes?: unknown
}

const DEFAULT_ROOT_TITLE = 'Root'
const DEFAULT_LONG_RUNNING_MINUTES = 60
const MAX_LONG_RUNNING_MINUTES = 10_080

export function buildTimelineDisplay(options: BuildTimelineDisplayOptions): TimelineDisplay {
  const { timeline, catalogs = {}, now } = options
  const longRunningMinutes = normalizeLongRunningMinutes(options.longRunningMinutes)
  const nativeRows = sortNativeRows(timeline.root.sessionId, timeline.agents)
  const depths = nativeDepths(timeline.root.sessionId, nativeRows)
  const displayRows: TimelineDisplayRow[] = [
    rootDisplayRow(timeline, options.rootTitle ?? DEFAULT_ROOT_TITLE, options.rootRunning ?? true, now),
  ]
  const nativeIds = new Set(nativeRows.map(row => row.sessionId))

  for (const row of nativeRows) {
    displayRows.push(agentDisplayRow(row, depths.get(row.sessionId) ?? 1, now, longRunningMinutes))
  }
  appendCatalogDiagnostics(displayRows, {
    catalogs,
    nativeIds,
    parentSessionId: timeline.root.sessionId,
    depth: 1,
    seen: new Set(displayRows.map(row => row.id)),
  })

  return {
    asOfSeq: timeline.asOfSeq,
    rows: displayRows,
    range: displayRange(displayRows, now),
  }
}

export function normalizeLongRunningMinutes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LONG_RUNNING_MINUTES
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LONG_RUNNING_MINUTES
  const minutes = Math.round(value)
  if (minutes < 0 || minutes > MAX_LONG_RUNNING_MINUTES) return DEFAULT_LONG_RUNNING_MINUTES
  return minutes
}

export function filterTimelineDisplay(display: TimelineDisplay, filters: TimelineDisplayFilters): TimelineDisplay {
  const normalized = normalizeFilters(filters)
  if (normalized === null) return display

  const keep = new Set<number>([0])
  const ancestors: number[] = []
  for (let index = 0; index < display.rows.length; index += 1) {
    const row = display.rows[index]!
    ancestors[row.depth] = index
    ancestors.length = row.depth + 1
    if (index === 0) continue
    if (!rowMatchesFilters(row, normalized)) continue
    for (let depth = 0; depth <= row.depth; depth += 1) {
      const ancestorIndex = ancestors[depth]
      if (ancestorIndex !== undefined) keep.add(ancestorIndex)
    }
  }

  return { ...display, rows: display.rows.filter((_, index) => keep.has(index)) }
}

function rootDisplayRow(
  timeline: AgentTimelineResult,
  title: string,
  running: boolean,
  now: number,
): TimelineDisplayRow {
  const start = timeline.root.startedAt ?? timeline.root.lastEventAt ?? now
  const state: AgentState = running
    ? { residency: 'live', turn: { kind: 'running' } }
    : { residency: 'live', turn: { kind: 'completed', stopReason: 'completed' } }
  const segment: TimelineSegment = running
    ? { start, state }
    : { start, end: timeline.root.lastEventAt ?? start, state }
  return {
    id: timeline.root.sessionId,
    kind: 'root',
    title,
    depth: 0,
    path: timeline.root.path,
    state,
    startedAt: timeline.root.startedAt ?? undefined,
    endedAt: running ? undefined : timeline.root.lastEventAt ?? undefined,
    segments: timeline.root.startedAt === null && timeline.root.lastEventAt === null ? [] : [segment],
    activeDurationMs: durationOf([segment], now, 'active'),
    wallDurationMs: durationOf([segment], now, 'wall'),
    contextOnly: false,
    longRunning: false,
  }
}

function agentDisplayRow(row: AgentTimelineRow, depth: number, now: number, longRunningMinutes: number): TimelineDisplayRow {
  const segments = buildSegments(row)
  const endedAt = row.state.residency === 'closed'
    ? segments.findLast(segment => segment.state.residency === 'closed')?.start
    : undefined
  return {
    id: row.sessionId,
    kind: 'agent',
    title: row.label ?? row.path.split('/').filter(Boolean).at(-1) ?? row.sessionId,
    depth,
    path: row.path,
    model: row.modelSelection,
    state: row.state,
    startedAt: row.declaredAt,
    endedAt,
    segments,
    activeDurationMs: durationOf(segments, now, 'active'),
    wallDurationMs: durationOf(segments, now, 'wall'),
    contextOnly: false,
    longRunning: isLongRunning(row, segments, now, longRunningMinutes),
  }
}

export function buildSegments(row: AgentTimelineRow): TimelineSegment[] {
  const points = [...row.statePoints].sort((left, right) => left.seq - right.seq)
  if (points.length === 0) {
    return [{ start: row.declaredAt, state: cloneState(row.state) }]
  }
  const segments: TimelineSegment[] = []
  let cursor = row.declaredAt
  if (points[0]!.time > cursor) {
    segments.push({
      start: cursor,
      end: points[0]!.time,
      state: { residency: 'live', turn: { kind: 'provisioning' } },
    })
    cursor = points[0]!.time
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!
    const start = Math.max(cursor, point.time)
    const next = points[index + 1]
    const state = cloneState(point.state)
    if (state.residency === 'closed') {
      segments.push({ start, end: start, state })
      cursor = start
      continue
    }
    const end = next === undefined ? undefined : Math.max(start, next.time)
    segments.push({ start, ...(end === undefined ? {} : { end }), state })
    cursor = end ?? start
  }
  return segments
}

function sortNativeRows(rootSessionId: string, rows: readonly AgentTimelineRow[]): AgentTimelineRow[] {
  const children = new Map<string, AgentTimelineRow[]>()
  for (const row of rows) {
    let list = children.get(row.parentSessionId)
    if (list === undefined) children.set(row.parentSessionId, list = [])
    list.push(row)
  }
  for (const list of children.values()) list.sort(compareRows)

  const sorted: AgentTimelineRow[] = []
  const seen = new Set<string>()
  const visit = (parentId: string): void => {
    for (const row of children.get(parentId) ?? []) {
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      sorted.push(row)
      visit(row.sessionId)
    }
  }
  visit(rootSessionId)
  for (const row of [...rows].sort(compareRows)) {
    if (!seen.has(row.sessionId)) {
      seen.add(row.sessionId)
      sorted.push(row)
    }
  }
  return sorted
}

function compareRows(left: AgentTimelineRow, right: AgentTimelineRow): number {
  return left.declaredAt - right.declaredAt
    || left.declarationSeq - right.declarationSeq
    || left.path.localeCompare(right.path)
}

function nativeDepths(rootSessionId: string, rows: readonly AgentTimelineRow[]): Map<string, number> {
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  const depths = new Map<string, number>()
  const depthOf = (row: AgentTimelineRow): number => {
    const cached = depths.get(row.sessionId)
    if (cached !== undefined) return cached
    if (row.parentSessionId === rootSessionId) {
      depths.set(row.sessionId, 1)
      return 1
    }
    const parent = byId.get(row.parentSessionId)
    const depth = parent === undefined ? 1 : depthOf(parent) + 1
    depths.set(row.sessionId, depth)
    return depth
  }
  for (const row of rows) depthOf(row)
  return depths
}

function appendCatalogDiagnostics(
  rows: TimelineDisplayRow[],
  options: {
    catalogs: Readonly<Record<string, SidebarSubagentCatalog>>
    nativeIds: ReadonlySet<string>
    parentSessionId: string
    depth: number
    seen: Set<string>
  },
): void {
  const catalog = options.catalogs[options.parentSessionId]
  if (catalog === undefined) return
  for (const entry of catalog.entries) {
    const id = entry.id
    if (!options.nativeIds.has(id) && !options.seen.has(id)) {
      options.seen.add(id)
      rows.push(diagnosticDisplayRow(entry, options.depth))
    }
    appendCatalogDiagnostics(rows, {
      ...options,
      parentSessionId: id,
      depth: options.depth + 1,
    })
  }
}

function diagnosticDisplayRow(entry: SidebarSubagentCatalog['entries'][number], depth: number): TimelineDisplayRow {
  return {
    id: entry.id,
    kind: 'diagnostic',
    title: entry.kind === 'child' ? entry.label ?? entry.id : entry.id,
    depth,
    segments: [],
    activeDurationMs: 0,
    wallDurationMs: 0,
    contextOnly: false,
    longRunning: false,
  }
}

function durationOf(segments: readonly TimelineSegment[], now: number, mode: 'active' | 'wall'): number {
  let total = 0
  for (const segment of segments) {
    if (mode === 'active' && segment.state.residency !== 'live') continue
    total += Math.max(0, (segment.end ?? now) - segment.start)
  }
  return total
}

function isLongRunning(
  row: AgentTimelineRow,
  segments: readonly TimelineSegment[],
  now: number,
  longRunningMinutes: number,
): boolean {
  if (longRunningMinutes === 0) return false
  const last = segments.at(-1)
  if (last === undefined || last.end !== undefined || last.state.residency !== 'live') return false
  const kind = last.state.turn.kind
  if (kind !== 'provisioning' && kind !== 'running') return false
  return now - last.start >= longRunningMinutes * 60 * 1_000
}

function displayRange(rows: readonly TimelineDisplayRow[], now: number): TimelineDisplay['range'] {
  let start: number | undefined
  let end: number | undefined
  for (const row of rows) {
    for (const segment of row.segments) {
      start = start === undefined ? segment.start : Math.min(start, segment.start)
      end = end === undefined ? (segment.end ?? now) : Math.max(end, segment.end ?? now)
    }
  }
  return start === undefined || end === undefined ? null : { start, end: Math.max(start + 1, end) }
}

export function formatAgentState(state: AgentState, locale: 'zh' | 'en'): string {
  if (locale === 'zh') return formatAgentStateZh(state)
  return formatAgentStateEn(state)
}

function formatAgentStateZh(state: AgentState): string {
  if (state.residency === 'closed') return '已关闭'
  if (state.residency === 'cold') return '已卸载'
  switch (state.turn.kind) {
    case 'provisioning': return '创建中'
    case 'running': return '运行中'
    case 'waiting': return '等待中'
    case 'idle': return '空闲'
    case 'completed': return '已完成'
    case 'interrupted': return '已中断'
    case 'errored': return '出错'
  }
}

function formatAgentStateEn(state: AgentState): string {
  if (state.residency === 'closed') return 'Closed'
  if (state.residency === 'cold') return 'Unloaded'
  switch (state.turn.kind) {
    case 'provisioning': return 'Provisioning'
    case 'running': return 'Running'
    case 'waiting': return 'Waiting'
    case 'idle': return 'Idle'
    case 'completed': return 'Completed'
    case 'interrupted': return 'Interrupted'
    case 'errored': return 'Errored'
  }
}

function cloneState(state: AgentState): AgentState {
  if (state.residency === 'closed') return { residency: 'closed' }
  if (state.residency === 'cold') return { residency: 'cold', lastTurn: state.lastTurn }
  switch (state.turn.kind) {
    case 'provisioning': return { residency: 'live', turn: { kind: 'provisioning' } }
    case 'running': return { residency: 'live', turn: { kind: 'running' } }
    case 'waiting':
      return {
        residency: 'live',
        turn: {
          kind: 'waiting',
          reason: state.turn.reason,
          since: state.turn.since,
          deadline: state.turn.deadline,
        },
      }
    case 'idle': return { residency: 'live', turn: { kind: 'idle' } }
    case 'completed':
      return {
        residency: 'live',
        turn: {
          kind: 'completed',
          ...(state.turn.stopReason === undefined ? {} : { stopReason: state.turn.stopReason }),
        },
      }
    case 'interrupted': return { residency: 'live', turn: { kind: 'interrupted' } }
    case 'errored': return { residency: 'live', turn: { kind: 'errored', code: state.turn.code } }
  }
}

interface NormalizedFilters {
  state: string
  model: string
  path: string
  text: string
  longRunningOnly: boolean
}

function normalizeFilters(filters: TimelineDisplayFilters): NormalizedFilters | null {
  const normalized = {
    state: (filters.state ?? 'all').trim().toLowerCase(),
    model: (filters.model ?? '').trim().toLowerCase(),
    path: (filters.path ?? '').trim().toLowerCase(),
    text: (filters.text ?? '').trim().toLowerCase(),
    longRunningOnly: filters.longRunningOnly === true,
  }
  return normalized.state === 'all'
    && normalized.model === ''
    && normalized.path === ''
    && normalized.text === ''
    && !normalized.longRunningOnly
    ? null
    : normalized
}

function rowMatchesFilters(row: TimelineDisplayRow, filters: NormalizedFilters): boolean {
  if (filters.state !== 'all' && stateFilterKey(row) !== filters.state) return false
  if (filters.longRunningOnly && !row.longRunning) return false
  if (filters.model !== '' && !modelText(row).includes(filters.model)) return false
  if (filters.path !== '' && !(row.path ?? '').toLowerCase().includes(filters.path)) return false
  if (filters.text !== '' && !searchText(row).includes(filters.text)) return false
  return true
}

function stateFilterKey(row: TimelineDisplayRow): string {
  if (row.state === undefined) return row.kind
  if (row.state.residency !== 'live') return row.state.residency
  return row.state.turn.kind
}

function modelText(row: TimelineDisplayRow): string {
  return row.model === undefined
    ? ''
    : [
        row.model.provider,
        row.model.model,
        row.model.reasoningEffort,
        row.model.serviceTier,
      ].filter(Boolean).join(' ').toLowerCase()
}

function searchText(row: TimelineDisplayRow): string {
  return [
    row.title,
    row.path,
    modelText(row),
    row.state === undefined ? undefined : formatAgentState(row.state, 'zh'),
    row.state === undefined ? undefined : formatAgentState(row.state, 'en'),
  ].filter(Boolean).join(' ').toLowerCase()
}
