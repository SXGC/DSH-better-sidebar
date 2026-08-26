import { useCallback, useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarLayoutSnapshot, SidebarLocaleService } from '../context-types.ts'
import { toggleBottomPanel, type SidebarStore } from './state.ts'
import { IconPanelBottomOutline16, IconPanelRightOutline16 } from './icons.tsx'
import type { RightSidebarOwnerProps, SnapshotSource } from './Occupant.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface ToggleClusterProps {
  store: SidebarStore
  layoutSnapshot: SnapshotSource<SidebarLayoutSnapshot>
  ownerSnapshot: SnapshotSource<RightSidebarOwnerProps>
  localeSnapshot: Pick<SidebarLocaleService, 'getSnapshot' | 'subscribe'>
  toggleRightSidebar: () => void
}

/**
 * Desktop trailing clearance: the official Session header owns the trailing
 * 60px of the conversation column (28px padding + the 32px More trigger), so
 * the cluster stays one 8px gap further left instead of covering it. Mobile
 * keeps the bare offset — the mobile header already reserves the trailing
 * 56px for shell controls.
 */
const DESKTOP_TRAILING_CLEARANCE = 68

/** Context-free controls contributed to the official click-through shell overlay. */
export function ToggleCluster(props: ToggleClusterProps) {
  const { store, layoutSnapshot, ownerSnapshot, localeSnapshot, toggleRightSidebar } = props
  const layout = useSyncExternalStore(
    useCallback(listener => layoutSnapshot.subscribe(listener), [layoutSnapshot]),
    useCallback(() => layoutSnapshot.getSnapshot(), [layoutSnapshot]),
  )
  const owner = useSyncExternalStore(
    useCallback(listener => ownerSnapshot.subscribe(listener), [ownerSnapshot]),
    useCallback(() => ownerSnapshot.getSnapshot(), [ownerSnapshot]),
  )
  const sidebar = useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useSyncExternalStore(
    useCallback(listener => localeSnapshot.subscribe(listener), [localeSnapshot]),
    useCallback(() => localeSnapshot.getSnapshot(), [localeSnapshot]),
  )

  return (
    <div
      className={css.toggleCluster}
      data-dsh-better-sidebar-toggles=""
      style={{
        right: layout.mode === 'desktop'
          ? DESKTOP_TRAILING_CLEARANCE + (owner.collapsed ? 0 : owner.width)
          : 10,
      }}
    >
      {layout.mode === 'desktop' && !owner.collapsed && (
        <Tooltip label={sidebar.state?.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.toggleButton}
            aria-label={sidebar.state?.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
            disabled={sidebar.state === undefined}
            onClick={() => { store.reduce(toggleBottomPanel) }}
          >
            <IconPanelBottomOutline16 />
          </button>
        </Tooltip>
      )}
      <Tooltip label={owner.collapsed ? t('expand') : t('collapse')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.toggleButton}
          aria-label={owner.collapsed ? t('expand') : t('collapse')}
          onClick={toggleRightSidebar}
        >
          <IconPanelRightOutline16 />
        </button>
      </Tooltip>
    </div>
  )
}
