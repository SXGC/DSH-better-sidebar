import { useEffect, type ReactNode } from 'react'
import css from './sidebar.module.css'

export interface SnapshotSource<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

export interface RightSidebarOwnerProps {
  collapsed: boolean
  width: number
}

export interface OccupantProps extends RightSidebarOwnerProps {
  renderWorkbench: (owner: RightSidebarOwnerProps) => ReactNode
  publishOwner: (owner: RightSidebarOwnerProps) => void
}

/** Stable, context-free adapter between the official layout slot and the workbench. */
export function Occupant({ collapsed, width, renderWorkbench, publishOwner }: OccupantProps) {
  useEffect(() => { publishOwner({ collapsed, width }) }, [collapsed, width, publishOwner])
  return (
    <div
      className={css.occupant}
      data-dsh-better-sidebar=""
      data-collapsed={collapsed || undefined}
      data-owner-width={width}
      aria-hidden={collapsed || undefined}
    >
      {renderWorkbench({ collapsed, width })}
    </div>
  )
}

/** Tiny activation-local observable bridging owner props into shell.overlay controls. */
export function createRightSidebarOwnerSource(
  onPublish?: (owner: RightSidebarOwnerProps) => void,
): SnapshotSource<RightSidebarOwnerProps> & {
  publish: (owner: RightSidebarOwnerProps) => void
} {
  let snapshot: RightSidebarOwnerProps = { collapsed: true, width: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (owner) => {
      if (owner.collapsed !== snapshot.collapsed || owner.width !== snapshot.width) {
        snapshot = owner
        for (const listener of listeners) listener()
      }
      onPublish?.(owner)
    },
  }
}
