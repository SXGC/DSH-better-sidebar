import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarLayoutSnapshot } from '../context-types.ts'
import type { SnapshotSource, RightSidebarOwnerProps } from './Occupant.tsx'
import type { SidebarSnapshot } from './state.ts'
import { IconPanelBottomOutline16, IconPanelRightOutline16 } from './icons.tsx'
import { t } from './locales.ts'

export interface RightSidebarLayoutActionInjected {
  hooks: { rightSidebarOwner: SnapshotSource<RightSidebarOwnerProps> }
  toggleRightSidebar: () => void
}

export interface BottomPanelLayoutActionInjected {
  hooks: {
    layout: SnapshotSource<SidebarLayoutSnapshot>
    rightSidebarOwner: SnapshotSource<RightSidebarOwnerProps>
    sidebar: SnapshotSource<SidebarSnapshot>
  }
  toggleBottomPanel: () => void
}

type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S) => S

export type RightSidebarLayoutActionProps = {
  useRightSidebarOwner: SnapshotSelectorHook<RightSidebarOwnerProps>
  toggleRightSidebar: () => void
}

export type BottomPanelLayoutActionProps = {
  useLayout: SnapshotSelectorHook<SidebarLayoutSnapshot>
  useRightSidebarOwner: SnapshotSelectorHook<RightSidebarOwnerProps>
  useSidebar: SnapshotSelectorHook<SidebarSnapshot>
  toggleBottomPanel: () => void
}

export function RightSidebarLayoutAction(props: RightSidebarLayoutActionProps) {
  const owner = props.useRightSidebarOwner(snapshot => snapshot)
  const label = owner.collapsed ? t('expand') : t('collapse')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon={<IconPanelRightOutline16 />}
        aria-label={label}
        aria-expanded={!owner.collapsed}
        onClick={props.toggleRightSidebar}
      />
    </Tooltip>
  )
}

export function BottomPanelLayoutAction(props: BottomPanelLayoutActionProps) {
  const layout = props.useLayout(snapshot => snapshot)
  const owner = props.useRightSidebarOwner(snapshot => snapshot)
  const sidebar = props.useSidebar(snapshot => snapshot)
  if (
    !sidebar.prefs.bottomPanelEnabled
    || layout.mode !== 'desktop'
    || owner.collapsed
    || sidebar.state === undefined
  ) return null
  const label = sidebar.state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon={<IconPanelBottomOutline16 />}
        aria-label={label}
        aria-expanded={sidebar.state.bottomOpen}
        onClick={props.toggleBottomPanel}
      />
    </Tooltip>
  )
}
