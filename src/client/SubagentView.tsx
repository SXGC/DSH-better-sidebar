/**
 * Run Dashboard page: a stable tree row list plus a shared horizontal Gantt
 * timeline for the current root agent and all recoverable descendants.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconRefreshOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Context,
  SidebarContinuableSubagentAddress,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentAddress,
  SidebarSubagentControlOutcome,
  SidebarSubagentCatalog,
  SidebarJobView,
} from '../context-types.ts'
import type { AgentDetailResult, AgentTimelineResult, AgentState, SpawnModelSelection } from '../agent-timeline-routes.ts'
import {
  collectBranchIds,
  rootAncestor,
} from './subagent-detect.ts'
import {
  collectTreeJobs,
  isJobLive,
  orderJobs,
  resolveJobOwner,
  jobDotState,
  jobStatusLabel,
  type JobOwnerDisplayRow,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { IconStopOutline16 } from './icons.tsx'
import {
  agentStateKind,
  buildTimelineDisplay,
  countActiveFilters,
  displaySegments,
  filterTimelineDisplay,
  formatAgentState,
  formatDuration,
  normalizeLongRunningMinutes,
  timelineContentEnd,
  timelineTicks,
  type TimelineDisplay,
  type TimelineDisplayFilters,
  type TimelineDisplayRow,
  type TimelineSegment,
} from './agent-timeline.ts'
import {
  clampRunDashboardTreeWidth,
  defaultRunDashboardTreeWidth,
  PANEL_DEFAULT,
  RUN_DASHBOARD_TREE_MIN,
  type SidebarStore,
} from './state.ts'
import { isZh, t } from './locales.ts'
import css from './SubagentView.module.css'

/** Refresh cadence of an expanded job-output panel while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000
/** How long the agent close button stays armed before it needs re-confirming. */
const AGENT_CLOSE_ARM_MS = 3000

/**
 * The shared output dock of the jobs section: ONE pane at the bottom of the
 * sidebar body (sticky, terminal-like) shows the SELECTED job's output as
 * the MODEL has read it so far (replayed from the owner session's event
 * log), refreshed every {@link JOB_POLL_MS} while the job runs and the
 * page is visible. The model's `job_output` cursor is never touched — the
 * pane can never steal the agent's bytes, and it stays empty until the
 * agent reads the job. A single dock — not a panel per row — keeps the
 * job list compact and stable when many jobs are running.
 */
function JobOutputPane(props: {
  ownerSessionId: string
  job: SidebarJobView
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
  onClose: () => void
}) {
  const { ownerSessionId, job, active, onClose } = props
  const [state, setState] = useState<'loading' | JobOutputResult | 'error'>('loading')
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await api.jobOutput({ sessionId: ownerSessionId }, job.id, controller.signal)
      setState(result)
    } catch {
      // A newer pull aborted this one, or the wire failed: keep the last
      // known output; only a dock that never loaded anything shows an error.
      setState(current => (current === 'loading' ? 'error' : current))
    }
  }, [ownerSessionId, job.id])

  useEffect(() => {
    if (!active) return
    void load()
    if (!isJobLive(job)) return
    const timer = window.setInterval(() => { void load() }, JOB_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, active, job.status])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // Terminal-tail behavior: while the job runs, each refresh pins the view
  // to the newest output; a settled dock leaves scrolling to the reader.
  useEffect(() => {
    if (!isJobLive(job) || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
  }, [state, job.status])

  return (
    <div className={css.jobsPane} role="region" aria-label={`${job.label} ${t('jobs')}`}>
      <div className={css.jobsPaneHeader}>
        <StateDot state={jobDotState(job.status)} className={css.jobsPaneDot} />
        <span className={css.jobsPaneLabel} title={job.label}>{job.label}</span>
        <span className={css.jobsPaneStatus}>
          {jobStatusLabel(job.status, t)}
          {job.detail !== undefined && job.detail !== '' ? ` · ${job.detail}` : ''}
        </span>
        <button
          type="button"
          className={css.jobsPaneClose}
          aria-label={t('close')}
          title={t('close')}
          onClick={onClose}
        >
          <IconStopOutline16 size={10} />
        </button>
      </div>
      {state === 'loading' && <div className={css.jobsPaneHint}>{t('loading')}</div>}
      {state === 'error' && (
        <div className={`${css.jobsPaneHint} ${css.jobsPaneError}`}>{t('jobOutputError')}</div>
      )}
      {typeof state === 'object' && (
        <>
          {state.text.length > 0
            ? <pre ref={preRef} className={css.jobsPanePre}>{state.text}</pre>
            : state.read
              ? <div className={css.jobsPaneHint}>{t('jobNoOutput')}</div>
              : <div className={css.jobsPaneHint}>{t('jobNotReadYet')}</div>}
          {state.truncated && <div className={css.jobsPaneHint}>{t('jobOutputTruncated')}</div>}
        </>
      )}
    </div>
  )
}

/**
 * The background-job section of the Subagent page: every job of the whole
 * current tree (main agent + subagents, owner-labeled), fed by the harness
 * `session/jobs` push mirror. Clicking a row feeds its model-read output to
 * the shared bottom dock (event replay — never the model's cursor); live
 * rows carry a two-click-confirm kill button. Renders nothing while the
 * tree has no jobs.
 */
function JobsSection(props: {
  byId: SidebarSessionList['byId']
  jobsBySession: SidebarSessionList['jobsBySession']
  rootId: string | undefined
  ownerRows: readonly JobOwnerDisplayRow[] | undefined
  locatedOwnerId: string | undefined
  onLocateOwner: (ownerSessionId: string) => void
  /**
   * Selection lives in the page: the job output pane and the agent detail
   * panel share the one sticky bottom dock, so opening either closes the
   * other instead of stacking two docks on the same edge.
   */
  selectedJobId: string | undefined
  onSelectJob: (jobId: string | undefined) => void
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
}) {
  const { byId, jobsBySession, rootId, ownerRows, locatedOwnerId, onLocateOwner, active } = props
  const { selectedJobId: selectedId, onSelectJob } = props
  const rows = useMemo(
    () => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)),
    [byId, jobsBySession, rootId],
  )
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  const [killingId, setKillingId] = useState<string | undefined>(undefined)
  const [killErrorId, setKillErrorId] = useState<string | undefined>(undefined)
  // The duration clock only runs while a live row is on screen.
  const [now, setNow] = useState(() => Date.now())

  const selectedRow = useMemo(
    () => (selectedId === undefined ? undefined : rows.find(row => row.job.id === selectedId)),
    [rows, selectedId],
  )

  const liveCount = useMemo(
    () => rows.reduce((count, row) => count + (isJobLive(row.job) ? 1 : 0), 0),
    [rows],
  )
  // The kill button stays armed only briefly; a stray click must never kill.
  useEffect(() => {
    if (armedId === undefined) return
    const timer = window.setTimeout(() => { setArmedId(undefined) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedId])

  useEffect(() => {
    if (!active || liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [active, liveCount])

  // The docked output pane follows its job: when the selected job leaves
  // the mirror (settled and dropped, or the tree switched), close the dock.
  useEffect(() => {
    if (selectedId !== undefined && selectedRow === undefined) onSelectJob(undefined)
  }, [selectedId, selectedRow, onSelectJob])

  // NOTE: every hook must live ABOVE the empty-state return — a hook below it
  // would flip this component's hook count when the mirror empties and crash
  // React with "Rendered fewer hooks than expected" (the #300 regression).
  const kill = useCallback(async (row: TreeJob): Promise<void> => {
    setKillingId(row.job.id)
    setKillErrorId(undefined)
    try {
      await api.jobKill({ sessionId: row.ownerSessionId }, row.job.id)
    } catch {
      setKillErrorId(row.job.id)
    } finally {
      setKillingId(undefined)
      setArmedId(undefined)
    }
  }, [])

  if (rows.length === 0) return null

  const countLabel = liveCount > 0
    ? t('jobsCountRunning', { count: rows.length, running: liveCount })
    : t('jobsCount', { count: rows.length })

  return (
    <>
      <section className={css.jobs} aria-label={t('jobs')}>
        <div className={css.jobsHeader}>
          <span className={css.jobsTitle}>{t('jobs')}</span>
          <span className={css.jobsCount}>{countLabel}</span>
        </div>
        <ul className={css.jobsList} aria-label={t('jobs')}>
          {rows.map((row) => {
            const { job } = row
            const live = isJobLive(job)
            const selected = selectedId === job.id
            const armed = armedId === job.id
            const killing = killingId === job.id
            const killFailed = killErrorId === job.id
            const owner = resolveJobOwner(row, ownerRows)
            const elapsed = live
              ? now - job.startedAt
              : (job.finishedAt ?? job.startedAt) - job.startedAt
            const secondary = [
              jobStatusLabel(job.status, t),
              ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              formatDuration(elapsed, t),
            ].filter(Boolean).join(' · ')
            return (
              <li
                key={job.id}
                className={clsx(
                  css.jobsRow,
                  !live && css.jobsRowSettled,
                  selected && css.jobsRowSelected,
                )}
              >
                <button
                  type="button"
                  className={css.jobsRowMain}
                  aria-pressed={selected}
                  aria-label={`${job.label} ${secondary}`}
                  onClick={() => { onSelectJob(selected ? undefined : job.id) }}
                >
                  <StateDot state={jobDotState(job.status)} className={css.jobsDot} />
                  <span className={css.jobsContent}>
                    <span className={css.jobsLabelLine}>
                      <span className={css.jobsKind}>{job.kind}</span>
                      <span className={css.jobsLabel} title={job.label}>{job.label}</span>
                    </span>
                    <span className={css.jobsSecondary}>{secondary}</span>
                  </span>
                </button>
                {owner.linked ? (
                  <button
                    type="button"
                    className={clsx(css.jobsOwner, locatedOwnerId === owner.ownerSessionId && css.jobsOwnerActive)}
                    aria-label={t('jobOwnerLocate', { owner: owner.ownerTitle })}
                    title={t('jobOwnerLocate', { owner: owner.ownerTitle })}
                    onClick={(event) => {
                      event.stopPropagation()
                      onLocateOwner(owner.ownerSessionId)
                    }}
                  >
                    {owner.displayTitle ?? owner.ownerTitle}
                  </button>
                ) : (
                  <span
                    className={css.jobsOwnerUnlinked}
                    title={`${owner.ownerTitle} · ${t('jobOwnerUnlinked')}`}
                  >
                    {owner.ownerTitle} · {t('jobOwnerUnlinked')}
                  </span>
                )}
                {job.status === 'running' && (
                  <button
                    type="button"
                    className={armed ? `${css.jobsKill} ${css.jobsKillArmed}` : css.jobsKill}
                    aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                    title={armed ? t('jobKillConfirm') : t('jobKill')}
                    disabled={killing}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (armed) void kill(row)
                      else setArmedId(job.id)
                    }}
                  >
                    {armed ? t('jobKillConfirm') : <IconStopOutline16 size={12} />}
                  </button>
                )}
                {killFailed && <span className={css.jobsKillError}>{t('jobKillError')}</span>}
              </li>
            )
          })}
        </ul>
      </section>
      {selectedRow !== undefined && (
        <JobOutputPane
          ownerSessionId={selectedRow.ownerSessionId}
          job={selectedRow.job}
          active={active}
          onClose={() => { onSelectJob(undefined) }}
        />
      )}
    </>
  )
}

/**
 * Narrowest sidebar that still fits a readable tree column NEXT TO a shared
 * gantt canvas. Below it the page falls back to the row list, whose per-row
 * spark bar carries the same comparable spans — a 360px sidebar split into
 * two columns leaves both a stub, which is worse than one good list.
 */
const RUN_DASHBOARD_GANTT_MIN_PANEL = 520
const TIMELINE_BASE_WIDTH = 600
const TIMELINE_PAN_STEP = 64
const TIMELINE_ZOOM_FACTOR = 1.25
/**
 * Zoom bounds shared by the buttons and fit-all. The ceiling must leave
 * fit-all room to stretch a mostly-idle range (activity in the first hour,
 * open tail running to now) until the ACTIVE part fills the viewport.
 */
const TIMELINE_MIN_ZOOM = 0.25
const TIMELINE_MAX_ZOOM = 64
/** Fit-all's breathing room after the last bar, so it never kisses the edge. */
const TIMELINE_FIT_PADDING_PX = 24
const TREE_KEYBOARD_STEP = 16
/** Narrowest gantt bar that can carry its state word without clipping it. */
const SEGMENT_LABEL_MIN_PX = 54

type TimelineLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; timeline: AgentTimelineResult }
  | { kind: 'error'; message: string }

type AgentDetailLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; agentSessionId: string }
  | { kind: 'ready'; agentSessionId: string; detail: AgentDetailResult }
  | { kind: 'error'; agentSessionId: string; message: string }

type AgentControlAction = 'interrupt' | 'close'

type AgentControlState =
  | { kind: 'idle' }
  | { kind: 'loading'; agentSessionId: string; action: AgentControlAction }
  | { kind: 'done'; agentSessionId: string; action: AgentControlAction; outcome: SidebarSubagentControlOutcome }
  | { kind: 'error'; agentSessionId: string; action: AgentControlAction; outcome: SidebarSubagentControlOutcome }

const STATE_FILTER_OPTIONS = [
  'all',
  'provisioning',
  'running',
  'waiting',
  'idle',
  'completed',
  'interrupted',
  'errored',
  'cold',
  'closed',
] as const

/**
 * The layout the dashboard can actually afford. The PANEL's width decides it
 * — a 360px sidebar inside a 1600px window must never claim the desktop
 * split, or the tree column eats the gantt and both end up stubs. The body
 * element refines the number once it has been measured (the panel width is
 * the outer shell). Environments without ResizeObserver (jsdom) keep the
 * panel width.
 */
function useDashboardLayout(
  bodyRef: React.RefObject<HTMLDivElement | null>,
  panelWidth: number,
): 'grid' | 'list' {
  const [measured, setMeasured] = useState<number | undefined>(undefined)

  useEffect(() => {
    const body = bodyRef.current
    if (body === null || typeof ResizeObserver === 'undefined') return
    // Width never feeds back into the body's own width, so this cannot loop.
    const measure = (): void => {
      setMeasured(current => (body.clientWidth > 0 ? body.clientWidth : current))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    measure()
    return () => { observer.disconnect() }
  }, [bodyRef])

  const width = measured ?? Math.round(panelWidth)
  return width >= RUN_DASHBOARD_GANTT_MIN_PANEL ? 'grid' : 'list'
}

/** The state word in the active locale: every surface spells it the same. */
function stateWord(state: AgentState): string {
  return formatAgentState(state, isZh() ? 'zh' : 'en')
}

function agentRowState(row: TimelineDisplay['rows'][number]): string {
  if (row.state === undefined) return row.kind === 'diagnostic' ? t('subagentDiagUnavailable') : t('subagentInactive')
  return stateWord(row.state)
}

function stateFilterLabel(value: string): string {
  if (value === 'all') return t('runDashboardFilterAll')
  if (value === 'cold') return stateWord({ residency: 'cold', lastTurn: 'idle' })
  if (value === 'closed') return stateWord({ residency: 'closed' })
  let state: AgentState
  switch (value) {
    case 'waiting':
      state = { residency: 'live', turn: { kind: 'waiting', reason: 'mailbox', since: 0, deadline: 0 } }
      break
    case 'completed':
      state = { residency: 'live', turn: { kind: 'completed' } }
      break
    case 'errored':
      state = { residency: 'live', turn: { kind: 'errored', code: 'error' } }
      break
    case 'provisioning':
      state = { residency: 'live', turn: { kind: 'provisioning' } }
      break
    case 'running':
      state = { residency: 'live', turn: { kind: 'running' } }
      break
    case 'idle':
      state = { residency: 'live', turn: { kind: 'idle' } }
      break
    case 'interrupted':
      state = { residency: 'live', turn: { kind: 'interrupted' } }
      break
    default:
      state = { residency: 'live', turn: { kind: 'idle' } }
  }
  return stateWord(state)
}

function formatTime(value: number | undefined): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString()
}

function timelineWidth(zoom: number): number {
  return Math.round(TIMELINE_BASE_WIDTH * zoom)
}

function clampZoom(zoom: number): number {
  return Math.min(TIMELINE_MAX_ZOOM, Math.max(TIMELINE_MIN_ZOOM, zoom))
}

/**
 * The zoom that makes the drawn activity span exactly fill a viewport (minus
 * the trailing padding): range→content stretches the canvas past the blank
 * tail, viewport→base scales it to the actual panel. Undefined when nothing
 * is measured or drawn yet — the caller falls back to the neutral zoom.
 */
function fitZoom(
  viewportPx: number,
  range: TimelineDisplay['range'],
  contentEnd: number | undefined,
): number | undefined {
  const viewport = viewportPx - TIMELINE_FIT_PADDING_PX
  if (viewport <= 0 || range === null || contentEnd === undefined) return undefined
  const span = Math.max(1, range.end - range.start)
  const contentSpan = Math.max(1, Math.min(contentEnd, range.end) - range.start)
  return clampZoom((span / contentSpan) * (viewport / TIMELINE_BASE_WIDTH))
}

/** A segment's placement on the shared range, in percent of the canvas. */
function segmentGeometry(
  segment: TimelineSegment,
  range: NonNullable<TimelineDisplay['range']>,
  now: number,
): { left: number; width: number } {
  const span = Math.max(1, range.end - range.start)
  const duration = (segment.end ?? now) - segment.start
  return {
    left: ((segment.start - range.start) / span) * 100,
    // Only a genuinely instant transition needs a hairline. Giving every
    // short span the same minimum makes it extend over its next state.
    width: duration === 0 ? 0.5 : Math.max(0, (duration / span) * 100),
  }
}

/** Short axis stamp: seconds only matter once the grid is finer than a minute. */
function formatTick(time: number, stepMs: number): string {
  return new Date(time).toLocaleTimeString([], stepMs < 60_000
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' })
}

function modelLabel(model: SpawnModelSelection | undefined): string {
  if (model === undefined) return '—'
  return [
    `${model.provider}/${model.model}`,
    model.reasoningEffort,
    model.serviceTier,
  ].filter(Boolean).join(' · ')
}

function forkTurnsLabel(value: AgentDetailResult['forkTurns']): string {
  return typeof value === 'number' ? String(value) : value
}

function operationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `run-dashboard-close-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function agentAddress(row: TimelineDisplayRow): SidebarSubagentAddress | undefined {
  return row.kind === 'agent' && row.parentSessionId !== undefined && row.mode !== undefined
    ? { parentSessionId: row.parentSessionId, childSessionId: row.id, mode: row.mode }
    : undefined
}

function continuableAgentAddress(row: TimelineDisplayRow): SidebarContinuableSubagentAddress | undefined {
  const address = agentAddress(row)
  return address?.mode === 'continuable' ? address as SidebarContinuableSubagentAddress : undefined
}

function rootScopedControlAddress(
  rootSessionId: string | undefined,
  row: TimelineDisplayRow,
): SidebarContinuableSubagentAddress | undefined {
  const address = continuableAgentAddress(row)
  return address === undefined || rootSessionId === undefined
    ? undefined
    : { parentSessionId: rootSessionId, childSessionId: address.childSessionId, mode: 'continuable' }
}

function canInterruptAgent(row: TimelineDisplayRow): boolean {
  if (continuableAgentAddress(row) === undefined || row.state?.residency !== 'live') return false
  return row.state.turn.kind === 'running' || row.state.turn.kind === 'waiting'
}

function canCloseAgent(row: TimelineDisplayRow): boolean {
  return continuableAgentAddress(row) !== undefined && row.state?.residency !== 'closed'
}

function detailProperties(detail: AgentDetailResult): Array<readonly [string, string]> {
  return [
    ['backend', detail.backend],
    ['forkTurns', forkTurnsLabel(detail.forkTurns)],
    ['requestedModel', modelLabel(detail.requestedModelSelection)],
    ['effectiveModel', modelLabel(detail.effectiveModelSelection)],
    ['tools', detail.allowedTools.length === 0 ? '—' : detail.allowedTools.join(', ')],
    ['sandbox', detail.sandboxMode ?? '—'],
    ['approval', detail.approvalPolicy ?? '—'],
    ['filesystem', detail.filesystemPolicy],
  ]
}

type UnavailableInitialTaskReason = Extract<AgentDetailResult['initialTask'], { available: false }>['reason']

function initialTaskUnavailableLabel(reason: UnavailableInitialTaskReason): string {
  return reason === 'not-accepted'
    ? t('runDashboardDetailTaskNotAccepted')
    : t('runDashboardDetailTaskSessionUnavailable')
}

function agentControlOutcomeLabel(action: AgentControlAction, outcome: SidebarSubagentControlOutcome): string {
  if (outcome === 'accepted') {
    return action === 'interrupt'
      ? t('runDashboardControlInterruptAccepted')
      : t('runDashboardControlCloseAccepted')
  }
  switch (outcome) {
    case 'forbidden': return t('runDashboardControlForbidden')
    case 'not-found': return t('runDashboardControlNotFound')
    case 'not-live': return t('runDashboardControlNotLive')
    case 'closed': return t('runDashboardControlClosed')
    case 'failed': return t('runDashboardControlFailed')
  }
}

function catalogSignature(
  rootId: string | undefined,
  catalogs: Readonly<Record<string, SidebarSubagentCatalog>>,
  byId: Readonly<Record<string, SidebarSessionSummary>>,
): string {
  if (rootId === undefined) return ''
  const rows = [rootId, ...collectBranchIds(catalogs, rootId)].map((id) => {
    const catalog = catalogs[id]
    const summary = byId[id]
    return [
      id,
      summary?.running === true ? 'running' : 'idle',
      catalog?.state ?? 'missing',
      ...(catalog?.entries ?? []).map(entry => entry.kind === 'child'
        ? `${entry.id}:${entry.activity}:${entry.mode}:${entry.hasChildren ? 1 : 0}`
        : `${entry.id}:diagnostic:${entry.reason}`),
    ].join('|')
  })
  return rows.join('\n')
}

/**
 * The gantt bars of one row, laid out on the SHARED display range so two
 * rows' spans are comparable by eye. Used twice: as the wide canvas lane and
 * as the per-row spark strip of the narrow list — same geometry, same state
 * classes, so a bar means the same thing in both layouts.
 */
function TimelineBars(props: {
  row: TimelineDisplayRow
  range: TimelineDisplay['range']
  now: number
  /** Canvas width in px; a bar narrower than a label stays wordless. */
  labelWidth?: number
  className?: string
}) {
  const { row, range, now, labelWidth, className } = props
  if (range === null) return <span className={className} />
  // Slivers below ~3px of track merge into their neighbour: the spark reads
  // as phases, not confetti. The canvas keeps detail as the zoom grows.
  const minFraction = labelWidth === undefined ? 0.01 : 3 / Math.max(1, labelWidth)
  const segments = displaySegments(row.segments, range, now, minFraction)
  const bandStart = row.startedAt ?? segments[0]?.start
  const bandEnd = segments.reduce((end, segment) => Math.max(end, segment.end ?? now), bandStart ?? 0)
  return (
    <span className={className}>
      {bandStart !== undefined && segments.length > 0 && (
        <span
          className={css.runDashboardBand}
          style={(({ left, width }) => ({ left: `${left}%`, width: `${width}%` }))(
            segmentGeometry({ start: bandStart, end: bandEnd, state: row.segments[0]!.state }, range, now),
          )}
          aria-hidden="true"
        />
      )}
      {segments.map((segment, index) => {
        const kind = agentStateKind(segment.state)
        const { left, width } = segmentGeometry(segment, range, now)
        const label = stateWord(segment.state)
        const showLabel = labelWidth !== undefined && (width / 100) * labelWidth >= SEGMENT_LABEL_MIN_PX
        return (
          <span
            key={`${row.id}:${index}:${segment.start}`}
            className={css.runDashboardSegment}
            data-segment-state={kind}
            data-segment-open={segment.end === undefined ? 'true' : undefined}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={label}
          >
            {showLabel ? label : ''}
          </span>
        )
      })}
    </span>
  )
}

/** The mark/word/tint key of a row: the state kind, or the row kind for
 * stateless rows (diagnostic entries, catalog-only agents). */
function agentMarkKind(row: TimelineDisplayRow): string {
  return row.state === undefined ? row.kind : agentStateKind(row.state)
}

/**
 * Attention tier of a state kind. Drives the colour of the right-hand status
 * text and whether the state word is spelled out on the row at all: settled
 * states ("silent") keep only the mark + duration, with the word demoted to
 * the tooltip and an sr-only span.
 */
function statusTier(kind: string): 'active' | 'attention' | 'error' | 'muted' {
  switch (kind) {
    case 'provisioning':
    case 'running':
      return 'active'
    case 'waiting':
    case 'interrupted':
      return 'attention'
    case 'errored':
      return 'error'
    default:
      return 'muted'
  }
}

/** Settled states whose word lives in the tooltip, not on the row. */
function statusWordSilent(kind: string): boolean {
  return kind === 'completed' || kind === 'cold' || kind === 'closed'
}

/**
 * Status as a distinct SHAPE per state (filled/dashed/hollow dot, check,
 * cross, pause, slash, dashed square), so a greyscale screenshot or a
 * colour-blind reader still tells every state apart; colour only reinforces.
 */
function AgentStateMark(props: { row: TimelineDisplayRow }) {
  const kind = agentMarkKind(props.row)
  let glyph: React.ReactNode = null
  if (kind === 'completed') {
    glyph = (
      <svg width="11" height="11" viewBox="0 0 12 12">
        <path d="M2 6.5 L4.8 9.2 L10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  } else if (kind === 'errored') {
    glyph = (
      <svg width="10" height="10" viewBox="0 0 10 10">
        <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  } else if (kind === 'interrupted') {
    glyph = (
      <svg width="11" height="11" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="4.5" y1="3.8" x2="4.5" y2="8.2" stroke="currentColor" strokeWidth="1.5" />
        <line x1="7.5" y1="3.8" x2="7.5" y2="8.2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    )
  } else if (kind === 'closed') {
    glyph = (
      <svg width="11" height="11" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <line x1="2.9" y1="9.1" x2="9.1" y2="2.9" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  } else if (kind === 'diagnostic' || kind === 'agent' || kind === 'root') {
    glyph = (
      <svg width="11" height="11" viewBox="0 0 12 12">
        <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.5 1.8" />
      </svg>
    )
  }
  return (
    <span className={css.runDashboardMark} data-shape={kind} aria-hidden="true">
      {glyph}
    </span>
  )
}

function RunDashboardTreeRow(props: {
  row: TimelineDisplayRow
  /** Draw the per-row spark strip (the list layout has no shared canvas). */
  range: TimelineDisplay['range'] | undefined
  now: number
  /** Whether this row's action buttons are revealed (click-toggled). */
  actionsOpen: boolean
  onToggleActions: (row: TimelineDisplayRow) => void
  selectedAgentId: string | undefined
  locatedOwnerId: string | undefined
  armedCloseId: string | undefined
  controlState: AgentControlState
  onOpenAgent: (row: TimelineDisplayRow) => void
  onSelectAgent: (agentSessionId: string) => void
  onInterruptAgent: (row: TimelineDisplayRow) => void
  onCloseAgent: (row: TimelineDisplayRow) => void
}) {
  const {
    row,
    range,
    now,
    actionsOpen,
    onToggleActions,
    selectedAgentId,
    locatedOwnerId,
    armedCloseId,
    controlState,
    onOpenAgent,
    onSelectAgent,
    onInterruptAgent,
    onCloseAgent,
  } = props
  const rowControl = controlState.kind !== 'idle' && controlState.agentSessionId === row.id
    ? controlState
    : undefined
  const closeArmed = armedCloseId === row.id
  const active = formatDuration(row.activeDurationMs, t)
  const segments = t('runDashboardSegmentCount', { count: row.segments.length })
  const durationTitle = t('runDashboardDurationSummary', {
    active,
    wall: formatDuration(row.wallDurationMs, t),
    segments,
  })
  const kind = agentMarkKind(row)
  const word = agentRowState(row)
  const silent = statusWordSilent(kind)
  // The path lives in the title tooltip (the title IS the leaf); the meta
  // line always spells the effective model selection for an agent card.
  const meta = row.model === undefined ? '' : modelLabel(row.model)
  const span = row.kind === 'diagnostic'
    ? t('runDashboardTimeUnavailable')
    : `${formatTime(row.startedAt)} → ${row.endedAt === undefined ? t('runDashboardRunning') : formatTime(row.endedAt)}`
      + ` · ${t('runDashboardWallDuration')} ${formatDuration(row.wallDurationMs, t)} · ${segments}`
  const canInterrupt = canInterruptAgent(row)
  const canClose = canCloseAgent(row)

  return (
    <div
      role="row"
      aria-level={row.depth + 1}
      className={clsx(
        css.runDashboardRow,
        row.kind === 'root' && css.runDashboardRootRow,
        row.kind === 'agent' && css.runDashboardClickableRow,
        row.contextOnly && css.runDashboardContextRow,
        locatedOwnerId === row.id && css.runDashboardOwnerLocated,
      )}
      data-run-dashboard-row-id={row.id}
      data-owner-highlighted={locatedOwnerId === row.id ? 'true' : undefined}
      data-actions-open={actionsOpen ? 'true' : undefined}
      style={{ '--run-depth': row.depth } as CSSProperties}
      onClick={row.kind === 'agent' ? () => { onToggleActions(row) } : undefined}
    >
      <span className={css.runDashboardRowHeader}>
        <AgentStateMark row={row} />
        <span
          className={css.runDashboardRowTitle}
          title={row.path === undefined || row.path === '' ? row.title : `${row.title} · ${row.path}`}
        >
          {row.title}
        </span>
        {row.longRunning && <span className={css.runDashboardWarn}>{t('runDashboardLongRunning')}</span>}
        <span
          className={css.runDashboardRowStatus}
          data-status-tier={statusTier(kind)}
          title={silent ? `${word} · ${durationTitle}` : durationTitle}
        >
          <span className={css.runDashboardSrOnly}>{t('runDashboardActiveDuration')} </span>
          {row.kind === 'diagnostic' ? word : silent ? active : `${word} · ${active}`}
          {silent && <span className={css.runDashboardSrOnly}> {word}</span>}
        </span>
        {row.kind === 'agent' && (
          <span
            className={css.runDashboardActions}
            role="group"
            aria-label={t('runDashboardAgentActions', { title: row.title })}
            onClick={(event) => { event.stopPropagation() }}
          >
            <button
              type="button"
              className={clsx(css.runDashboardActionButton, css.runDashboardActionPrimary)}
              aria-label={`${t('runDashboardOpenChat')} ${row.title}`}
              onClick={() => { onOpenAgent(row) }}
            >
              {t('runDashboardOpenChat')}
            </button>
            <button
              type="button"
              className={clsx(css.runDashboardActionButton, selectedAgentId === row.id && css.runDashboardActionActive)}
              aria-label={`${t('runDashboardDetails')} ${row.title}`}
              aria-pressed={selectedAgentId === row.id}
              onClick={() => { onSelectAgent(row.id) }}
            >
              {t('runDashboardDetails')}
            </button>
            {(canInterrupt || canClose) && (
              <span className={css.runDashboardActionsDanger}>
                {canInterrupt && (
                  <button
                    type="button"
                    className={css.runDashboardActionButton}
                    aria-label={`${t('runDashboardInterrupt')} ${row.title}`}
                    disabled={rowControl?.kind === 'loading'}
                    onClick={() => { onInterruptAgent(row) }}
                  >
                    {t('runDashboardInterrupt')}
                  </button>
                )}
                {canClose && (
                  <button
                    type="button"
                    className={clsx(css.runDashboardActionButton, closeArmed && css.runDashboardDangerButton)}
                    aria-label={`${closeArmed ? t('runDashboardConfirmClose') : t('runDashboardCloseAgent')} ${row.title}`}
                    disabled={rowControl?.kind === 'loading'}
                    onClick={() => { onCloseAgent(row) }}
                  >
                    {closeArmed ? t('runDashboardConfirmClose') : t('runDashboardCloseAgent')}
                  </button>
                )}
              </span>
            )}
          </span>
        )}
      </span>
      {range !== undefined && (
        <TimelineBars
          row={row}
          range={range}
          now={now}
          className={css.runDashboardSpark}
        />
      )}
      <span className={css.runDashboardRowMeta}>
        {meta !== '' && <span className={css.runDashboardMeta} title={meta}>{meta}</span>}
        <span className={css.runDashboardRowSpan} title={span}>{span}</span>
      </span>
      {rowControl !== undefined && (
        <span className={clsx(
          css.runDashboardControlResult,
          rowControl.kind === 'error' && css.runDashboardControlError,
        )} role="status" aria-live="polite">
          {rowControl.kind === 'loading'
            ? t('loading')
            : agentControlOutcomeLabel(rowControl.action, rowControl.outcome)}
        </span>
      )}
    </div>
  )
}

/**
 * Keep every gantt lane exactly as tall as its tree row. The two live in
 * separate scroll columns, so nothing but equal heights aligns them — and row
 * height is content-driven (locale, wrapped actions, a control result), which
 * a fixed height would silently desync. Environments without ResizeObserver
 * (jsdom) fall back to the CSS min-height both sides share.
 */
function useLaneHeights(
  treeRef: React.RefObject<HTMLDivElement | null>,
  rowKey: string,
): Record<string, number> {
  const [heights, setHeights] = useState<Record<string, number>>({})
  useEffect(() => {
    const tree = treeRef.current
    if (tree === null || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const next: Record<string, number> = {}
      for (const element of tree.querySelectorAll<HTMLElement>('[data-run-dashboard-row-id]')) {
        const id = element.dataset.runDashboardRowId
        if (id !== undefined) next[id] = element.offsetHeight
      }
      setHeights(current => {
        const keys = Object.keys(next)
        const same = keys.length === Object.keys(current).length
          && keys.every(id => current[id] === next[id])
        return same ? current : next
      })
    }
    // Lanes never feed back into row height, so this observer cannot loop.
    const observer = new ResizeObserver(measure)
    observer.observe(tree)
    for (const element of tree.querySelectorAll<HTMLElement>('[data-run-dashboard-row-id]')) {
      observer.observe(element)
    }
    measure()
    return () => { observer.disconnect() }
  }, [treeRef, rowKey])
  return heights
}

function RunDashboardRows(props: {
  display: TimelineDisplay
  now: number
  zoom: number
  scrollerRef: React.RefObject<HTMLDivElement>
  treeWidth: number
  maxTreeWidth: number
  setTreeWidth: (width: number) => void
  openActionsId: string | undefined
  onToggleActions: (row: TimelineDisplayRow) => void
  selectedAgentId: string | undefined
  locatedOwnerId: string | undefined
  onSelectAgent: (agentSessionId: string) => void
  armedCloseId: string | undefined
  controlState: AgentControlState
  onOpenAgent: (row: TimelineDisplayRow) => void
  onInterruptAgent: (row: TimelineDisplayRow) => void
  onCloseAgent: (row: TimelineDisplayRow) => void
}) {
  const {
    display,
    now,
    zoom,
    scrollerRef,
    treeWidth,
    maxTreeWidth,
    setTreeWidth,
    openActionsId,
    onToggleActions,
    selectedAgentId,
    locatedOwnerId,
    onSelectAgent,
    armedCloseId,
    controlState,
    onOpenAgent,
    onInterruptAgent,
    onCloseAgent,
  } = props
  const width = timelineWidth(zoom)
  const range = display.range
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const laneHeights = useLaneHeights(treeRef, display.rows.map(row => row.id).join('\u0000'))
  const ticks = useMemo(() => timelineTicks(range, width), [range, width])
  const tickStep = ticks.length > 1 ? ticks[1]!.time - ticks[0]!.time : 60_000

  const setClampedTreeWidth = useCallback((next: number): void => {
    setTreeWidth(Math.min(maxTreeWidth, Math.max(RUN_DASHBOARD_TREE_MIN, Math.round(next))))
  }, [maxTreeWidth, setTreeWidth])

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const start = dragStartRef.current
      if (start === null) return
      setClampedTreeWidth(start.width + event.clientX - start.x)
    }
    const onUp = (): void => {
      dragStartRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [setClampedTreeWidth])

  return (
    <div className={css.runDashboardGrid} role="treegrid" aria-label={t('subagent')}>
      <div className={css.runDashboardTree} style={{ width: treeWidth }} ref={treeRef}>
        <div className={css.runDashboardTreeHead} aria-hidden="true" />
        {display.rows.map(row => (
          <RunDashboardTreeRow
            key={row.id}
            row={row}
            range={undefined}
            now={now}
            actionsOpen={openActionsId === row.id}
            onToggleActions={onToggleActions}
            selectedAgentId={selectedAgentId}
            locatedOwnerId={locatedOwnerId}
            armedCloseId={armedCloseId}
            controlState={controlState}
            onOpenAgent={onOpenAgent}
            onSelectAgent={onSelectAgent}
            onInterruptAgent={onInterruptAgent}
            onCloseAgent={onCloseAgent}
          />
        ))}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={RUN_DASHBOARD_TREE_MIN}
        aria-valuemax={maxTreeWidth}
        aria-valuenow={treeWidth}
        className={css.runDashboardSplitter}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture?.(event.pointerId)
          dragStartRef.current = { x: event.clientX, width: treeWidth }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setClampedTreeWidth(treeWidth - TREE_KEYBOARD_STEP)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            setClampedTreeWidth(treeWidth + TREE_KEYBOARD_STEP)
          }
        }}
      />
      <div className={css.runDashboardTimeline} data-timeline-scroller ref={scrollerRef}>
        <div
          className={css.runDashboardCanvas}
          data-timeline-canvas
          data-timeline-width={width}
          data-timeline-range-ms={range === null ? undefined : range.end - range.start}
          style={{ width }}
        >
          <div className={css.runDashboardScale} aria-hidden="true">
            {ticks.map(tick => (
              <span
                key={tick.time}
                className={css.runDashboardTick}
                data-timeline-tick
                style={{ left: `${tick.ratio * 100}%` }}
              >
                {formatTick(tick.time, tickStep)}
              </span>
            ))}
          </div>
          <div className={css.runDashboardLanes}>
            {ticks.map(tick => (
              <span
                key={tick.time}
                className={css.runDashboardGridline}
                data-timeline-gridline
                style={{ left: `${tick.ratio * 100}%` }}
                aria-hidden="true"
              />
            ))}
            {display.rows.map(row => (
              <div
                key={row.id}
                className={clsx(css.runDashboardLane, locatedOwnerId === row.id && css.runDashboardOwnerLocated)}
                data-run-dashboard-lane-id={row.id}
                data-owner-highlighted={locatedOwnerId === row.id ? 'true' : undefined}
                style={laneHeights[row.id] === undefined ? undefined : { height: laneHeights[row.id] }}
              >
                <TimelineBars
                  row={row}
                  range={range}
                  now={now}
                  labelWidth={width}
                  className={css.runDashboardLaneBars}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The narrow layout: no side-by-side canvas, but every row keeps its spark
 * strip on the SHARED range, so spans stay comparable and each row still
 * shows its duration at a glance. Also the mobile fallback.
 */
function RunDashboardList(props: {
  display: TimelineDisplay
  now: number
  openActionsId: string | undefined
  onToggleActions: (row: TimelineDisplayRow) => void
  selectedAgentId: string | undefined
  locatedOwnerId: string | undefined
  onSelectAgent: (agentSessionId: string) => void
  armedCloseId: string | undefined
  controlState: AgentControlState
  onOpenAgent: (row: TimelineDisplayRow) => void
  onInterruptAgent: (row: TimelineDisplayRow) => void
  onCloseAgent: (row: TimelineDisplayRow) => void
}) {
  return (
    <div data-run-dashboard-list className={css.runDashboardList} role="treegrid" aria-label={t('subagent')}>
      {props.display.rows.map(row => (
        <RunDashboardTreeRow
          key={row.id}
          row={row}
          range={props.display.range}
          now={props.now}
          actionsOpen={props.openActionsId === row.id}
          onToggleActions={props.onToggleActions}
          selectedAgentId={props.selectedAgentId}
          locatedOwnerId={props.locatedOwnerId}
          armedCloseId={props.armedCloseId}
          controlState={props.controlState}
          onOpenAgent={props.onOpenAgent}
          onSelectAgent={props.onSelectAgent}
          onInterruptAgent={props.onInterruptAgent}
          onCloseAgent={props.onCloseAgent}
        />
      ))}
    </div>
  )
}

/**
 * Free text and status always fit on one line; the narrower filters live in
 * a disclosure so a 360px sidebar never shows five 55px stubs. Collapsed is
 * NOT hidden — every input stays mounted and labelled, and the summary
 * counts what is currently narrowing the tree.
 */
function RunDashboardFilters(props: {
  filters: TimelineDisplayFilters
  onChange: (filters: TimelineDisplayFilters) => void
}) {
  const { filters, onChange } = props
  const set = (patch: TimelineDisplayFilters): void => {
    onChange({ ...filters, ...patch })
  }
  const activeCount = countActiveFilters(filters)
  return (
    <div className={css.runDashboardFilters} role="group" aria-label={t('runDashboardFilterGroup')}>
      <div className={css.runDashboardFilterRow}>
        <input
          className={css.runDashboardFilterSearch}
          aria-label={t('runDashboardFilterText')}
          value={filters.text ?? ''}
          placeholder={t('runDashboardFilterText')}
          onInput={(event) => { set({ text: event.currentTarget.value }) }}
          onChange={(event) => { set({ text: event.currentTarget.value }) }}
        />
        <select
          aria-label={t('runDashboardFilterState')}
          value={filters.state ?? 'all'}
          onChange={(event) => { set({ state: event.currentTarget.value }) }}
        >
          {STATE_FILTER_OPTIONS.map(value => (
            <option key={value} value={value}>{stateFilterLabel(value)}</option>
          ))}
        </select>
      </div>
      <details className={css.runDashboardFilterMore} data-filters-active={activeCount}>
        <summary className={css.runDashboardFilterSummary}>
          <span>{t('runDashboardMoreFilters')}</span>
          {activeCount > 0 && (
            <span className={css.runDashboardFilterBadge}>
              {t('runDashboardFiltersActive', { count: activeCount })}
            </span>
          )}
        </summary>
        <div className={css.runDashboardFilterGrid}>
          <input
            aria-label={t('runDashboardFilterModel')}
            value={filters.model ?? ''}
            placeholder={t('runDashboardFilterModel')}
            onInput={(event) => { set({ model: event.currentTarget.value }) }}
            onChange={(event) => { set({ model: event.currentTarget.value }) }}
          />
          <input
            aria-label={t('runDashboardFilterPath')}
            value={filters.path ?? ''}
            placeholder={t('runDashboardFilterPath')}
            onInput={(event) => { set({ path: event.currentTarget.value }) }}
            onChange={(event) => { set({ path: event.currentTarget.value }) }}
          />
          <label className={css.runDashboardCheck}>
            <input
              aria-label={t('runDashboardFilterLongRunning')}
              type="checkbox"
              checked={filters.longRunningOnly === true}
              onChange={(event) => { set({ longRunningOnly: event.currentTarget.checked }) }}
            />
            <span>{t('runDashboardFilterLongRunning')}</span>
          </label>
        </div>
      </details>
    </div>
  )
}

function AgentDetailPanel(props: {
  state: AgentDetailLoadState
  /** The agent's display title, so the dock says WHOSE detail it shows. */
  agentTitle: string | undefined
  onRetry: (agentSessionId: string) => void
  onClose: () => void
}) {
  const { state, agentTitle, onRetry, onClose } = props
  if (state.kind === 'idle') return null
  const agentSessionId = state.agentSessionId
  const heading = agentTitle === undefined || agentTitle === ''
    ? t('runDashboardDetailTitle')
    : `${t('runDashboardDetailTitle')} · ${agentTitle}`
  return (
    <section className={css.runDashboardDetail} aria-label={heading}>
      <div className={css.runDashboardDetailHeader}>
        <span title={heading}>{heading}</span>
        <button type="button" className={css.runDashboardDetailClose} aria-label={t('runDashboardCloseDetails')} onClick={onClose}>
          <IconStopOutline16 size={10} />
        </button>
      </div>
      {state.kind === 'loading' && <div className={css.runDashboardDetailHint}>{t('loading')}</div>}
      {state.kind === 'error' && (
        <div className={css.runDashboardDetailError}>
          <span>{t('runDashboardDetailError')}: {state.message}</span>
          <button type="button" onClick={() => { onRetry(agentSessionId) }}>{t('retry')}</button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <div className={css.runDashboardDetailSection}>
            <span className={css.runDashboardDetailLabel}>{t('runDashboardDetailTask')}</span>
            {state.detail.initialTask.available
              ? <pre className={css.runDashboardTask}>{state.detail.initialTask.text}</pre>
              : <div className={css.runDashboardDetailHint}>{initialTaskUnavailableLabel(state.detail.initialTask.reason)}</div>}
          </div>
          <div className={css.runDashboardDetailSection}>
            <span className={css.runDashboardDetailLabel}>{t('runDashboardDetailProperties')}</span>
            <dl className={css.runDashboardProps}>
              {detailProperties(state.detail).map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt><dd>{value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The sidebar's Run Dashboard page. The tab's internal id stays `subagent`,
 * but the body now renders a recoverable root+descendant tree-gantt from the
 * host timeline API; legacy last-text/tool history polling is not mounted.
 */
export function SubagentView(props: {
  sessionId: string
  active: boolean
  ctx: Context
  store?: SidebarStore
  onOpenChild?: (address: SidebarSubagentAddress) => void
}) {
  const { sessionId, active, ctx, store, onOpenChild } = props
  const sessions = ctx.sessions
  const [loadState, setLoadState] = useState<TimelineLoadState>({ kind: 'idle' })
  const [detailState, setDetailState] = useState<AgentDetailLoadState>({ kind: 'idle' })
  const [openActionsId, setOpenActionsId] = useState<string | undefined>(undefined)
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>(undefined)
  const [controlState, setControlState] = useState<AgentControlState>({ kind: 'idle' })
  const [armedCloseId, setArmedCloseId] = useState<string | undefined>(undefined)
  const [locatedOwnerId, setLocatedOwnerId] = useState<string | undefined>(undefined)
  const [filters, setFilters] = useState<TimelineDisplayFilters>({ state: 'all' })
  const [now, setNow] = useState(() => Date.now())
  const [zoom, setZoom] = useState(1)
  const [localTreeWidth, setLocalTreeWidth] = useState(() => defaultRunDashboardTreeWidth(PANEL_DEFAULT))
  const appliedSeqRef = useRef<number | undefined>(undefined)
  const requestRef = useRef<AbortController | undefined>(undefined)
  const detailRequestRef = useRef<AbortController | undefined>(undefined)
  const zoomFrameRef = useRef<number | undefined>(undefined)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
    useCallback(() => sessions.list.getSnapshot(), [sessions]),
  )
  const storeSnapshot = useSyncExternalStore(
    useMemo(() => store?.subscribe.bind(store) ?? (() => () => {}), [store]),
    useCallback(() => store?.getSnapshot(), [store]),
  )

  const byId = list.byId
  const catalogs = list.subagentsByParent ?? {}
  const rootId = useMemo(() => rootAncestor(byId, sessionId), [byId, sessionId])
  const rootSummary = rootId === undefined ? undefined : byId[rootId]
  const signature = useMemo(
    () => catalogSignature(rootId, catalogs, byId),
    [rootId, catalogs, byId],
  )
  const panelWidth = storeSnapshot?.state?.width ?? PANEL_DEFAULT
  const layout = useDashboardLayout(bodyRef, panelWidth)
  const maxTreeWidth = Math.max(RUN_DASHBOARD_TREE_MIN, Math.round(panelWidth) - RUN_DASHBOARD_TREE_MIN)
  const rawTreeWidth = storeSnapshot?.state?.runDashboardTreeWidth ?? localTreeWidth
  const treeWidth = clampRunDashboardTreeWidth(rawTreeWidth, panelWidth)
  const longRunningMinutes = normalizeLongRunningMinutes(storeSnapshot?.prefs.pluginSettings.subagent?.longRunningMinutes)

  useEffect(() => {
    appliedSeqRef.current = undefined
    detailRequestRef.current?.abort()
    setDetailState({ kind: 'idle' })
    setOpenActionsId(undefined)
    setSelectedJobId(undefined)
    setControlState({ kind: 'idle' })
    setArmedCloseId(undefined)
    setLocatedOwnerId(undefined)
    setLoadState(rootId === undefined ? { kind: 'idle' } : { kind: 'loading' })
  }, [rootId])

  useEffect(() => {
    if (armedCloseId === undefined) return
    const timer = window.setTimeout(() => { setArmedCloseId(undefined) }, AGENT_CLOSE_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedCloseId])

  const loadAgentDetail = useCallback((agentSessionId: string): void => {
    if (!active || rootId === undefined) return
    detailRequestRef.current?.abort()
    const controller = new AbortController()
    detailRequestRef.current = controller
    // The detail panel and the job output pane share the bottom dock.
    setSelectedJobId(undefined)
    setDetailState({ kind: 'loading', agentSessionId })
    void api.agentDetail(
      { sessionId: rootId, cwd: rootSummary?.cwd },
      agentSessionId,
      controller.signal,
    ).then((detail) => {
      if (!controller.signal.aborted) setDetailState({ kind: 'ready', agentSessionId, detail })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setDetailState({ kind: 'error', agentSessionId, message })
    })
  }, [active, rootId, rootSummary?.cwd])

  const closeAgentDetail = useCallback((): void => {
    detailRequestRef.current?.abort()
    setDetailState({ kind: 'idle' })
  }, [])

  useEffect(() => () => { detailRequestRef.current?.abort() }, [])
  const cancelZoomFrame = useCallback((): void => {
    if (zoomFrameRef.current !== undefined) window.cancelAnimationFrame(zoomFrameRef.current)
    zoomFrameRef.current = undefined
  }, [])
  useEffect(() => () => { cancelZoomFrame() }, [cancelZoomFrame])

  const toggleAgentDetail = useCallback((agentSessionId: string): void => {
    if (detailState.kind !== 'idle' && detailState.agentSessionId === agentSessionId) {
      closeAgentDetail()
      return
    }
    loadAgentDetail(agentSessionId)
  }, [closeAgentDetail, detailState, loadAgentDetail])

  const openAgent = useCallback((row: TimelineDisplayRow): void => {
    const address = agentAddress(row)
    if (address === undefined) return
    // Notify the shell FIRST (it arms the jump-back so the Run Dashboard
    // re-opens on top of the child's own layout), then perform the actual
    // conversation switch. The hook only records intent — it never opens the
    // child itself, so `openSubagent` must run in BOTH cases or the button
    // does nothing.
    onOpenChild?.(address)
    try {
      ctx.sessions.openSubagent?.(address)
    } catch (error) {
      console.warn('[dsh-better-sidebar] openSubagent failed:', error)
    }
  }, [ctx.sessions, onOpenChild])

  const runAgentControl = useCallback(async (
    action: AgentControlAction,
    row: TimelineDisplayRow,
  ): Promise<void> => {
    const address = rootScopedControlAddress(rootId, row)
    if (address === undefined) {
      setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'not-found' })
      return
    }
    setArmedCloseId(undefined)
    setControlState({ kind: 'loading', agentSessionId: row.id, action })
    try {
      let outcome: SidebarSubagentControlOutcome
      if (action === 'interrupt') {
        if (ctx.sessions.interruptSubagent === undefined) {
          setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'failed' })
          return
        }
        outcome = await ctx.sessions.interruptSubagent(address)
      } else {
        if (ctx.sessions.closeSubagent === undefined) {
          setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'failed' })
          return
        }
        outcome = await ctx.sessions.closeSubagent(address, operationId())
      }
      setControlState({
        kind: outcome === 'accepted' || outcome === 'closed' ? 'done' : 'error',
        agentSessionId: row.id,
        action,
        outcome,
      })
    } catch {
      setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'failed' })
    }
  }, [ctx.sessions, rootId])

  const interruptAgent = useCallback((row: TimelineDisplayRow): void => {
    void runAgentControl('interrupt', row)
  }, [runAgentControl])

  const closeAgent = useCallback((row: TimelineDisplayRow): void => {
    if (armedCloseId !== row.id) {
      setArmedCloseId(row.id)
      return
    }
    void runAgentControl('close', row)
  }, [armedCloseId, runAgentControl])

  const setTreeWidth = useCallback((width: number): void => {
    if (storeSnapshot?.state !== undefined && store !== undefined) {
      store.update((draft) => {
        draft.runDashboardTreeWidth = clampRunDashboardTreeWidth(width, draft.width)
      })
    } else {
      setLocalTreeWidth(clampRunDashboardTreeWidth(width, panelWidth))
    }
  }, [store, storeSnapshot?.state, panelWidth])

  const fetchTimeline = useCallback((): void => {
    if (!active || rootId === undefined) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoadState(current => current.kind === 'ready' ? current : { kind: 'loading' })
    void api.agentTimeline(
      { sessionId: rootId, cwd: rootSummary?.cwd },
      controller.signal,
    ).then((timeline) => {
      if (controller.signal.aborted) return
      if (appliedSeqRef.current !== undefined && timeline.asOfSeq < appliedSeqRef.current) return
      appliedSeqRef.current = timeline.asOfSeq
      setLoadState({ kind: 'ready', timeline })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setLoadState(current => current.kind === 'ready' ? current : { kind: 'error', message })
    })
  }, [active, rootId, rootSummary?.cwd])

  useEffect(() => {
    fetchTimeline()
    return () => { requestRef.current?.abort() }
  }, [fetchTimeline, signature])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [active])

  const display = useMemo(
    () => loadState.kind === 'ready'
      ? buildTimelineDisplay({
        timeline: loadState.timeline,
        catalogs,
        rootTitle: rootSummary?.displayTitle,
        rootRunning: rootSummary?.running,
        now,
        longRunningMinutes,
      })
      : undefined,
    [loadState, catalogs, rootSummary?.displayTitle, rootSummary?.running, now, longRunningMinutes],
  )
  const filteredDisplay = useMemo(
    () => display === undefined ? undefined : filterTimelineDisplay(display, filters),
    [display, filters],
  )

  const zoomBy = useCallback((factor: number): void => {
    const scroller = scrollerRef.current
    const oldWidth = timelineWidth(zoom)
    const anchor = scroller === null ? 0 : scroller.clientWidth / 2
    const ratio = scroller === null ? 0 : (scroller.scrollLeft + anchor) / oldWidth
    const nextZoom = clampZoom(zoom * factor)
    setZoom(nextZoom)
    if (scroller !== null) {
      cancelZoomFrame()
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = undefined
        scroller.scrollLeft = Math.max(0, ratio * timelineWidth(nextZoom) - anchor)
      })
    }
  }, [cancelZoomFrame, zoom])
  const zoomIn = useCallback((): void => { zoomBy(TIMELINE_ZOOM_FACTOR) }, [zoomBy])
  const zoomOut = useCallback((): void => { zoomBy(1 / TIMELINE_ZOOM_FACTOR) }, [zoomBy])
  const fitAll = useCallback((): void => {
    cancelZoomFrame()
    const scroller = scrollerRef.current
    const rows = filteredDisplay?.rows
    setZoom(fitZoom(
      scroller?.clientWidth ?? 0,
      filteredDisplay?.range ?? null,
      rows === undefined ? undefined : timelineContentEnd(rows, now),
    ) ?? 1)
    scroller?.scrollTo({ left: 0 })
  }, [cancelZoomFrame, filteredDisplay, now])
  const panRight = useCallback((): void => {
    cancelZoomFrame()
    const scroller = scrollerRef.current
    if (scroller !== null) scroller.scrollLeft += TIMELINE_PAN_STEP
  }, [cancelZoomFrame])
  const scrollNow = useCallback((): void => {
    cancelZoomFrame()
    const scroller = scrollerRef.current
    if (scroller !== null) scroller.scrollLeft = timelineWidth(zoom)
  }, [cancelZoomFrame, zoom])

  const locateJobOwner = useCallback((ownerSessionId: string): void => {
    setLocatedOwnerId(ownerSessionId)
    setFilters({ state: 'all' })
  }, [])

  const selectJob = useCallback((jobId: string | undefined): void => {
    if (jobId !== undefined) closeAgentDetail()
    setSelectedJobId(jobId)
  }, [closeAgentDetail])

  const toggleRowActions = useCallback((row: TimelineDisplayRow): void => {
    setOpenActionsId(current => (current === row.id ? undefined : row.id))
  }, [])

  useEffect(() => {
    if (locatedOwnerId === undefined) return
    const target = [...(bodyRef.current?.querySelectorAll<HTMLElement>('[data-run-dashboard-row-id]') ?? [])]
      .find(row => row.dataset.runDashboardRowId === locatedOwnerId)
    target?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [locatedOwnerId, filters])

  const countLabel = display === undefined
    ? undefined
    : t('subagentCount', { count: Math.max(0, display.rows.length - 1) })

  return (
    <div className={css.subagent}>
      <div className={css.subagentHeader}>
        <span className={css.subagentTitle}>
          {t('subagent')}
          {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== ''
            ? ` · ${rootSummary.displayTitle}`
            : ''}
        </span>
        {countLabel !== undefined && <span className={css.subagentCount}>{countLabel}</span>}
        <button
          type="button"
          className={css.subagentRefresh}
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={rootId === undefined}
          onClick={fetchTimeline}
        >
          <IconRefreshOutline14 />
        </button>
      </div>
      <div className={css.subagentBody} ref={bodyRef}>
        {layout === 'grid' && (
          <div className={css.runDashboardToolbar} role="group" aria-label={t('runDashboardViewport')}>
            <button type="button" aria-label={t('runDashboardZoomIn')} onClick={zoomIn}>{t('runDashboardZoomIn')}</button>
            <button type="button" aria-label={t('runDashboardZoomOut')} onClick={zoomOut}>{t('runDashboardZoomOut')}</button>
            <button type="button" aria-label={t('runDashboardFitAll')} onClick={fitAll}>{t('runDashboardFitAll')}</button>
            <button type="button" aria-label={t('runDashboardNow')} onClick={scrollNow}>{t('runDashboardNow')}</button>
            <button type="button" aria-label={t('runDashboardPanRight')} onClick={panRight}>{t('runDashboardPanRight')}</button>
          </div>
        )}
        <RunDashboardFilters filters={filters} onChange={setFilters} />
        {rootId === undefined && (
          <div className={css.subagentEmpty}>
            <div>{t('subagentEmpty')}</div>
            <div className={css.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
          </div>
        )}
        {loadState.kind === 'loading' && <div className={css.subagentEmpty}>{t('loading')}</div>}
        {loadState.kind === 'error' && (
          <div className={css.subagentError}>
            <span>{loadState.message}</span>
            <button type="button" className={css.subagentErrorRetry} onClick={fetchTimeline}>
              <IconRefreshOutline14 />
              {t('retry')}
            </button>
          </div>
        )}
        {filteredDisplay !== undefined && (layout === 'list'
          ? (
            <RunDashboardList
              display={filteredDisplay}
              now={now}
              openActionsId={openActionsId}
              onToggleActions={toggleRowActions}
              selectedAgentId={detailState.kind === 'idle' ? undefined : detailState.agentSessionId}
              locatedOwnerId={locatedOwnerId}
              onSelectAgent={toggleAgentDetail}
              armedCloseId={armedCloseId}
              controlState={controlState}
              onOpenAgent={openAgent}
              onInterruptAgent={interruptAgent}
              onCloseAgent={closeAgent}
            />
          )
          : (
            <RunDashboardRows
              display={filteredDisplay}
              now={now}
              zoom={zoom}
              scrollerRef={scrollerRef}
              treeWidth={treeWidth}
              maxTreeWidth={maxTreeWidth}
              setTreeWidth={setTreeWidth}
              openActionsId={openActionsId}
              onToggleActions={toggleRowActions}
              selectedAgentId={detailState.kind === 'idle' ? undefined : detailState.agentSessionId}
              locatedOwnerId={locatedOwnerId}
              onSelectAgent={toggleAgentDetail}
              armedCloseId={armedCloseId}
              controlState={controlState}
              onOpenAgent={openAgent}
              onInterruptAgent={interruptAgent}
              onCloseAgent={closeAgent}
            />
          ))}
        {filteredDisplay !== undefined && filteredDisplay.rows.length === 1 && (
          <div className={css.subagentEmpty}>
            <div>{t('subagentEmpty')}</div>
            <div className={css.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
          </div>
        )}
        <JobsSection
          byId={byId}
          jobsBySession={list.jobsBySession}
          rootId={rootId}
          ownerRows={display?.rows}
          locatedOwnerId={locatedOwnerId}
          onLocateOwner={locateJobOwner}
          selectedJobId={selectedJobId}
          onSelectJob={selectJob}
          active={active}
        />
        <AgentDetailPanel
          state={detailState}
          agentTitle={detailState.kind === 'idle'
            ? undefined
            : display?.rows.find(row => row.id === detailState.agentSessionId)?.title}
          onRetry={loadAgentDetail}
          onClose={closeAgentDetail}
        />
      </div>
    </div>
  )
}
