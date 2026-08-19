import type { ReactNode } from 'react'
import css from './sidebar.module.css'

export interface RightSidebarOwnerProps {
  collapsed: boolean
  width: number
}

export interface OccupantProps extends RightSidebarOwnerProps {
  renderWorkbench: (owner: RightSidebarOwnerProps) => ReactNode
}

/** Stable, context-free adapter between the official layout slot and the workbench. */
export function Occupant({ collapsed, width, renderWorkbench }: OccupantProps) {
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
