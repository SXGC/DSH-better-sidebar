/**
 * Recursive file search for the editor's merged-mode side panel. Native file
 * listing is preferred when available, with the original opendir walk as the
 * fallback. A query without separators is a case-insensitive substring of each
 * entry's NAME; a query containing '/' or '\\' is a case-insensitive suffix of
 * the root-relative path. No engine applies .gitignore semantics; known
 * noise directories are skipped outright and symlink directories are not
 * followed.
 *
 * Two performance budgets bound the walk: `maxMatches` (the client renders
 * the flat list) and `maxVisited` (a runaway tree — a home directory root
 * — must not stall the host). Exceeding either stops early with
 * `truncated: true`.
 */
import { spawn } from 'node:child_process'
import { opendir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** One search: the relative paths of the matching entries (dirs included so
 *  the client can hint where matches live) plus the truncation flag. */
export interface FsSearchResult {
  matches: string[]
  truncated: boolean
}

/** Injectable argv-vector command runner used by the native search adapters. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Search implementation that produced the current result. */
export type FsSearchEngine = 'fd' | 'fdfind' | 'packaged-rg' | 'path-rg' | 'js'

/** Search budgets and native-engine seams. */
export interface FsSearchOptions {
  /** Row cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
  /** Test seam for selecting or bypassing native-engine discovery. */
  engine?: 'auto' | 'fd' | 'rg' | 'js'
  /** Test seam replacing the argv-vector child-process runner. */
  runCommand?: RunCommand
  /** Test seam replacing lazy resolution of the packaged ripgrep binary. */
  resolvePackagedRg?: () => Promise<string | null>
  /** Diagnostic sink called when the effective engine changes. */
  onEngineSelected?: (engine: FsSearchEngine) => void
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000
const NATIVE_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 1_000

type DetectedEngine =
  | { kind: 'fd'; command: 'fd' | 'fdfind' }
  | { kind: 'rg'; command: string }
  | { kind: 'js' }

type ResolvePackagedRg = () => Promise<string | null>

interface DetectionState {
  promise?: Promise<DetectedEngine>
  selected?: DetectedEngine
  unavailable: Set<string>
  reportedEngine?: FsSearchEngine
}

interface NativeSearchAttempt {
  result?: FsSearchResult
  missing: boolean
}

interface SearchQuery {
  needle: string
  native: string
  pathSuffix: boolean
}

const detectionStates = new WeakMap<RunCommand, WeakMap<ResolvePackagedRg, DetectionState>>()
const packagedRgResolutionPromises = new WeakMap<ResolvePackagedRg, Promise<string | null>>()

let packagedRgPathPromise: Promise<string | null> | undefined

/** Resolve the packaged ripgrep path once without making module loading eager. */
async function resolvePackagedRg(): Promise<string | null> {
  packagedRgPathPromise ??= import('@vscode/ripgrep')
    .then(module => module.rgPath || null)
    .catch(() => null)
  return await packagedRgPathPromise
}

/** Memoize injected and production packaged-rg resolution, including failure. */
function resolvePackagedRgCached(resolveRg: ResolvePackagedRg): Promise<string | null> {
  let promise = packagedRgResolutionPromises.get(resolveRg)
  if (promise === undefined) {
    promise = Promise.resolve()
      .then(resolveRg)
      .then(path => path || null)
      .catch(() => null)
    packagedRgResolutionPromises.set(resolveRg, promise)
  }
  return promise
}

/** Select the first available native engine in semantic-preference order. */
async function detectEngine(
  run: RunCommand,
  resolveRg: ResolvePackagedRg,
  unavailable: Set<string>,
): Promise<DetectedEngine> {
  for (const command of ['fd', 'fdfind'] as const) {
    if (unavailable.has(command)) continue
    const available = await run(command, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
      .then(result => result.code === 0)
      .catch(() => false)
    if (available) return { kind: 'fd', command }
    unavailable.add(command)
  }
  const rgPath = await resolvePackagedRgCached(resolveRg)
  if (rgPath !== null && !unavailable.has(rgPath)) return { kind: 'rg', command: rgPath }
  if (unavailable.has('rg')) return { kind: 'js' }
  const pathRg = await run('rg', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
    .then(result => result.code === 0)
    .catch(() => false)
  if (!pathRg) unavailable.add('rg')
  return pathRg ? { kind: 'rg', command: 'rg' } : { kind: 'js' }
}

/** Return the process-local discovery state for one production or test seam. */
function getDetectionState(run: RunCommand, resolveRg: ResolvePackagedRg): DetectionState {
  let byResolver = detectionStates.get(run)
  if (byResolver === undefined) {
    byResolver = new WeakMap()
    detectionStates.set(run, byResolver)
  }
  let state = byResolver.get(resolveRg)
  if (state === undefined) {
    state = { unavailable: new Set() }
    byResolver.set(resolveRg, state)
  }
  return state
}

/** Report only effective engine transitions, not every debounced query. */
function reportEngine(
  state: DetectionState,
  engine: FsSearchEngine,
  onEngineSelected: FsSearchOptions['onEngineSelected'],
): void {
  if (onEngineSelected === undefined || state.reportedEngine === engine) return
  state.reportedEngine = engine
  onEngineSelected(engine)
}

/** Cache both successful and exhausted discovery; concurrent callers share the promise. */
function detectEngineCached(run: RunCommand, resolveRg: ResolvePackagedRg): Promise<DetectedEngine> {
  const state = getDetectionState(run, resolveRg)
  if (state.promise === undefined) {
    const promise = detectEngine(run, resolveRg, state.unavailable)
    state.promise = promise
    void promise.then((selected) => {
      if (state.promise === promise) state.selected = selected
    })
  }
  return state.promise
}

/** Forget a command that disappeared after discovery and select again next time. */
function invalidateCommand(run: RunCommand, resolveRg: ResolvePackagedRg, command: string): void {
  const state = getDetectionState(run, resolveRg)
  state.unavailable.add(command)
  const selected = state.selected
  if (selected !== undefined && selected.kind !== 'js' && selected.command === command) {
    state.promise = undefined
    state.selected = undefined
  }
}

/** Identify only spawn's command-not-found rejection, not ordinary failures. */
function isCommandMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Run a command without a shell and collect its UTF-8 output. */
function runCommand(command: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number }): ReturnType<RunCommand> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Dependency, VCS, package-store, cache, and build-output forests. Names are
 * compared case-insensitively by the JS walker; native engines receive the
 * same names through their exclusion arguments.
 */
const SEARCH_SKIP_DIR_NAMES = [
  '.git',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.turbo',
  '.turbopack',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.parcel-cache',
  'coverage',
  'dist',
  'build',
  'out',
  '.umi',
  '.umi-production',
  '.dumi',
] as const

const SEARCH_SKIP_DIRS = new Set<string>(SEARCH_SKIP_DIR_NAMES)
const FD_EXCLUDE_ARGS = SEARCH_SKIP_DIR_NAMES.flatMap(name => ['--exclude', name])
const RG_EXCLUDE_ARGS = SEARCH_SKIP_DIR_NAMES.flatMap(name => [
  '--iglob',
  `!${name}`,
  '--iglob',
  `!${name}/**`,
])

const RG_ARGS = [
  '--no-config',
  '--files',
  '--hidden',
  '--no-ignore',
  '--no-follow',
  ...RG_EXCLUDE_ARGS,
  '--null',
] as const

/** Normalize one user query for native and in-process matching. */
function parseQuery(query: string): SearchQuery {
  const native = query.trim().replaceAll('\\', '/')
  return {
    native,
    needle: native.toLowerCase(),
    pathSuffix: native.includes('/'),
  }
}

/** Apply file-name or relative-path suffix semantics to one normalized path. */
function matchesQuery(path: string, query: SearchQuery): boolean {
  const normalized = path.replaceAll('\\', '/')
  if (query.pathSuffix) return normalized.toLowerCase().endsWith(query.needle)
  return normalized.split('/').at(-1)!.toLowerCase().includes(query.needle)
}

/** List matching entries with fd using the same name semantics as the JS walk. */
async function searchWithFd(
  command: 'fd' | 'fdfind',
  root: string,
  query: SearchQuery,
  maxMatches: number,
  run: RunCommand,
): Promise<NativeSearchAttempt> {
  const args = [
    '-H',
    '--no-ignore',
    ...query.pathSuffix ? ['--full-path'] : ['-F'],
    '-i',
    '--print0',
    ...FD_EXCLUDE_ARGS,
    '--max-results',
    String(maxMatches),
    '--',
    query.pathSuffix ? `${query.native.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : query.native,
    '.',
  ]
  let result: Awaited<ReturnType<RunCommand>>
  try {
    result = await run(command, args, { cwd: root, timeoutMs: NATIVE_TIMEOUT_MS })
  } catch (error) {
    return { missing: isCommandMissing(error) }
  }
  if (result.code !== 0) return { missing: false }
  const matches = result.stdout
    .split('\0')
    .filter(Boolean)
    .slice(0, maxMatches)
    .map(path => path.replaceAll('\\', '/').replace(/^\.\//, ''))
    .sort()
  return { result: { matches, truncated: matches.length >= maxMatches }, missing: false }
}

/** List files with ripgrep and rebuild matching path prefixes. */
async function searchWithRg(
  command: string,
  root: string,
  query: SearchQuery,
  maxMatches: number,
  run: RunCommand,
): Promise<NativeSearchAttempt> {
  let result: Awaited<ReturnType<RunCommand>>
  try {
    result = await run(command, RG_ARGS, { cwd: root, timeoutMs: NATIVE_TIMEOUT_MS })
  } catch (error) {
    return { missing: isCommandMissing(error) }
  }
  if (result.code !== 0 && result.code !== 1) return { missing: false }

  const matches = new Set<string>()
  let truncated = false
  for (const rawPath of result.stdout.split('\0')) {
    const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//, '')
    if (normalized === '') continue
    const segments = normalized.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = segments.slice(0, index + 1).join('/')
      if (query.pathSuffix
        ? matchesQuery(candidate, query)
        : segments[index]!.toLowerCase().includes(query.needle)) matches.add(candidate)
      if (matches.size >= maxMatches) break
    }
    if (matches.size >= maxMatches) {
      truncated = true
      break
    }
  }
  return { result: { matches: [...matches].sort(), truncated }, missing: false }
}

/** Try packaged then PATH ripgrep for a forced engine or fd fallback. */
async function searchRgChain(
  root: string,
  query: SearchQuery,
  maxMatches: number,
  run: RunCommand,
  resolveRg: ResolvePackagedRg,
  skipPackaged = false,
  onEngineSelected?: FsSearchOptions['onEngineSelected'],
): Promise<FsSearchResult | undefined> {
  const state = getDetectionState(run, resolveRg)
  if (!skipPackaged) {
    const rgPath = await resolvePackagedRgCached(resolveRg)
    if (rgPath !== null && !state.unavailable.has(rgPath)) {
      const attempt = await searchWithRg(rgPath, root, query, maxMatches, run)
      if (attempt.result !== undefined) {
        reportEngine(state, 'packaged-rg', onEngineSelected)
        return attempt.result
      }
      if (attempt.missing) state.unavailable.add(rgPath)
    }
  }
  if (state.unavailable.has('rg')) return undefined
  const pathRg = await run('rg', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
    .then(result => result.code === 0)
    .catch(() => false)
  if (!pathRg) {
    state.unavailable.add('rg')
    return undefined
  }
  const attempt = await searchWithRg('rg', root, query, maxMatches, run)
  if (attempt.missing) state.unavailable.add('rg')
  if (attempt.result !== undefined) reportEngine(state, 'path-rg', onEngineSelected)
  return attempt.result
}

/**
 * Search `root` recursively by entry-name substring or relative-path suffix.
 * Matching is case-insensitive.
 * @param root - absolute search root.
 * @param query - name substring, or path suffix when it contains a separator; empty matches nothing.
 * @param opts - budget overrides and injectable native-engine seams.
 * @returns the matching paths RELATIVE to `root` ('/'-separated), sorted,
 *  plus whether a budget cut the walk short. An unreadable level is skipped
 *  (permission errors never fail the whole search).
 */
export async function searchFiles(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const parsedQuery = parseQuery(query)
  if (parsedQuery.needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED
  const run = opts.runCommand ?? runCommand
  const resolveRg = opts.resolvePackagedRg ?? resolvePackagedRg
  const state = getDetectionState(run, resolveRg)

  if (opts.engine !== 'js') {
    if (opts.engine === undefined || opts.engine === 'auto') {
      while (true) {
        const detected = await detectEngineCached(run, resolveRg)
        if (detected.kind === 'js') break
        const attempt = detected.kind === 'fd'
          ? await searchWithFd(detected.command, root, parsedQuery, maxMatches, run)
          : await searchWithRg(detected.command, root, parsedQuery, maxMatches, run)
        if (attempt.result !== undefined) {
          reportEngine(
            state,
            detected.kind === 'fd'
              ? detected.command
              : detected.command === 'rg' ? 'path-rg' : 'packaged-rg',
            opts.onEngineSelected,
          )
          return attempt.result
        }
        if (attempt.missing) {
          invalidateCommand(run, resolveRg, detected.command)
          continue
        }
        if (detected.kind === 'fd') {
          const fallback = await searchRgChain(root, parsedQuery, maxMatches, run, resolveRg, false, opts.onEngineSelected)
          if (fallback !== undefined) return fallback
        } else if (detected.command !== 'rg') {
          const fallback = await searchRgChain(root, parsedQuery, maxMatches, run, resolveRg, true, opts.onEngineSelected)
          if (fallback !== undefined) return fallback
        }
        break
      }
    } else {
      if (opts.engine === 'fd') {
        const attempt = await searchWithFd('fd', root, parsedQuery, maxMatches, run)
        if (attempt.result !== undefined) {
          reportEngine(state, 'fd', opts.onEngineSelected)
          return attempt.result
        }
        if (attempt.missing) invalidateCommand(run, resolveRg, 'fd')
      }
      const result = await searchRgChain(root, parsedQuery, maxMatches, run, resolveRg, false, opts.onEngineSelected)
      if (result !== undefined) return result
    }
  }

  reportEngine(state, 'js', opts.onEngineSelected)
  const matches: string[] = []
  let visited = 0
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const level = await opendir(dir).catch(() => undefined)
    if (level === undefined) return
    for await (const dirent of level) {
      visited += 1
      if (visited > maxVisited) {
        truncated = true
        return
      }
      // Dependency / VCS / build-output forests: never matched, never descended.
      if (dirent.isDirectory() && SEARCH_SKIP_DIRS.has(dirent.name.toLowerCase())) continue
      const relativePath = join(relative(root, dir), dirent.name)
      const candidate = relativePath.split(sep).join('/')
      if (matchesQuery(candidate, parsedQuery)) {
        matches.push(relativePath)
        if (matches.length >= maxMatches) {
          truncated = true
          return
        }
      }
      // Descend real directories only: a symlinked directory may point back
      // up the tree (cycle).
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        await walk(join(dir, dirent.name))
        if (truncated) return
      }
    }
  }
  await walk(root)
  // '/' separators on every platform: the client joins onto the cwd itself.
  return { matches: matches.sort().map(path => path.split(sep).join('/')), truncated }
}
