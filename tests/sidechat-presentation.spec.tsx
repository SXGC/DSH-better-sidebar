// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return {
    ...actual,
    MessageText: ({ text }: { text: string }) => <div data-primitive="message-text">{text}</div>,
    MarkdownText: ({ text, density }: { text: string; density?: string }) => (
      <div data-primitive="markdown-text" data-density={density}>{text}</div>
    ),
    DisclosureRow: ({
      title, open, expandable, onToggle, collapsedContent, children,
    }: {
      title: string
      open: boolean
      expandable: boolean
      onToggle: () => void
      collapsedContent?: ReactNode
      children?: ReactNode
    }) => (
      <section data-primitive="disclosure-row" data-title={title}>
        {expandable
          ? <button type="button" onClick={onToggle}>{title}{collapsedContent}</button>
          : <div>{title}{collapsedContent}</div>}
        {open && children}
      </section>
    ),
    CodeBlock: ({ code, density }: { code: string; density?: string }) => (
      <pre data-primitive="code-block" data-density={density}>{code}</pre>
    ),
  }
})

import { SideChatView } from '../src/client/SideChatView.tsx'
import { api } from '../src/client/api.ts'
import type { Context, SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

function entry(event: SidebarSessionEvent): SidebarHistoryEntry {
  return { event }
}

function event(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  const value: SidebarSessionEvent = { type, seq, time: seq * 1000, data }
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
    ? { ...value, surfaceOp: 'append' } as SidebarSessionEvent
    : value
}

const transcript = [
  entry(event('session/end-seed', 0)),
  entry(event('user/message', 1, {
    content: [{ type: 'text', text: '# literal **markdown**' }],
    source: { kind: 'user' },
  })),
  entry(event('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: { content: [
      { type: 'reasoning', text: 'consider the fixture' },
      { type: 'text', text: '## rendered answer' },
    ] },
  })),
  entry(event('user/message', 3, {
    content: [{ type: 'text', text: 'runtime context' }],
    source: { kind: 'plugin', plugin: 'fixture' },
  })),
  entry(event('tool/call', 4, {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read',
    arguments: '{"path":"fixture.ts"}',
  })),
  entry(event('tool/result', 5, {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call-1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'fixture result' }],
      }],
    },
  })),
]

function fakeContext(): Context {
  const sessionsSnapshot = {
    current: 'parent',
    byId: {
      child: {
        sessionId: 'child',
        parentSessionId: 'parent',
        displayTitle: 'Side: Fixture',
        running: false,
      },
    },
  }
  return {
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => sessionsSnapshot,
      },
    },
    connection: {
      api: {
        sessions: {
          history: async () => ({ result: { ok: true, value: { events: transcript } } }),
        },
      },
    },
    get: () => undefined,
  } as unknown as Context
}

const tab = {
  id: 'sidechat:fixture',
  type: 'sidechat',
  title: 'Fixture',
  meta: { threadId: 'child' },
} as SidebarTab

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('Side Chat conversation presentation', () => {
  it('uses literal user text and shared conversation-density assistant Markdown', async () => {
    vi.spyOn(api, 'sidechatInfo').mockResolvedValue({
      live: true,
      preset: 'fixture',
      provider: 'fixture',
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SideChatView ctx={fakeContext()} scope={{ sessionId: 'parent', cwd: '/fixture' }} tab={tab} visible />)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-primitive="message-text"]')?.textContent)
      .toBe('# literal **markdown**')
    const assistant = container.querySelector('[data-primitive="markdown-text"]')
    expect(assistant?.textContent).toBe('## rendered answer')
    expect(assistant?.getAttribute('data-density')).toBe('conversation')
  })

  it('uses shared disclosures and conversation-density code surfaces for context and tools', async () => {
    vi.spyOn(api, 'sidechatInfo').mockResolvedValue({
      live: true,
      preset: 'fixture',
      provider: 'fixture',
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SideChatView ctx={fakeContext()} scope={{ sessionId: 'parent', cwd: '/fixture' }} tab={tab} visible />)
      await Promise.resolve()
    })

    const disclosures = [...container.querySelectorAll('[data-primitive="disclosure-row"]')]
    expect(disclosures.map(row => row.getAttribute('data-title'))).toEqual(['Thinking', 'Context injected', 'read'])

    await act(async () => {
      for (const button of container!.querySelectorAll<HTMLButtonElement>('[data-primitive="disclosure-row"] button')) {
        button.click()
      }
    })

    const codeBlocks = [...container.querySelectorAll('[data-primitive="code-block"]')]
    expect(codeBlocks.map(block => block.textContent)).toEqual([
      'runtime context',
      '{"path":"fixture.ts"}',
      'fixture result',
    ])
    expect(codeBlocks.every(block => block.getAttribute('data-density') === 'conversation')).toBe(true)
  })
})
