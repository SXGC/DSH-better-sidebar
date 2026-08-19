/**
 * Recursive file-name search for the editor's merged-mode side panel. Native
 * file listing is preferred when available, with the original opendir walk as
 * the fallback. The query is a case-insensitive substring of each entry's
 * NAME (paths stay relative to the search root — the client resolves them
 * against the session cwd). No engine applies .gitignore semantics; `.git`
 * directories are skipped outright and symlink directories are not followed.
 *
 * Two performance budgets bound the walk: `maxMatches` (the client renders
 * the flat list) and `maxVisited` (a runaway tree — a home directory root,
 * a node_modules forest — must not stall the host). Exceeding either stops
 * early with `truncated: true`.
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
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000
const NATIVE_TIMEOUT_MS = 10_000

let packagedRgPathPromise: Promise<string | null> | undefined

/** Resolve the packaged ripgrep path once without making module loading eager. */
async function resolvePackagedRg(): Promise<string | null> {
  packagedRgPathPromise ??= import('@vscode/ripgrep')
    .then(module => module.rgPath || null)
    .catch(() => null)
  return await packagedRgPathPromise
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

const RG_ARGS = [
  '--no-config',
  '--files',
  '--hidden',
  '--no-ignore',
  '--no-follow',
  '--glob',
  '!.git',
  '--glob',
  '!.git/**',
  '--null',
] as const

/** List files with ripgrep and rebuild matching path prefixes. */
async function searchWithRg(
  command: string,
  root: string,
  needle: string,
  maxMatches: number,
  run: RunCommand,
): Promise<FsSearchResult | undefined> {
  const result = await run(command, RG_ARGS, { cwd: root, timeoutMs: NATIVE_TIMEOUT_MS }).catch(() => undefined)
  if (result === undefined || (result.code !== 0 && result.code !== 1)) return undefined

  const matches = new Set<string>()
  let truncated = false
  for (const rawPath of result.stdout.split('\0')) {
    const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//, '')
    if (normalized === '') continue
    const segments = normalized.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      if (!segments[index]!.toLowerCase().includes(needle)) continue
      matches.add(segments.slice(0, index + 1).join('/'))
      if (matches.size >= maxMatches) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  return { matches: [...matches].sort(), truncated }
}

/**
 * Search `root` recursively for entries whose name contains `query`
 * (case-insensitive).
 * @param root - absolute search root.
 * @param query - the name substring; empty matches nothing.
 * @param opts - budget overrides and injectable native-engine seams.
 * @returns the matching paths RELATIVE to `root` ('/'-separated), sorted,
 *  plus whether a budget cut the walk short. An unreadable level is skipped
 *  (permission errors never fail the whole search).
 */
export async function searchFiles(root: string, query: string, opts: FsSearchOptions = {}): Promise<FsSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED

  if (opts.engine !== 'js') {
    const run = opts.runCommand ?? runCommand
    const rgPath = await (opts.resolvePackagedRg ?? resolvePackagedRg)().catch(() => null)
    if (rgPath !== null) {
      const result = await searchWithRg(rgPath, root, needle, maxMatches, run)
      if (result !== undefined) return result
    }
    const pathRg = await run('rg', ['--version'], { timeoutMs: 1_000 })
      .then(result => result.code === 0)
      .catch(() => false)
    if (pathRg) {
      const result = await searchWithRg('rg', root, needle, maxMatches, run)
      if (result !== undefined) return result
    }
  }

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
      // .git is VCS-internal noise: never matched, never descended.
      if (dirent.isDirectory() && dirent.name === '.git') continue
      if (dirent.name.toLowerCase().includes(needle)) {
        matches.push(join(relative(root, dir), dirent.name))
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
