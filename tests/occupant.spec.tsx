// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { apply } from '../src/client/index.tsx'
import { api } from '../src/client/api.ts'
import { createRightSidebarOwnerSource, Occupant } from '../src/client/Occupant.tsx'
import { BottomPanelLayoutAction, RightSidebarLayoutAction } from '../src/client/LayoutActions.tsx'
import { OverlaySurface } from '../src/client/OverlaySurface.tsx'
import { createSidebarStore, toggleBottomPanel } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
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

function bindSnapshotSelector<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }) {
  return <S,>(selector: (snapshot: T) => S): S => useSyncExternalStore(
    source.subscribe.bind(source),
    () => selector(source.getSnapshot()),
  )
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

  it('keeps the host layout action available without a session and follows the real owner state', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const owner = createRightSidebarOwnerSource()
    const toggleRightSidebar = vi.fn()

    act(() => {
      root.render(createElement(RightSidebarLayoutAction, {
        useRightSidebarOwner: bindSnapshotSelector(owner),
        toggleRightSidebar,
      }))
    })
    expect(container.querySelectorAll('button')).toHaveLength(1)
    const rightToggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('expand')}"]`)
    expect(rightToggle).not.toBeNull()
    expect(rightToggle?.getAttribute('aria-expanded')).toBe('false')
    act(() => { rightToggle?.click() })
    expect(toggleRightSidebar).toHaveBeenCalledOnce()

    act(() => { owner.publish({ collapsed: false, width: 360 }) })
    const collapse = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('collapse')}"]`)
    expect(collapse).not.toBeNull()
    expect(collapse?.getAttribute('aria-expanded')).toBe('true')

    act(() => { root.unmount() })
    container.remove()
  })

  it('shows the bottom action only for an enabled desktop workbench in an expanded column', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), bottomPanelEnabled: true })
    store.setSession('s1')
    const layout = snapshotSource<SidebarLayoutSnapshot>({
      mode: 'desktop', mobileSurface: null, detailsAvailable: false, rightSidebarAvailable: true,
    })
    const owner = snapshotSource({ collapsed: false, width: 360 })
    const render = () => createElement(BottomPanelLayoutAction, {
      useLayout: bindSnapshotSelector(layout),
      useRightSidebarOwner: bindSnapshotSelector(owner),
      useSidebar: bindSnapshotSelector(store),
      toggleBottomPanel: () => { store.reduce(toggleBottomPanel) },
    })

    act(() => {
      root.render(render())
    })
    const expand = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('expandBottomPanel')}"]`)
    expect(expand).not.toBeNull()
    expect(expand?.getAttribute('aria-expanded')).toBe('false')
    act(() => { expand?.click() })
    expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    expect(container.querySelector(`button[aria-label="${t('collapseBottomPanel')}"]`)).not.toBeNull()

    act(() => { owner.publish({ collapsed: true, width: 0 }) })
    expect(container.querySelector('button')).toBeNull()
    act(() => {
      owner.publish({ collapsed: false, width: 360 })
      layout.publish({ ...layout.getSnapshot(), mode: 'mobile', mobileSurface: 'right-sidebar' })
    })
    expect(container.querySelector('button')).toBeNull()
    act(() => {
      layout.publish({ ...layout.getSnapshot(), mode: 'desktop', mobileSurface: null })
      store.setPrefs({ ...store.getPrefs(), bottomPanelEnabled: false })
    })
    expect(container.querySelector('button')).toBeNull()

    act(() => { root.unmount() })
    container.remove()
  })

  it('keeps shell.overlay dedicated to free windows with no legacy toggle cluster', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    const store = createSidebarStore()
    const sessions = snapshotSource({ current: undefined, byId: {} })
    const locale = snapshotSource({ active: 'en' })
    const ctx = {
      locale,
      sessions: { list: sessions },
      get: () => undefined,
    }
    act(() => {
      root.render(createElement(OverlaySurface, {
        ctx: ctx as never,
        store,
        revealDockedSurface: () => {},
      }))
    })
    expect(container.querySelector('[data-dsh-better-sidebar-overlay]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-better-sidebar-toggles]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
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

    const registrations: Array<{
      name: string
      id?: string
      order?: number
      inject?: () => unknown
      component: unknown
    }> = []
    const declared = new Set<string>()
    const injections = new Map<string, Set<{ callback: () => () => void; dispose?: () => void }>>()
    const declare = (name: string): void => {
      declared.add(name)
      for (const injection of injections.get(name) ?? []) {
        injection.dispose ??= injection.callback()
      }
    }
    const collapse = (name: string): void => {
      declared.delete(name)
      for (const injection of injections.get(name) ?? []) {
        injection.dispose?.()
        injection.dispose = undefined
      }
    }
    let remoteListener: (() => void) | undefined
    const applyLocaleSnapshot = { active: 'en' }
    const applySessionsSnapshot = { current: undefined, byId: {} }
    const toggleRightSidebar = vi.fn()
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
        toggleRightSidebar,
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
        register: (options: { name: string; id?: string; order?: number; inject?: () => unknown }, component: unknown) => {
          const row = { ...options, component }
          registrations.push(row)
          return () => {
            const index = registrations.indexOf(row)
            if (index >= 0) registrations.splice(index, 1)
          }
        },
        inject: (key: string, callback: () => () => void) => {
          const injection: { callback: () => () => void; dispose?: () => void } = { callback }
          const rows = injections.get(key) ?? new Set()
          rows.add(injection)
          injections.set(key, rows)
          if (declared.has(key)) injection.dispose = callback()
          return () => {
            injection.dispose?.()
            rows.delete(injection)
            if (rows.size === 0) injections.delete(key)
          }
        },
      },
    }

    apply(ctx as never)
    await vi.waitFor(() => {
      expect(injections.has('right-sidebar')).toBe(true)
      expect(injections.has('shell.overlay')).toBe(true)
      expect(injections.has('conversation.layout.actions')).toBe(true)
    })
    expect(registrations).toEqual([])

    declare('right-sidebar')
    declare('shell.overlay')
    declare('conversation.layout.actions')
    await vi.waitFor(() => {
      expect(registrations.some(row => row.name === 'right-sidebar')).toBe(true)
      expect(registrations.some(row => row.name === 'shell.overlay')).toBe(true)
      expect(registrations.filter(row => row.name === 'conversation.layout.actions')).toHaveLength(2)
    })
    expect(registrations.filter(row => row.name === 'conversation.layout.actions').map(row => [row.id, row.order]))
      .toEqual([
        ['better-sidebar:bottom-toggle', 90],
        ['better-sidebar:right-toggle', 100],
      ])
    const rightAction = registrations.find(row => row.id === 'better-sidebar:right-toggle')
    const rightInjected = rightAction?.inject?.() as { toggleRightSidebar: () => void }
    rightInjected.toggleRightSidebar()
    expect(toggleRightSidebar).toHaveBeenCalledOnce()
    expect(document.querySelector('body > [data-dsh-better-sidebar]')).toBeNull()

    collapse('right-sidebar')
    expect(registrations.some(row => row.name === 'right-sidebar')).toBe(false)
    expect(registrations.some(row => row.name === 'shell.overlay')).toBe(true)
    expect(registrations.filter(row => row.name === 'conversation.layout.actions')).toHaveLength(2)
    declare('right-sidebar')
    expect(registrations.filter(row => row.name === 'right-sidebar')).toHaveLength(1)

    collapse('shell.overlay')
    expect(registrations.some(row => row.name === 'shell.overlay')).toBe(false)
    expect(registrations.some(row => row.name === 'right-sidebar')).toBe(true)
    expect(registrations.filter(row => row.name === 'conversation.layout.actions')).toHaveLength(2)
    declare('shell.overlay')
    expect(registrations.filter(row => row.name === 'shell.overlay')).toHaveLength(1)

    collapse('conversation.layout.actions')
    expect(registrations.some(row => row.name === 'conversation.layout.actions')).toBe(false)
    declare('conversation.layout.actions')
    expect(registrations.filter(row => row.name === 'conversation.layout.actions')).toHaveLength(2)

    externalDisable = true
    remoteListener?.()
    await vi.waitFor(() => {
      expect(registrations.some(row => row.name === 'right-sidebar')).toBe(false)
      expect(registrations.some(row => row.name === 'shell.overlay')).toBe(false)
      expect(registrations.some(row => row.name === 'conversation.layout.actions')).toBe(false)
    })
    expect(injections.has('right-sidebar')).toBe(false)
    expect(injections.has('shell.overlay')).toBe(false)
    expect(injections.has('conversation.layout.actions')).toBe(false)
    collapse('conversation.layout.actions')
    declare('conversation.layout.actions')
    expect(registrations.some(row => row.name === 'conversation.layout.actions')).toBe(false)

    externalDisable = false
    remoteListener?.()
    await vi.waitFor(() => {
      expect(registrations.filter(row => row.name === 'right-sidebar')).toHaveLength(1)
      expect(registrations.filter(row => row.name === 'shell.overlay')).toHaveLength(1)
      expect(registrations.filter(row => row.name === 'conversation.layout.actions')).toHaveLength(2)
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
