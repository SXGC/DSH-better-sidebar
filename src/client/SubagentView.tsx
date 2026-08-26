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
  formatJobDuration,
  isJobLive,
  orderJobs,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { IconStopOutline16 } from './icons.tsx'
import {
  buildTimelineDisplay,
  filterTimelineDisplay,
  formatAgentState,
  normalizeLongRunningMinutes,
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
    void load()
    if (!active || !isJobLive(job)) return
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
  /** The page is visible (active tab + open panel): skip polling otherwise. */
  active: boolean
}) {
  const { byId, jobsBySession, rootId, active } = props
  const rows = useMemo(
    () => orderJobs(collectTreeJobs(byId, jobsBySession, rootId)),
    [byId, jobsBySession, rootId],
  )
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
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
  const multiOwner = useMemo(
    () => new Set(rows.map(row => row.ownerSessionId)).size > 1,
    [rows],
  )

  // The kill button stays armed only briefly; a stray click must never kill.
  useEffect(() => {
    if (armedId === undefined) return
    const timer = window.setTimeout(() => { setArmedId(undefined) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedId])

  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [liveCount])

  // The docked output pane follows its job: when the selected job leaves
  // the mirror (settled and dropped, or the tree switched), close the dock.
  useEffect(() => {
    if (selectedId !== undefined && selectedRow === undefined) setSelectedId(undefined)
  }, [selectedId, selectedRow])

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
            const elapsed = live
              ? now - job.startedAt
              : (job.finishedAt ?? job.startedAt) - job.startedAt
            const secondary = [
              ...(multiOwner ? [row.ownerTitle] : []),
              jobStatusLabel(job.status, t),
              ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              formatJobDuration(elapsed, t),
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
                  onClick={() => { setSelectedId(selected ? undefined : job.id) }}
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
          onClose={() => { setSelectedId(undefined) }}
        />
      )}
    </>
  )
}

const RUN_DASHBOARD_MOBILE_WIDTH = 640
const TIMELINE_BASE_WIDTH = 600
const TIMELINE_PAN_STEP = 64
const TIMELINE_ZOOM_FACTOR = 1.25
const TREE_KEYBOARD_STEP = 16

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

function isMobileDashboard(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < RUN_DASHBOARD_MOBILE_WIDTH
}

function agentRowState(row: TimelineDisplay['rows'][number]): string {
  if (row.state === undefined) return row.kind === 'diagnostic' ? t('subagentDiagUnavailable') : t('subagentInactive')
  return formatAgentState(row.state, isZh() ? 'zh' : 'en')
}

function stateFilterLabel(value: string): string {
  if (value === 'all') return t('runDashboardFilterAll')
  if (value === 'cold') return formatAgentState({ residency: 'cold', lastTurn: 'idle' }, isZh() ? 'zh' : 'en')
  if (value === 'closed') return formatAgentState({ residency: 'closed' }, isZh() ? 'zh' : 'en')
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
  return formatAgentState(state, isZh() ? 'zh' : 'en')
}

function formatTime(value: number | undefined): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString()
}

function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function timelineWidth(zoom: number): number {
  return Math.round(TIMELINE_BASE_WIDTH * zoom)
}

function segmentKind(segment: TimelineSegment): string {
  if (segment.state.residency !== 'live') return segment.state.residency
  return segment.state.turn.kind
}

function segmentStyle(
  segment: TimelineSegment,
  range: NonNullable<TimelineDisplay['range']>,
  now: number,
): CSSProperties {
  const span = Math.max(1, range.end - range.start)
  const left = ((segment.start - range.start) / span) * 100
  const end = segment.end ?? now
  const width = Math.max(1.5, ((end - segment.start) / span) * 100)
  return { left: `${left}%`, width: `${width}%` }
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

function RunDashboardTreeRow(props: {
  row: TimelineDisplayRow
  selectedAgentId: string | undefined
  armedCloseId: string | undefined
  controlState: AgentControlState
  onOpenAgent: (row: TimelineDisplayRow) => void
  onSelectAgent: (agentSessionId: string) => void
  onInterruptAgent: (row: TimelineDisplayRow) => void
  onCloseAgent: (row: TimelineDisplayRow) => void
}) {
  const {
    row,
    selectedAgentId,
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

  return (
    <div
      role="row"
      aria-level={row.depth + 1}
      className={clsx(
        css.runDashboardRow,
        row.kind === 'root' && css.runDashboardRootRow,
        row.contextOnly && css.runDashboardContextRow,
      )}
      style={{ paddingLeft: 10 + row.depth * 16 }}
    >
      <span className={css.runDashboardRowHeader}>
        <span className={css.runDashboardRowTitle}>{row.title}</span>
        {row.longRunning && <span className={css.runDashboardWarn}>{t('runDashboardLongRunning')}</span>}
        {row.kind === 'agent' && (
          <>
            <button
              type="button"
              className={css.runDashboardDetailButton}
              aria-label={`${t('runDashboardOpenChat')} ${row.title}`}
              onClick={() => { onOpenAgent(row) }}
            >
              {t('runDashboardOpenChat')}
            </button>
            <button
              type="button"
              className={clsx(css.runDashboardDetailButton, selectedAgentId === row.id && css.runDashboardDetailButtonActive)}
              aria-label={`${t('runDashboardDetails')} ${row.title}`}
              onClick={() => { onSelectAgent(row.id) }}
            >
              {t('runDashboardDetails')}
            </button>
            <button
              type="button"
              className={css.runDashboardDetailButton}
              aria-label={`${t('runDashboardInterrupt')} ${row.title}`}
              disabled={!canInterruptAgent(row) || rowControl?.kind === 'loading'}
              onClick={() => { onInterruptAgent(row) }}
            >
              {t('runDashboardInterrupt')}
            </button>
            <button
              type="button"
              className={clsx(css.runDashboardDetailButton, closeArmed && css.runDashboardDangerButton)}
              aria-label={`${closeArmed ? t('runDashboardConfirmClose') : t('runDashboardCloseAgent')} ${row.title}`}
              disabled={!canCloseAgent(row) || rowControl?.kind === 'loading'}
              onClick={() => { onCloseAgent(row) }}
            >
              {closeArmed ? t('runDashboardConfirmClose') : t('runDashboardCloseAgent')}
            </button>
          </>
        )}
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
      <span className={css.runDashboardStatus}>{agentRowState(row)}</span>
      {row.path !== undefined && <span className={css.runDashboardMeta}>{row.path}</span>}
      {row.model !== undefined && <span className={css.runDashboardMeta}>{modelLabel(row.model)}</span>}
      {row.kind === 'diagnostic'
        ? <span className={css.runDashboardMeta}>{t('runDashboardTimeUnavailable')}</span>
        : (
          <span className={css.runDashboardMeta}>
            start {formatTime(row.startedAt)} · end {formatTime(row.endedAt)}
          </span>
        )}
      <span className={css.runDashboardMeta}>
        active {formatDurationMs(row.activeDurationMs)} · wall {formatDurationMs(row.wallDurationMs)} · {row.segments.length} segments
      </span>
    </div>
  )
}

function RunDashboardRows(props: {
  display: TimelineDisplay
  now: number
  zoom: number
  scrollerRef: React.RefObject<HTMLDivElement>
  treeWidth: number
  maxTreeWidth: number
  setTreeWidth: (width: number) => void
  selectedAgentId: string | undefined
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
    selectedAgentId,
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
      <div className={css.runDashboardTree} style={{ width: treeWidth }}>
        {display.rows.map(row => (
          <RunDashboardTreeRow
            key={row.id}
            row={row}
            selectedAgentId={selectedAgentId}
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
          style={{ width }}
        >
          <div className={css.runDashboardScale}>
            <span>{range === null ? '—' : formatTime(range.start)}</span>
            <span>{range === null ? '—' : formatTime(range.end)}</span>
          </div>
          {display.rows.map(row => (
            <div key={row.id} className={css.runDashboardLane}>
              {range !== null && row.segments.map((segment, index) => (
                <span
                  key={`${row.id}:${index}:${segment.start}`}
                  className={clsx(css.runDashboardSegment, css[`segment_${segmentKind(segment)}`])}
                  data-segment-state={segmentKind(segment)}
                  style={segmentStyle(segment, range, now)}
                  title={formatAgentState(segment.state, isZh() ? 'zh' : 'en')}
                >
                  {formatAgentState(segment.state, isZh() ? 'zh' : 'en')}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RunDashboardMobile(props: { display: TimelineDisplay }) {
  return (
    <div data-mobile-run-dashboard className={css.runDashboardMobile}>
      {props.display.rows.map(row => (
        <div key={row.id} className={css.runDashboardMobileRow}>
          <span className={css.runDashboardRowTitle}>{row.title}</span>
          <span className={css.runDashboardStatus}>{agentRowState(row)}</span>
          {row.longRunning && <span className={css.runDashboardWarn}>{t('runDashboardLongRunning')}</span>}
          <span className={css.runDashboardMeta}>
            {row.kind === 'diagnostic' ? `${t('runDashboardTimeUnavailable')} · ` : `start ${formatTime(row.startedAt)} · `}
            active {formatDurationMs(row.activeDurationMs)} · {row.segments.length} segments
          </span>
        </div>
      ))}
    </div>
  )
}

function RunDashboardFilters(props: {
  filters: TimelineDisplayFilters
  onChange: (filters: TimelineDisplayFilters) => void
}) {
  const { filters, onChange } = props
  const set = (patch: TimelineDisplayFilters): void => {
    onChange({ ...filters, ...patch })
  }
  return (
    <div className={css.runDashboardFilters}>
      <select
        aria-label={t('runDashboardFilterState')}
        value={filters.state ?? 'all'}
        onChange={(event) => { set({ state: event.currentTarget.value }) }}
      >
        {STATE_FILTER_OPTIONS.map(value => (
          <option key={value} value={value}>{stateFilterLabel(value)}</option>
        ))}
      </select>
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
      <input
        aria-label={t('runDashboardFilterText')}
        value={filters.text ?? ''}
        placeholder={t('runDashboardFilterText')}
        onInput={(event) => { set({ text: event.currentTarget.value }) }}
        onChange={(event) => { set({ text: event.currentTarget.value }) }}
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
  )
}

function AgentDetailPanel(props: {
  state: AgentDetailLoadState
  onRetry: (agentSessionId: string) => void
  onClose: () => void
}) {
  const { state, onRetry, onClose } = props
  if (state.kind === 'idle') return null
  const agentSessionId = state.agentSessionId
  return (
    <section className={css.runDashboardDetail} aria-label={t('runDashboardDetailTitle')}>
      <div className={css.runDashboardDetailHeader}>
        <span>{t('runDashboardDetailTitle')}</span>
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
  const [controlState, setControlState] = useState<AgentControlState>({ kind: 'idle' })
  const [armedCloseId, setArmedCloseId] = useState<string | undefined>(undefined)
  const [filters, setFilters] = useState<TimelineDisplayFilters>({ state: 'all' })
  const [now, setNow] = useState(() => Date.now())
  const [zoom, setZoom] = useState(1)
  const [mobile] = useState(isMobileDashboard)
  const [localTreeWidth, setLocalTreeWidth] = useState(() => defaultRunDashboardTreeWidth(PANEL_DEFAULT))
  const appliedSeqRef = useRef<number | undefined>(undefined)
  const requestRef = useRef<AbortController | undefined>(undefined)
  const detailRequestRef = useRef<AbortController | undefined>(undefined)
  const scrollerRef = useRef<HTMLDivElement>(null)

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
  const maxTreeWidth = Math.max(RUN_DASHBOARD_TREE_MIN, Math.round(panelWidth) - RUN_DASHBOARD_TREE_MIN)
  const rawTreeWidth = storeSnapshot?.state?.runDashboardTreeWidth ?? localTreeWidth
  const treeWidth = clampRunDashboardTreeWidth(rawTreeWidth, panelWidth)
  const longRunningMinutes = normalizeLongRunningMinutes(storeSnapshot?.prefs.pluginSettings.subagent?.longRunningMinutes)

  useEffect(() => {
    appliedSeqRef.current = undefined
    detailRequestRef.current?.abort()
    setDetailState({ kind: 'idle' })
    setControlState({ kind: 'idle' })
    setArmedCloseId(undefined)
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
    onOpenChild?.(address)
    if (onOpenChild === undefined) ctx.sessions.openSubagent?.(address)
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
        const interrupt = ctx.sessions.interruptSubagent
        if (interrupt === undefined) {
          setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'failed' })
          return
        }
        outcome = await interrupt(address)
      } else {
        const close = ctx.sessions.closeSubagent
        if (close === undefined) {
          setControlState({ kind: 'error', agentSessionId: row.id, action, outcome: 'failed' })
          return
        }
        outcome = await close(address, operationId())
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
    const nextZoom = Math.min(8, Math.max(0.25, zoom * factor))
    setZoom(nextZoom)
    if (scroller !== null) {
      window.requestAnimationFrame(() => {
        scroller.scrollLeft = Math.max(0, ratio * timelineWidth(nextZoom) - anchor)
      })
    }
  }, [zoom])
  const zoomIn = useCallback((): void => { zoomBy(TIMELINE_ZOOM_FACTOR) }, [zoomBy])
  const zoomOut = useCallback((): void => { zoomBy(1 / TIMELINE_ZOOM_FACTOR) }, [zoomBy])
  const fitAll = useCallback((): void => {
    setZoom(1)
    scrollerRef.current?.scrollTo({ left: 0 })
  }, [])
  const panRight = useCallback((): void => {
    const scroller = scrollerRef.current
    if (scroller !== null) scroller.scrollLeft += TIMELINE_PAN_STEP
  }, [])
  const scrollNow = useCallback((): void => {
    const scroller = scrollerRef.current
    if (scroller !== null) scroller.scrollLeft = timelineWidth(zoom)
  }, [zoom])

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
      <div className={css.subagentBody}>
        <div className={css.runDashboardToolbar}>
          <button type="button" aria-label={t('runDashboardZoomIn')} onClick={zoomIn}>{t('runDashboardZoomIn')}</button>
          <button type="button" aria-label={t('runDashboardZoomOut')} onClick={zoomOut}>{t('runDashboardZoomOut')}</button>
          <button type="button" aria-label={t('runDashboardFitAll')} onClick={fitAll}>{t('runDashboardFitAll')}</button>
          <button type="button" aria-label={t('runDashboardNow')} onClick={scrollNow}>{t('runDashboardNow')}</button>
          <button type="button" aria-label={t('runDashboardPanRight')} onClick={panRight}>{t('runDashboardPanRight')}</button>
        </div>
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
        {filteredDisplay !== undefined && filteredDisplay.rows.length === 1 && (
          <div className={css.subagentEmpty}>
            <div>{t('subagentEmpty')}</div>
            <div className={css.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
          </div>
        )}
        {filteredDisplay !== undefined && (mobile
          ? <RunDashboardMobile display={filteredDisplay} />
          : (
            <RunDashboardRows
              display={filteredDisplay}
              now={now}
              zoom={zoom}
              scrollerRef={scrollerRef}
              treeWidth={treeWidth}
              maxTreeWidth={maxTreeWidth}
              setTreeWidth={setTreeWidth}
              selectedAgentId={detailState.kind === 'idle' ? undefined : detailState.agentSessionId}
              onSelectAgent={toggleAgentDetail}
              armedCloseId={armedCloseId}
              controlState={controlState}
              onOpenAgent={openAgent}
              onInterruptAgent={interruptAgent}
              onCloseAgent={closeAgent}
            />
          ))}
        <AgentDetailPanel
          state={detailState}
          onRetry={loadAgentDetail}
          onClose={closeAgentDetail}
        />
        <JobsSection
          byId={byId}
          jobsBySession={list.jobsBySession}
          rootId={rootId}
          active={active}
        />
      </div>
    </div>
  )
}
