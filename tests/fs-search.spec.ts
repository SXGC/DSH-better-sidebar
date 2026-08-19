/**
 * fs-search: the host's recursive file-name search behind the editor side
 * panel's search box. Matches are case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated); `.git` directories are skipped,
 * symlinked directories are never descended (cycle safety), and the
 * maxMatches/maxVisited budgets stop a runaway walk with `truncated: true`.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ripgrepModule = vi.hoisted(() => ({ evaluations: 0 }))
vi.mock('@vscode/ripgrep', () => {
  ripgrepModule.evaluations += 1
  throw new Error('optional ripgrep platform package is missing')
})

import { searchFiles, type FsSearchOptions } from '../src/fs-search.ts'

/** Exercise the original traversal independently of tools installed on the host. */
function searchWithJs(root: string, query: string, opts: FsSearchOptions = {}) {
  return searchFiles(root, query, { ...opts, engine: 'js' })
}

/**
 * Symlink creation needs extra privileges on Windows; the symlink case skips
 * there rather than fails (mirror of the fs-tree symlink spec).
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch tree: nested matches, a .git dir, and unrelated noise. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'docs'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, '.git', 'objects'))
  writeFileSync(join(dir, 'README.md'), 'readme')
  writeFileSync(join(dir, 'src', 'Index.TS'), 'code')
  writeFileSync(join(dir, 'src', 'util.ts'), 'code')
  writeFileSync(join(dir, 'docs', 'guide.md'), 'doc')
  writeFileSync(join(dir, '.git', 'config'), 'git-internal')
  writeFileSync(join(dir, '.git', 'objects', 'readme-pack'), 'git-internal')
  return dir
}

describe('fs-search', () => {
  it('loads without ripgrep and caches a failed lazy resolution', async () => {
    const dir = makeFixture()
    const runCommand = vi.fn(async () => ({ code: 127, stdout: '', stderr: 'not found' }))
    try {
      expect(ripgrepModule.evaluations).toBe(0)
      expect(await searchWithJs(dir, 'util')).toEqual({ matches: ['src/util.ts'], truncated: false })
      expect(ripgrepModule.evaluations).toBe(0)

      await searchFiles('/missing', 'x', { runCommand })
      await searchFiles('/missing', 'x', { runCommand })
      expect(ripgrepModule.evaluations).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses ripgrep file output to reconstruct matching files and directories', async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: 'src/Index.TS\0src/util.ts\0docs/guide.md\0',
      stderr: '',
    }))

    const directory = await searchFiles('/workspace', 'SRC', {
      engine: 'rg',
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })
    const file = await searchFiles('/workspace', 'util', {
      engine: 'rg',
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })

    expect(directory).toEqual({ matches: ['src'], truncated: false })
    expect(file).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand).toHaveBeenCalledWith('/fake/rg', [
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
    ], { cwd: '/workspace', timeoutMs: 10_000 })
  })

  it('uses PATH ripgrep when the packaged binary is unavailable', async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => args[0] === '--version'
      ? { code: 0, stdout: 'ripgrep 14', stderr: '' }
      : { code: 0, stdout: 'src/util.ts\0', stderr: '' })

    const result = await searchFiles('/workspace', 'util', {
      engine: 'rg',
      resolvePackagedRg: async () => null,
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand).toHaveBeenNthCalledWith(1, 'rg', ['--version'], { timeoutMs: 1_000 })
    expect(runCommand).toHaveBeenNthCalledWith(2, 'rg', expect.arrayContaining(['--no-config', '--files']), {
      cwd: '/workspace',
      timeoutMs: 10_000,
    })
  })

  it('uses PATH ripgrep when the packaged binary search fails', async () => {
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/fake/rg') return { code: 2, stdout: '', stderr: 'failed' }
      if (args[0] === '--version') return { code: 0, stdout: 'ripgrep 14', stderr: '' }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })

    const result = await searchFiles('/workspace', 'util', {
      engine: 'rg',
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual(['/fake/rg', 'rg', 'rg'])
  })

  it('prefers packaged ripgrep to PATH ripgrep in automatic mode', async () => {
    const runCommand = vi.fn(async () => ({ code: 0, stdout: 'src/util.ts\0', stderr: '' }))

    const result = await searchFiles('/workspace', 'util', {
      resolvePackagedRg: async () => '/fake/packaged-rg',
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledWith('/fake/packaged-rg', expect.any(Array), {
      cwd: '/workspace',
      timeoutMs: 10_000,
    })
  })

  it('falls back to JS when PATH ripgrep search fails', async () => {
    const dir = makeFixture()
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => args[0] === '--version'
      ? { code: 0, stdout: 'ripgrep 14', stderr: '' }
      : { code: 2, stdout: '', stderr: 'search failed' })
    try {
      const result = await searchFiles(dir, 'util', {
        resolvePackagedRg: async () => null,
        runCommand,
      })

      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes, deduplicates, sorts, and caps ripgrep matches', async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: 'src\\other.ts\0src\\Index.TS\0src\\Index.TS\0',
      stderr: '',
    }))

    const result = await searchFiles('/workspace', '.ts', {
      engine: 'rg',
      maxMatches: 2,
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/Index.TS', 'src/other.ts'], truncated: true })
  })

  it('treats ripgrep exit code 1 as a successful empty listing', async () => {
    const runCommand = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))

    const result = await searchFiles('/missing', 'util', {
      engine: 'rg',
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })

    expect(result).toEqual({ matches: [], truncated: false })
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('matches name substrings and reports root-relative /-separated paths', async () => {
    const dir = makeFixture()
    try {
      const result = await searchWithJs(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
      // A multi-level match list is sorted and relative (never absolute).
      const md = await searchWithJs(dir, '.md')
      expect(md.truncated).toBe(false)
      expect(md.matches).toEqual(['README.md', 'docs/guide.md'])
      for (const match of md.matches) {
        expect(match.startsWith(dir)).toBe(false)
        expect(match).not.toContain('\\')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches case-insensitively on the entry name', async () => {
    const dir = makeFixture()
    try {
      expect((await searchWithJs(dir, 'index.ts')).matches).toEqual(['src/Index.TS'])
      expect((await searchWithJs(dir, 'INDEX.TS')).matches).toEqual(['src/Index.TS'])
      // Directory names match too (the client can hint where matches live).
      expect((await searchWithJs(dir, 'SRC')).matches).toEqual(['src'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into .git directories', async () => {
    const dir = makeFixture()
    try {
      // 'readme' would hit .git/objects/readme-pack if the walk entered .git.
      expect((await searchWithJs(dir, 'readme')).matches).toEqual(['README.md'])
      expect((await searchWithJs(dir, 'config')).matches).toEqual([])
      expect((await searchWithJs(dir, '.git')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing without walking', async () => {
    const dir = makeFixture()
    const resolvePackagedRg = vi.fn(async () => '/fake/rg')
    const runCommand = vi.fn(async () => ({ code: 0, stdout: 'README.md\0', stderr: '' }))
    try {
      expect(await searchWithJs(dir, '')).toEqual({ matches: [], truncated: false })
      expect(await searchFiles(dir, '   ', { resolvePackagedRg, runCommand })).toEqual({ matches: [], truncated: false })
      expect(resolvePackagedRg).not.toHaveBeenCalled()
      expect(runCommand).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('does not descend into symlinked directories (cycle safety)', async () => {
    const dir = makeFixture()
    try {
      // A link back to the root would loop forever if descended; a link to
      // src would duplicate its matches. Neither must be entered.
      symlinkSync(dir, join(dir, 'loop'))
      symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
      const result = await searchWithJs(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the match budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-cap-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `match-${index}.txt`), 'x')
      }
      const result = await searchWithJs(dir, 'match', { maxMatches: 2 })
      expect(result.truncated).toBe(true)
      expect(result.matches.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the visited budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-visited-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `file-${index}.txt`), 'x')
      }
      // The walk visits more entries than the budget allows and gives up.
      const result = await searchWithJs(dir, 'nomatch', { maxVisited: 3 })
      expect(result.truncated).toBe(true)
      expect(result.matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable root yields no matches instead of throwing', async () => {
    const dir = makeFixture()
    try {
      const missing = join(dir, 'does-not-exist')
      expect(await searchWithJs(missing, 'x')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
