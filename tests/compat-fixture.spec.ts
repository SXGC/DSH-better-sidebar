import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const helper = resolve('scripts/compat-fixture.sh')
const repository = resolve('.')
const legacyCommit = 'f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1'

describe('parameterized compatibility fixture helper', () => {
  let root: string
  let fakeDsh: string
  let plugin: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-compat-fixture-test-'))
    mkdirSync(join(root, 'capture'))
    mkdirSync(join(root, 'scratch'))

    plugin = join(root, 'plugin')
    mkdirSync(plugin)
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '9.9.9-test' }))

    fakeDsh = join(root, 'fake-dsh.sh')
    writeFileSync(fakeDsh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${CAPTURE_DIR:?}/dsh.calls"
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "\${FAKE_DSH_VERSION:?}"
  exit 0
fi
capture="\${CAPTURE_DIR:?}/\${FAKE_RUN_ID:?}"
printf '%s\\n' "\${DSH_HOME:?}" > "\${capture}.home"
printf '%s\\n' "$*" > "\${capture}.args"
cp "\${DSH_HOME}/profiles/web/pnpm-workspace.yaml" "\${capture}.workspace.yaml"
case "\${FAKE_DSH_RESULT:-success}" in
  success) exit 0 ;;
  peer) printf '%s\\n' '[pnpm] ERR_PNPM_PEER_DEP_ISSUES: incompatible peer versions' >&2; exit 1 ;;
  bare-peer) printf '%s\\n' 'peer mismatch for fixture' >&2; exit 1 ;;
  bare-unmet-peer) printf '%s\\n' 'unmet peer dependencies' >&2; exit 1 ;;
  *) printf '%s\\n' 'ERR_PNPM_FETCH_404: external package could not be resolved' >&2; exit 1 ;;
esac
`)
    chmodSync(fakeDsh, 0o755)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function run(
    mode: 'supported-strict' | 'outside-range-negative' | 'legacy-runtime-only',
    extraArgs: string[] = [],
    env: Record<string, string> = {},
    pluginInput = plugin,
    pluginInputKind: 'source' | 'tarball' | null = 'source',
  ) {
    const args = [
      helper,
      mode,
      '--dsh-command', fakeDsh,
      '--dsh-version', env.FAKE_DSH_VERSION ?? '0.1.1-rc.3',
      '--plugin-input', pluginInput,
      '--scratch-base', join(root, 'scratch'),
    ]
    if (pluginInputKind) args.push('--plugin-input-kind', pluginInputKind)
    args.push(...extraArgs)
    return spawnSync('bash', args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE_DIR: join(root, 'capture'),
        FAKE_RUN_ID: 'run',
        FAKE_DSH_RESULT: 'success',
        FAKE_DSH_VERSION: '0.1.1-rc.3',
        ...env,
      },
    })
  }

  function git(cwd: string, args: string[]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }

  function legacyWorktree(label: string, ref = legacyCommit) {
    const clone = join(root, `${label}-clone`)
    const worktree = join(root, `${label}-worktree`)
    git(root, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', repository, clone])
    git(clone, ['worktree', 'add', '--quiet', '--detach', worktree, ref])
    return worktree
  }

  function legacyTarball(label: string, manifest?: { name?: string, version?: string }) {
    const content = join(root, `${label}-content`)
    const tarball = join(root, `${label}.tgz`)
    mkdirSync(join(content, 'package'), { recursive: true })
    if (manifest) writeFileSync(join(content, 'package/package.json'), JSON.stringify(manifest))
    const packed = spawnSync('tar', ['-czf', tarball, '-C', content, 'package'], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`)
    const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    return { tarball, digest }
  }

  it('creates a fresh strict scratch profile for every supported run and forwards only explicit inputs', () => {
    const first = run('supported-strict', [], { FAKE_RUN_ID: 'first' })
    const second = run('supported-strict', [], { FAKE_RUN_ID: 'second' })

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const firstHome = readFileSync(join(root, 'capture/first.home'), 'utf8').trim()
    const secondHome = readFileSync(join(root, 'capture/second.home'), 'utf8').trim()
    expect(firstHome).not.toBe(secondHome)
    expect(readFileSync(join(root, 'capture/first.workspace.yaml'), 'utf8')).toContain('strictPeerDependencies: true')
    expect(readFileSync(join(root, 'capture/first.args'), 'utf8')).toContain(`plugin --profile web add file:${plugin}`)
    expect(`${first.stdout}${first.stderr}`).toContain('SUPPORTED_STRICT')
  })

  it('accepts only a failed install with the pnpm peer-dependency error code in the outside-range negative lane', () => {
    const expected = run('outside-range-negative', [], { FAKE_DSH_RESULT: 'peer' })
    const barePeerMismatch = run('outside-range-negative', [], { FAKE_DSH_RESULT: 'bare-peer' })
    const bareUnmetPeer = run('outside-range-negative', [], { FAKE_DSH_RESULT: 'bare-unmet-peer' })
    const unexpectedSuccess = run('outside-range-negative')
    const unrelatedFailure = run('outside-range-negative', [], { FAKE_DSH_RESULT: 'other' })

    expect(expected.status, expected.stderr).toBe(0)
    expect(`${expected.stdout}${expected.stderr}`).toContain('EXPECTED_FAIL')
    expect(`${expected.stdout}${expected.stderr}`).toContain('[pnpm] ERR_PNPM_PEER_DEP_ISSUES')
    expect(barePeerMismatch.status).not.toBe(0)
    expect(bareUnmetPeer.status).not.toBe(0)
    expect(unexpectedSuccess.status).not.toBe(0)
    expect(`${unexpectedSuccess.stdout}${unexpectedSuccess.stderr}`).toContain('unexpectedly succeeded')
    expect(unrelatedFailure.status).not.toBe(0)
    expect(`${unrelatedFailure.stdout}${unrelatedFailure.stderr}`).toContain('did not report ERR_PNPM_PEER_DEP_ISSUES')
  })

  it('runs legacy 0.16.1 in an isolated non-strict fixture with explicit unsupported labels', () => {
    const legacySource = legacyWorktree('success')
    const runtimeProbe = join(root, 'runtime-probe.sh')
    writeFileSync(runtimeProbe, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${COMPAT_LANE:?} \${COMPAT_SUPPORT_STATUS:?} \${COMPAT_LEGACY_IDENTITY:?}" > "\${CAPTURE_DIR:?}/runtime.labels"
printf '%s\\n' "\${COMPAT_PLUGIN_INPUT:?}" > "\${CAPTURE_DIR:?}/runtime.input"
test -f "\${DSH_HOME:?}/profiles/web/pnpm-workspace.yaml"
`)
    chmodSync(runtimeProbe, 0o755)

    const result = run('legacy-runtime-only', [
      '--legacy-source-ref', legacyCommit,
      '--runtime-command', runtimeProbe,
    ], {}, legacySource)

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(root, 'capture/run.workspace.yaml'), 'utf8')).toContain('strictPeerDependencies: false')
    expect(readFileSync(join(root, 'capture/runtime.labels'), 'utf8')).toContain(`LEGACY_RUNTIME_REGRESSION_ONLY UNSUPPORTED git:${legacyCommit}`)
    const installedInput = readFileSync(join(root, 'capture/runtime.input'), 'utf8').trim()
    const installArgs = readFileSync(join(root, 'capture/run.args'), 'utf8')
    expect(installedInput).not.toBe(legacySource)
    expect(installArgs).toContain(`plugin --profile web add file:${installedInput}`)
    expect(installArgs).not.toContain(legacySource)
    expect(`${result.stdout}${result.stderr}`).toContain(`LEGACY_IDENTITY=git:${legacyCommit}`)
    expect(`${result.stdout}${result.stderr}`).toContain('LEGACY_RUNTIME_REGRESSION_ONLY')
    expect(`${result.stdout}${result.stderr}`).toContain('UNSUPPORTED')
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/(^|\s)SUPPORTED($|\s)/m)
  })

  it('runs a legacy tarball only when its explicit digest and npm manifest identity match', () => {
    const { tarball, digest } = legacyTarball('valid-legacy', {
      name: 'dsh-better-sidebar',
      version: '0.16.1',
    })
    const runtimeProbe = join(root, 'tarball-runtime-probe.sh')
    writeFileSync(runtimeProbe, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${COMPAT_LANE:?} \${COMPAT_SUPPORT_STATUS:?} \${COMPAT_LEGACY_IDENTITY:?} \${LEGACY_IDENTITY:?}" > "\${CAPTURE_DIR:?}/runtime.labels"
`)
    chmodSync(runtimeProbe, 0o755)

    const result = run('legacy-runtime-only', [
      '--legacy-expected-sha256', digest,
      '--runtime-command', runtimeProbe,
    ], {}, tarball, 'tarball')

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(root, 'capture/runtime.labels'), 'utf8')).toContain(`LEGACY_RUNTIME_REGRESSION_ONLY UNSUPPORTED sha256:${digest} sha256:${digest}`)
    expect(`${result.stdout}${result.stderr}`).toContain(`LEGACY_IDENTITY=sha256:${digest}`)
    expect(`${result.stdout}${result.stderr}`).toContain('LEGACY_RUNTIME_REGRESSION_ONLY')
    expect(`${result.stdout}${result.stderr}`).toContain('UNSUPPORTED')
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/(^|\s)SUPPORTED($|\s)/m)
  })

  it('rejects every legacy tarball identity failure before DSH or runtime execution', () => {
    const valid = legacyTarball('valid-for-failures', {
      name: 'dsh-better-sidebar',
      version: '0.16.1',
    })
    const missingManifest = legacyTarball('missing-manifest')
    const wrongName = legacyTarball('wrong-name', { name: 'forged-sidebar', version: '0.16.1' })
    const wrongVersion = legacyTarball('wrong-version', { name: 'dsh-better-sidebar', version: '0.16.0' })
    const runtimeProbe = join(root, 'tarball-runtime-must-not-run.sh')
    writeFileSync(runtimeProbe, `#!/usr/bin/env bash
set -euo pipefail
touch "\${CAPTURE_DIR:?}/runtime.called"
`)
    chmodSync(runtimeProbe, 0o755)
    const runtimeArgs = ['--runtime-command', runtimeProbe]

    const missingHash = run('legacy-runtime-only', runtimeArgs, {}, valid.tarball, 'tarball')
    expect(`${missingHash.stdout}${missingHash.stderr}`).toContain('--legacy-expected-sha256 is required')

    const malformedHash = run('legacy-runtime-only', [
      '--legacy-expected-sha256', 'not-a-64-hex-digest',
      ...runtimeArgs,
    ], {}, valid.tarball, 'tarball')
    expect(`${malformedHash.stdout}${malformedHash.stderr}`).toContain('--legacy-expected-sha256 must be exactly 64 hexadecimal characters')

    const digestMismatch = run('legacy-runtime-only', [
      '--legacy-expected-sha256', '0'.repeat(64),
      ...runtimeArgs,
    ], {}, valid.tarball, 'tarball')
    expect(`${digestMismatch.stdout}${digestMismatch.stderr}`).toContain('legacy tarball SHA-256 mismatch')

    const manifestMissing = run('legacy-runtime-only', [
      '--legacy-expected-sha256', missingManifest.digest,
      ...runtimeArgs,
    ], {}, missingManifest.tarball, 'tarball')
    expect(`${manifestMissing.stdout}${manifestMissing.stderr}`).toContain('legacy tarball must contain a readable package/package.json')

    const nameMismatch = run('legacy-runtime-only', [
      '--legacy-expected-sha256', wrongName.digest,
      ...runtimeArgs,
    ], {}, wrongName.tarball, 'tarball')
    expect(`${nameMismatch.stdout}${nameMismatch.stderr}`).toContain('legacy tarball package name mismatch: expected dsh-better-sidebar, got forged-sidebar')

    const versionMismatch = run('legacy-runtime-only', [
      '--legacy-expected-sha256', wrongVersion.digest,
      ...runtimeArgs,
    ], {}, wrongVersion.tarball, 'tarball')
    expect(`${versionMismatch.stdout}${versionMismatch.stderr}`).toContain('legacy tarball package version mismatch: expected 0.16.1, got 0.16.0')

    for (const result of [missingHash, malformedHash, digestMismatch, manifestMissing, nameMismatch, versionMismatch]) {
      expect(result.status).not.toBe(0)
    }
    expect(existsSync(join(root, 'capture/dsh.calls'))).toBe(false)
    expect(existsSync(join(root, 'capture/runtime.called'))).toBe(false)
  })

  it('rejects every legacy source identity failure before DSH or runtime execution', () => {
    const runtimeProbe = join(root, 'runtime-probe.sh')
    writeFileSync(runtimeProbe, `#!/usr/bin/env bash
set -euo pipefail
touch "\${CAPTURE_DIR:?}/runtime.called"
`)
    chmodSync(runtimeProbe, 0o755)
    const legacyArgs = ['--runtime-command', runtimeProbe]

    const missingRef = run('legacy-runtime-only', legacyArgs, {}, plugin)
    expect(`${missingRef.stdout}${missingRef.stderr}`).toContain('--legacy-source-ref is required')

    const missingKind = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit, ...legacyArgs], {}, plugin, null)
    expect(`${missingKind.stdout}${missingKind.stderr}`).toContain('--plugin-input-kind is required')

    const nonGit = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit, ...legacyArgs])
    expect(`${nonGit.stdout}${nonGit.stderr}`).toContain('legacy source input is not a Git worktree')

    const refMismatchSource = legacyWorktree('ref-mismatch')
    const refMismatch = run('legacy-runtime-only', ['--legacy-source-ref', `${legacyCommit}^`, ...legacyArgs], {}, refMismatchSource)
    expect(`${refMismatch.stdout}${refMismatch.stderr}`).toContain('legacy source ref mismatch')

    const headMismatchSource = legacyWorktree('head-mismatch', `${legacyCommit}^`)
    const headMismatch = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit, ...legacyArgs], {}, headMismatchSource)
    expect(`${headMismatch.stdout}${headMismatch.stderr}`).toContain('legacy source HEAD mismatch')

    const trackedDirtySource = legacyWorktree('tracked-dirty')
    writeFileSync(join(trackedDirtySource, 'README.md'), `${readFileSync(join(trackedDirtySource, 'README.md'), 'utf8')}\ndirty\n`)
    const trackedDirty = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit, ...legacyArgs], {}, trackedDirtySource)
    expect(`${trackedDirty.stdout}${trackedDirty.stderr}`).toContain('legacy source is dirty')

    const untrackedDirtySource = legacyWorktree('untracked-dirty')
    writeFileSync(join(untrackedDirtySource, 'untracked.txt'), 'dirty\n')
    const untrackedDirty = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit, ...legacyArgs], {}, untrackedDirtySource)
    expect(`${untrackedDirty.stdout}${untrackedDirty.stderr}`).toContain('legacy source is dirty')

    const forgedSource = join(root, 'forged-source')
    mkdirSync(forgedSource)
    writeFileSync(join(forgedSource, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '0.16.1' }))
    git(forgedSource, ['init', '--quiet'])
    git(forgedSource, ['add', 'package.json'])
    git(forgedSource, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'forged version'])
    const forged = run('legacy-runtime-only', ['--legacy-source-ref', 'HEAD', ...legacyArgs], {}, forgedSource)
    expect(`${forged.stdout}${forged.stderr}`).toContain('legacy source ref mismatch')

    for (const result of [missingRef, missingKind, nonGit, refMismatch, headMismatch, trackedDirty, untrackedDirty, forged]) {
      expect(result.status).not.toBe(0)
    }
    expect(existsSync(join(root, 'capture/dsh.calls'))).toBe(false)
    expect(existsSync(join(root, 'capture/runtime.called'))).toBe(false)
  })

  it('fails clearly for unresolved inputs, kind mismatches, missing legacy probes, and peer bypass flags', () => {
    const unresolved = run('supported-strict', [], { FAKE_DSH_RESULT: 'other' })
    expect(unresolved.status).not.toBe(0)
    expect(`${unresolved.stdout}${unresolved.stderr}`).toContain('could not resolve or install the explicit DSH/plugin inputs')

    const kindMismatch = run('supported-strict', [], {}, plugin, 'tarball')
    expect(kindMismatch.status).not.toBe(0)
    expect(`${kindMismatch.stdout}${kindMismatch.stderr}`).toContain('--plugin-input-kind tarball requires a file')

    const missingProbeSource = legacyWorktree('missing-probe')
    const missingProbe = run('legacy-runtime-only', ['--legacy-source-ref', legacyCommit], {}, missingProbeSource)
    expect(missingProbe.status).not.toBe(0)
    expect(`${missingProbe.stdout}${missingProbe.stderr}`).toContain('--runtime-command is required')

    const bypass = run('supported-strict', ['--dsh-arg', '--force'])
    expect(bypass.status).not.toBe(0)
    expect(`${bypass.stdout}${bypass.stderr}`).toContain('peer bypass flag is forbidden')
  })
})
