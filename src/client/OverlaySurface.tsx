import type { Context, SidebarLayoutSnapshot, SidebarLocaleService } from '../context-types.ts'
import type { SnapshotSource, RightSidebarOwnerProps } from './Occupant.tsx'
import { FloatingLayer } from './Sidebar.tsx'
import { ToggleCluster } from './ToggleCluster.tsx'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

export interface OverlaySurfaceProps {
  ctx: Context
  store: SidebarStore
  layoutSnapshot: SnapshotSource<SidebarLayoutSnapshot>
  ownerSnapshot: SnapshotSource<RightSidebarOwnerProps>
  localeSnapshot: Pick<SidebarLocaleService, 'getSnapshot' | 'subscribe'>
  toggleRightSidebar: () => void
  revealDockedSurface: () => void
}

/** One shell.overlay contribution containing all plugin-owned frame chrome. */
export function OverlaySurface(props: OverlaySurfaceProps) {
  return (
    <div className={css.overlaySurface} data-dsh-better-sidebar-overlay="">
      <ToggleCluster
        store={props.store}
        layoutSnapshot={props.layoutSnapshot}
        ownerSnapshot={props.ownerSnapshot}
        localeSnapshot={props.localeSnapshot}
        toggleRightSidebar={props.toggleRightSidebar}
      />
      <FloatingLayer
        ctx={props.ctx}
        store={props.store}
        revealDockedSurface={props.revealDockedSurface}
      />
    </div>
  )
}
