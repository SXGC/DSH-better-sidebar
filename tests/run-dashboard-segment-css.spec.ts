import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/SubagentView.module.css', import.meta.url)),
  'utf8',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`${escaped}[^{]*\\{([^}]+)\\}`, 'u').exec(css)
  expect(match, `.${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

function exactRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*\\.${escaped}\\s*\\{([^}]+)\\}`, 'u').exec(css)
  expect(match, `.${selector} exact rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('Run Dashboard segment weave', () => {
  it('does not inflate every absolutely positioned segment with horizontal chrome', () => {
    const segment = exactRule('runDashboardSegment')
    expect(segment).not.toContain('min-width:')
    expect(segment).not.toContain('padding:')
  })

  it('paints cold/closed end ticks as a solid fill, not a 1px stripe weave', () => {
    const cold = rule('runDashboardSegment[data-segment-state="cold"]')
    const closed = rule('runDashboardSegment[data-segment-state="closed"]')
    // A 3px stub with a 1px-on/4px-off stripe only ever shows one line, and
    // that line vanishes on the 1Hz now-tick as the shared range grows.
    expect(cold).not.toContain('repeating-linear-gradient')
    expect(closed).not.toContain('repeating-linear-gradient')
    expect(cold).toContain('background-color:')
    expect(closed).toContain('background-color:')
  })
})
