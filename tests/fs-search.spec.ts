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

import { searchFiles, type FsSearchOptions, type RunCommand } from '../src/fs-search.ts'

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

  it('runs fd with literal name-search arguments and normalizes its capped output', async () => {
    const runCommand = vi.fn<RunCommand>(async () => ({
      code: 0,
      stdout: './-foo-zeta.md\0src\\-foo.md\0',
      stderr: '',
    }))

    const result = await searchFiles('/workspace', '-foo', {
      engine: 'fd',
      maxMatches: 2,
      resolvePackagedRg: async () => null,
      runCommand,
    })

    expect(result).toEqual({ matches: ['-foo-zeta.md', 'src/-foo.md'], truncated: true })
    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand).toHaveBeenCalledWith('fd', [
      '-H',
      '--no-ignore',
      '-F',
      '-i',
      '--print0',
      '--exclude',
      '.git',
      '--max-results',
      '2',
      '--',
      '-foo',
      '.',
    ], { cwd: '/workspace', timeoutMs: 10_000 })
    expect(runCommand.mock.calls[0]![1]).not.toContain('-t')
    expect(runCommand.mock.calls[0]![1]).not.toContain('-L')
  })

  it('detects fd then fdfind before resolving packaged ripgrep', async () => {
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return command === 'fdfind'
          ? { code: 0, stdout: 'fdfind 10', stderr: '' }
          : { code: 127, stdout: '', stderr: 'not found' }
      }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => '/fake/packaged-rg')

    const result = await searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['fd', ['--version']],
      ['fdfind', ['--version']],
      ['fdfind', expect.arrayContaining(['-F', '--print0', '--', 'util', '.'])],
    ])
    expect(resolvePackagedRg).not.toHaveBeenCalled()
  })

  it('caches automatic detection and shares its in-flight promise', async () => {
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        await probeGate
        return { code: 0, stdout: 'fd 10', stderr: '' }
      }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => null)

    const first = searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })
    const second = searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1))
    releaseProbe()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { matches: ['src/util.ts'], truncated: false },
      { matches: ['src/util.ts'], truncated: false },
    ])
    await expect(searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })).resolves.toEqual({
      matches: ['src/util.ts'],
      truncated: false,
    })
    expect(runCommand.mock.calls.filter(([, args]) => args[0] === '--version')).toHaveLength(1)
    expect(runCommand.mock.calls.filter(([, args]) => args[0] !== '--version')).toHaveLength(3)
    expect(resolvePackagedRg).not.toHaveBeenCalled()
  })

  it('invalidates an fd command rejected with ENOENT and reselects the next tier', async () => {
    const missing = Object.assign(new Error('fd disappeared'), { code: 'ENOENT' })
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'fd' && args[0] === '--version') return { code: 0, stdout: 'fd 10', stderr: '' }
      if (command === 'fd') throw missing
      if (command === 'fdfind') return { code: 127, stdout: '', stderr: 'not found' }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => '/fake/rg')

    await expect(searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })).resolves.toEqual({
      matches: ['src/util.ts'],
      truncated: false,
    })
    await expect(searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })).resolves.toEqual({
      matches: ['src/util.ts'],
      truncated: false,
    })

    expect(runCommand.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['fd', '--version'],
      ['fd', '-H'],
      ['fdfind', '--version'],
      ['/fake/rg', '--no-config'],
      ['/fake/rg', '--no-config'],
    ])
    expect(resolvePackagedRg).toHaveBeenCalledOnce()
  })

  it('shares redetection when concurrent fd searches both reject with ENOENT', async () => {
    const missing = Object.assign(new Error('fd disappeared'), { code: 'ENOENT' })
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'fd' && args[0] === '--version') return { code: 0, stdout: 'fd 10', stderr: '' }
      if (command === 'fd') throw missing
      if (command === 'fdfind') return { code: 127, stdout: '', stderr: 'not found' }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => '/fake/rg')

    await Promise.all([
      searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg }),
      searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg }),
    ])

    expect(runCommand.mock.calls.filter(([command, args]) => command === 'fdfind' && args[0] === '--version')).toHaveLength(1)
  })

  it('keeps a discovered fd command cached after an ordinary search rejection', async () => {
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'fd' && args[0] === '--version') return { code: 0, stdout: 'fd 10', stderr: '' }
      if (command === 'fd') throw new Error('timed out')
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => '/fake/rg')

    await searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })
    await searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })

    expect(runCommand.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['fd', '--version'],
      ['fd', '-H'],
      ['/fake/rg', '--no-config'],
      ['fd', '-H'],
      ['/fake/rg', '--no-config'],
    ])
    expect(resolvePackagedRg).toHaveBeenCalledOnce()
  })

  it('caches missing PATH probes after selecting PATH ripgrep', async () => {
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return command === 'rg'
          ? { code: 0, stdout: 'ripgrep 14', stderr: '' }
          : { code: 127, stdout: '', stderr: 'not found' }
      }
      return { code: 0, stdout: 'src/util.ts\0', stderr: '' }
    })
    const resolvePackagedRg = vi.fn(async () => null)

    await searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })
    await searchFiles('/workspace', 'util', { runCommand, resolvePackagedRg })

    expect(runCommand.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['fd', '--version'],
      ['fdfind', '--version'],
      ['rg', '--version'],
      ['rg', '--no-config'],
      ['rg', '--no-config'],
    ])
    expect(resolvePackagedRg).toHaveBeenCalledOnce()
  })

  it('matches the JS result set for directories, hidden and ignored entries through fd', async () => {
    const dir = makeFixture()
    mkdirSync(join(dir, 'MatchDir'))
    mkdirSync(join(dir, '.hidden-match'))
    writeFileSync(join(dir, 'ignored-match.txt'), 'visible despite ignore rules')
    writeFileSync(join(dir, '.gitignore'), 'ignored-match.txt\n')
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: './ignored-match.txt\0.hidden-match\0MatchDir\0',
      stderr: '',
    }))
    try {
      const js = await searchWithJs(dir, 'MATCH')
      const fd = await searchFiles(dir, 'MATCH', {
        engine: 'fd',
        resolvePackagedRg: async () => null,
        runCommand,
      })

      expect(fd).toEqual(js)
      expect(fd).toEqual({
        matches: ['.hidden-match', 'MatchDir', 'ignored-match.txt'],
        truncated: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes a dotted fd query as a fixed string', async () => {
    const runCommand = vi.fn<RunCommand>(async () => ({ code: 0, stdout: 'README.md\0', stderr: '' }))

    await searchFiles('/workspace', '.md', {
      engine: 'fd',
      resolvePackagedRg: async () => null,
      runCommand,
    })

    expect(runCommand.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-F', '--', '.md', '.']))
  })

  it('falls through the rg chain when the forced fd seam fails', async () => {
    const runCommand = vi.fn<RunCommand>(async command => command === 'fd'
      ? { code: 2, stdout: '', stderr: 'fd failed' }
      : { code: 0, stdout: 'src/util.ts\0', stderr: '' })

    const result = await searchFiles('/workspace', 'util', {
      engine: 'fd',
      resolvePackagedRg: async () => '/fake/rg',
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ['fd', '-H'],
      ['/fake/rg', '--no-config'],
    ])
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
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => args[0] === '--version'
      ? { code: 127, stdout: '', stderr: 'not found' }
      : { code: 0, stdout: 'src/util.ts\0', stderr: '' })

    const result = await searchFiles('/workspace', 'util', {
      resolvePackagedRg: async () => '/fake/packaged-rg',
      runCommand,
    })

    expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    expect(runCommand).toHaveBeenCalledTimes(3)
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
