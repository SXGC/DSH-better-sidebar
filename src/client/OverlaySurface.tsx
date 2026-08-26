import type { Context } from '../context-types.ts'
import { FloatingLayer } from './Sidebar.tsx'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

export interface OverlaySurfaceProps {
  ctx: Context
  store: SidebarStore
  revealDockedSurface: () => void
}

/** Free windows stay independent from the collapsible right-sidebar occupant. */
export function OverlaySurface(props: OverlaySurfaceProps) {
  return (
    <div className={css.overlaySurface} data-dsh-better-sidebar-overlay="">
      <FloatingLayer
        ctx={props.ctx}
        store={props.store}
        revealDockedSurface={props.revealDockedSurface}
      />
    </div>
  )
}
