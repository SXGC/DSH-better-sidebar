import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client sidebar api', () => {
  it('posts agent detail requests with only the root scope and selected agent id', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            sessionId: 'child',
            initialTask: { available: false, reason: 'not-accepted' },
            backend: 'subagent-next',
            forkTurns: 'none',
            requestedModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
            effectiveModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
            allowedTools: [],
            sandboxMode: null,
            approvalPolicy: null,
            filesystemPolicy: 'closed',
          },
        }),
      } as unknown as Response
    })

    await api.agentDetail({ sessionId: 'root', cwd: '/workspace' }, 'child')

    expect(calls).toEqual([{ sessionId: 'root', cwd: '/workspace', agentSessionId: 'child' }])
  })

  it('returns only the whitelisted agent detail fields to the view layer', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionId: 'child',
          initialTask: { available: true, text: 'inspect task', requestHash: 'hidden' },
          backend: 'subagent-next',
          forkTurns: 'all',
          requestedModelSelection: {
            provider: 'deepseek',
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            credentialRef: 'secret/model-key',
          },
          effectiveModelSelection: { provider: 'deepseek', model: 'gpt-5.5', operationId: 'op-secret' },
          allowedTools: ['bash'],
          sandboxMode: 'workspace-write',
          approvalPolicy: 'never',
          filesystemPolicy: 'closed',
          credentialRef: 'secret/model-key',
          requestHash: 'a'.repeat(64),
          operationId: 'op-secret',
          events: [{ type: 'raw', data: 'do-not-store' }],
        },
      }),
    }) as unknown as Response)

    const detail = await api.agentDetail({ sessionId: 'root' }, 'child')
    const serialized = JSON.stringify(detail)

    expect(detail).toEqual({
      sessionId: 'child',
      initialTask: { available: true, text: 'inspect task' },
      backend: 'subagent-next',
      forkTurns: 'all',
      requestedModelSelection: { provider: 'deepseek', model: 'gpt-5.5', reasoningEffort: 'high' },
      effectiveModelSelection: { provider: 'deepseek', model: 'gpt-5.5' },
      allowedTools: ['bash'],
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      filesystemPolicy: 'closed',
    })
    expect(serialized).not.toContain('credentialRef')
    expect(serialized).not.toContain('requestHash')
    expect(serialized).not.toContain('operationId')
    expect(serialized).not.toContain('raw')
  })
})
