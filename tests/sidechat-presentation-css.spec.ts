import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/SideChatView.module.css', import.meta.url)),
  'utf8',
)

function rule(selector: string): string {
  const match = new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`, 'u').exec(css)
  expect(match, `.${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('Side Chat presentation adapter contract', () => {
  it('pins the approved user bubble geometry and public tokens', () => {
    const user = rule('sidechatUser')
    expect(user).toContain('max-width: min(525px, 82%)')
    expect(user).toContain('padding: 10px 16px')
    expect(user).toContain('border-radius: 22px')
    expect(user).toContain('background: var(--dsw-specific-bubble)')
    expect(user).toContain('font: var(--dsw-font-markdown-small)')
  })

  it('pins the simplified composer to the approved InputBar surface tokens', () => {
    const composer = rule('sidechatComposer')
    const input = rule('sidechatComposerInput')
    const placeholder = rule('sidechatComposerInput::placeholder')
    expect(composer).toContain('border: 1px solid var(--dsw-alias-border-l2-darkmode-thin)')
    expect(composer).toContain('border-radius: 22px')
    expect(composer).toContain('background: var(--dsw-specific-input-major)')
    expect(composer).toContain('box-shadow: var(--dsw-shadow-lv2)')
    expect(input).toContain('font: var(--dsw-font-markdown-small)')
    expect(input).toContain('max-height: 132px')
    expect(placeholder).toContain('color: var(--dsw-alias-label-caption)')
  })

  it('does not read DSH private density variables or animate ordinary transcript rows', () => {
    expect(css).not.toContain('--dsl-')
    expect(css).not.toContain('.sidechatScroll > *')
    expect(css).not.toContain('@keyframes sidechatRowIn')
  })
})
