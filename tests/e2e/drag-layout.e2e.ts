/**
 * Official-layout lane. DSH owns the right-sidebar track, resize handle and
 * outer geometry; better-sidebar contributes docked content plus a sibling
 * shell.overlay surface for toggles and free windows.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

const WORKSPACE_PATH = process.env.DSH_E2E_DRAG_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-drag-workspace')

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'drag lane\n')
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'e2e-drag-workspace', method: 'workspace.create', payload: { path: WORKSPACE_PATH } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId
  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'e2e-drag-session', method: 'session.create', payload: { workspaceId } },
  })
  expect(session.ok(), `session.create: ${session.status()} ${await session.text()}`).toBe(true)
}

async function dismissTakeovers(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    return
  }
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // A higher takeover can mask this one; retry the stack next round.
      }
    }
    if (!dismissed) break
  }
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

interface LayoutGeometry {
  handleX: number
  conversationRight: number
  sidebarWidth: number
  viewportWidth: number
  rootMarginRight: string
}

test('official right-sidebar handle owns the clamped track and conversation geometry', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-layout-region="right-sidebar"] [data-dsh-better-sidebar]')
  const overlay = page.locator('[data-shell-overlay] [data-dsh-better-sidebar-overlay]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await expect(overlay).toHaveCount(1)
  await dismissTakeovers(page)

  const expandButton = page.locator('[data-layout-actions]').getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'the Host layout-action seat must offer the collapsed right-sidebar action').toHaveCount(1)
  await expandButton.click()
  const handle = page.locator('[data-side="right-sidebar"]')
  const conversation = page.locator('[data-layout-region="conversation"]')
  const rightRegion = page.locator('[data-layout-region="right-sidebar"]')
  await expect(handle, 'AppFrame must expose its right-sidebar resize handle').toHaveCount(1)

  const readGeometry = async (): Promise<LayoutGeometry> => page.evaluate(() => {
    const handleElement = document.querySelector<HTMLElement>('[data-side="right-sidebar"]')
    const conversationElement = document.querySelector<HTMLElement>('[data-layout-region="conversation"]')
    const sidebarElement = document.querySelector<HTMLElement>('[data-layout-region="right-sidebar"]')
    const root = document.querySelector<HTMLElement>('#root')
    if (handleElement === null || conversationElement === null || sidebarElement === null || root === null) {
      throw new Error('official layout geometry is incomplete')
    }
    const handleRect = handleElement.getBoundingClientRect()
    return {
      handleX: handleRect.x + handleRect.width / 2,
      conversationRight: conversationElement.getBoundingClientRect().right,
      sidebarWidth: sidebarElement.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
      rootMarginRight: getComputedStyle(root).marginRight,
    }
  })

  await expect.poll(
    () => rightRegion.evaluate(element => element.getBoundingClientRect().width),
    { timeout: 30_000 },
  ).toBeGreaterThan(0)
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return Math.abs(geometry.handleX - geometry.conversationRight)
  }, { timeout: 30_000 }).toBeLessThanOrEqual(2)
  const initial = await readGeometry()
  expect(initial.sidebarWidth).toBeLessThan(initial.viewportWidth)
  expect(initial.rootMarginRight).toBe('0px')

  const initialHandle = await handle.boundingBox()
  expect(initialHandle).not.toBeNull()
  const dragY = initialHandle!.y + Math.min(120, initialHandle!.height / 2)
  await page.mouse.move(initialHandle!.x + initialHandle!.width / 2, dragY)
  await page.mouse.down()
  await page.mouse.move(initialHandle!.x - 300, dragY, { steps: 12 })
  await page.mouse.up()
  await expect.poll(
    () => rightRegion.evaluate(element => element.getBoundingClientRect().width),
  ).toBeGreaterThan(initial.sidebarWidth + 20)
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return Math.abs(geometry.handleX - geometry.conversationRight)
  }, { timeout: 30_000 }).toBeLessThanOrEqual(2)
  const wide = await readGeometry()
  expect(wide.sidebarWidth).toBeGreaterThan(initial.sidebarWidth)
  expect(wide.sidebarWidth).toBeLessThan(wide.viewportWidth)
  expect(Math.abs((initial.handleX - wide.handleX) - (initial.conversationRight - wide.conversationRight))).toBeLessThanOrEqual(2)
  expect(wide.rootMarginRight).toBe('0px')

  const wideHandle = await handle.boundingBox()
  expect(wideHandle).not.toBeNull()
  const wideDragY = wideHandle!.y + Math.min(120, wideHandle!.height / 2)
  await page.mouse.move(wideHandle!.x + wideHandle!.width / 2, wideDragY)
  await page.mouse.down()
  await page.mouse.move(wideHandle!.x + 500, wideDragY, { steps: 12 })
  await page.mouse.up()
  await expect.poll(
    () => rightRegion.evaluate(element => element.getBoundingClientRect().width),
  ).toBeLessThan(wide.sidebarWidth - 20)
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return Math.abs(geometry.handleX - geometry.conversationRight)
  }, { timeout: 30_000 }).toBeLessThanOrEqual(2)
  const narrow = await readGeometry()
  expect(narrow.sidebarWidth).toBeGreaterThan(0)
  expect(narrow.sidebarWidth).toBeLessThan(wide.sidebarWidth)
  expect(Math.abs((narrow.handleX - wide.handleX) - (narrow.conversationRight - wide.conversationRight))).toBeLessThanOrEqual(2)
  expect(narrow.rootMarginRight).toBe('0px')
  await expect(conversation).toBeVisible()
})

test('a free window survives official collapse and docking it reveals the right sidebar', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-layout-region="right-sidebar"] [data-dsh-better-sidebar]')
  const overlay = page.locator('[data-shell-overlay] [data-dsh-better-sidebar-overlay]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await expect(overlay).toHaveCount(1)
  await dismissTakeovers(page)

  const layoutActions = page.locator('[data-layout-actions]')
  const expandButton = layoutActions.getByRole('button', { name: 'Expand sidebar' })
  if ((await expandButton.count()) === 1) await expandButton.click()
  await expect(page.locator('[data-side="right-sidebar"]')).toHaveCount(1)

  const filesTab = sidebar.locator('[title="Files"][draggable="true"]').first()
  await expect(filesTab).toHaveCount(1)
  await filesTab.click({ button: 'right' })
  const floatItem = page.getByRole('menuitem', { name: 'Move to Free Window' }).first()
  await expect(floatItem).toHaveCount(1)
  await floatItem.click()
  const floatWindow = overlay.locator('[data-dsh-float-window]')
  await expect(floatWindow, 'free windows belong to shell.overlay, outside the occupant').toBeVisible({ timeout: 10_000 })
  await expect(sidebar.locator('[data-dsh-float-window]')).toHaveCount(0)
  const before = await floatWindow.boundingBox()
  expect(before).not.toBeNull()

  const collapseButton = layoutActions.getByRole('button', { name: 'Collapse sidebar' })
  await expect(collapseButton).toHaveCount(1)
  await collapseButton.click()
  await expect(page.locator('[data-side="right-sidebar"]')).toHaveCount(0)
  await expect(floatWindow, 'collapsing the official track must not hide or unmount a free window').toBeVisible()

  const header = floatWindow.locator('[class*="floatHeader"]')
  const headerBox = await header.boundingBox()
  expect(headerBox).not.toBeNull()
  await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(headerBox!.x - 80, headerBox!.y + 60, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await floatWindow.boundingBox())?.x ?? before!.x).not.toBe(before!.x)

  await header.click({ button: 'right' })
  const dockItem = page.getByRole('menuitem', { name: 'Dock Back to Sidebar' }).first()
  await expect(dockItem).toHaveCount(1)
  await dockItem.click()
  await expect(floatWindow).toHaveCount(0)
  await expect(page.locator('[data-side="right-sidebar"]'), 'docking is an explicit reveal intent').toHaveCount(1)
  await expect(sidebar.locator('[title="Files"][draggable="true"]').first()).toBeVisible()
  expect(await page.locator('#root').evaluate(element => getComputedStyle(element).marginRight)).toBe('0px')
})
