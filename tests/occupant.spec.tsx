// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { apply } from '../src/client/index.tsx'
import { api } from '../src/client/api.ts'
import { createRightSidebarOwnerSource, Occupant } from '../src/client/Occupant.tsx'
import { ToggleCluster } from '../src/client/ToggleCluster.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { SidebarLayoutSnapshot } from '../src/context-types.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: Array<() => void> = []

function snapshotSource<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (next: T) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('official right-sidebar occupant', () => {
  it('keeps one occupant root mounted while owner collapse only pauses its contents', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const renderWorkbench = () => createElement('input', { defaultValue: 'kept' })
    const publishOwner = vi.fn()

    act(() => {
      root.render(createElement(Occupant, {
        collapsed: false,
        width: 360,
        renderWorkbench,
        publishOwner,
      }))
    })
    const occupant = container.querySelector('[data-dsh-better-sidebar]')
    expect(occupant).not.toBeNull()
    expect(occupant?.hasAttribute('data-collapsed')).toBe(false)
    expect(publishOwner).toHaveBeenLastCalledWith({ collapsed: false, width: 360 })

    act(() => {
      root.render(createElement(Occupant, {
        collapsed: true,
        width: 0,
        renderWorkbench,
        publishOwner,
      }))
    })
    expect(container.querySelector('[data-dsh-better-sidebar]')).toBe(occupant)
    expect(occupant?.hasAttribute('data-collapsed')).toBe(true)
    expect(publishOwner).toHaveBeenLastCalledWith({ collapsed: true, width: 0 })
    expect(document.body.hasAttribute('data-dsh-sidebar-collapsed')).toBe(false)
    expect(document.body.hasAttribute('data-dsh-sidebar-dragging')).toBe(false)

    act(() => { root.unmount() })
    container.remove()
  })

  it('keeps the official right toggle available and gates the bottom toggle on an open desktop column', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const store = createSidebarStore()
    store.setSession('s1')
    const layout = snapshotSource<SidebarLayoutSnapshot>({
      mode: 'desktop',
      mobileSurface: null,
      detailsAvailable: false,
      rightSidebarAvailable: true,
    })
    const owner = createRightSidebarOwnerSource()
    const toggleRightSidebar = vi.fn()
    const locale = snapshotSource({ active: 'en' })

    act(() => {
      root.render(createElement(ToggleCluster, {
        store,
        layoutSnapshot: layout,
        ownerSnapshot: owner,
        localeSnapshot: locale,
        toggleRightSidebar,
      }))
    })
    expect(container.querySelectorAll('button')).toHaveLength(1)
    const cluster = container.querySelector<HTMLElement>('[data-dsh-better-sidebar-toggles]')
    expect(cluster?.style.right).toBe('10px')
    const rightToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]')
    expect(rightToggle).not.toBeNull()
    act(() => { rightToggle?.click() })
    expect(toggleRightSidebar).toHaveBeenCalledOnce()

    act(() => { owner.publish({ collapsed: false, width: 360 }) })
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(cluster?.style.right).toBe('370px')
    const bottomToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Expand bottom panel"]')
    expect(bottomToggle).not.toBeNull()
    act(() => { bottomToggle?.click() })
    expect(store.getSnapshot().state?.bottomOpen).toBe(true)

    act(() => {
      layout.publish({ ...layout.getSnapshot(), mode: 'mobile', mobileSurface: 'right-sidebar' })
    })
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull()

    act(() => { owner.publish({ collapsed: true, width: 0 }) })
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull()

    act(() => { root.unmount() })
    container.remove()
  })

  it('registers through the declared slot and disposes the occupant when externally disabled', async () => {
    let externalDisable = false
    vi.spyOn(api, 'shellGet').mockResolvedValue({ shell: '/bin/sh', name: 'sh' })
    vi.spyOn(api, 'settingsGet').mockImplementation(async () => ({
      value: undefined,
      revision: undefined,
      externalDisable,
    }))

    const registrations: Array<{ name: string; component: unknown }> = []
    let remoteListener: (() => void) | undefined
    const applyLocaleSnapshot = { active: 'en' }
    const applySessionsSnapshot = { current: undefined, byId: {} }
    const ctx = {
      locale: {
        register: () => () => {},
        subscribe: () => () => {},
        getSnapshot: () => applyLocaleSnapshot,
      },
      sessions: {
        list: { subscribe: () => () => {}, getSnapshot: () => applySessionsSnapshot },
      },
      connection: {},
      workspaces: {},
      layout: {
        snapshot: { subscribe: () => () => {}, getSnapshot: () => ({ mode: 'desktop' }) },
        openRightSidebar: () => {},
        closeRightSidebar: () => {},
        toggleRightSidebar: () => {},
      },
      provide: () => {},
      effect: (callback: () => void | (() => void)) => {
        const cleanup = callback()
        if (cleanup !== undefined) cleanups.push(cleanup)
      },
      get: (name: string) => name === 'remote'
        ? { $on: (_event: string, listener: () => void) => { remoteListener = listener; return () => {} } }
        : undefined,
      slots: {
        register: (options: { name: string }, component: unknown) => {
          const row = { name: options.name, component }
          registrations.push(row)
          return () => {
            const index = registrations.indexOf(row)
            if (index >= 0) registrations.splice(index, 1)
          }
        },
        inject: (_key: string, callback: () => () => void) => {
          const dispose = callback()
          return () => { dispose() }
        },
      },
    }

    apply(ctx as never)
    await vi.waitFor(() => {
      expect(registrations.some(row => row.name === 'right-sidebar')).toBe(true)
      expect(registrations.some(row => row.name === 'shell.overlay')).toBe(true)
    })
    expect(document.querySelector('body > [data-dsh-better-sidebar]')).toBeNull()

    externalDisable = true
    remoteListener?.()
    await vi.waitFor(() => {
      expect(registrations.some(row => row.name === 'right-sidebar')).toBe(false)
      expect(registrations.some(row => row.name === 'shell.overlay')).toBe(false)
    })
  })

  it('fails loudly without layout and never falls back to a body portal', () => {
    const register = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    apply({ slots: { register } } as never)

    expect(register).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      '[dsh-better-sidebar] layout error:',
      expect.objectContaining({ message: expect.stringContaining('required layout service') }),
    )
    expect(document.body.textContent).toContain('required layout service is unavailable')
    expect(document.querySelector('body > [data-dsh-better-sidebar]')).toBeNull()
  })
})
