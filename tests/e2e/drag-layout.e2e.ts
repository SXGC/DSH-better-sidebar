/**
 * Official-layout drag lane. The plugin contributes content to the declared
 * `right-sidebar` track; AppFrame alone owns the resize handle and the
 * width clamp. A real pointer drag proves that the conversation
 * track follows that handle while the plugin leaves `#root` geometry alone.
 *
 * The server is booted by scripts/e2e-mount.sh; this spec only loads the page
 * and uses a separate workspace so it never races the mount lane's seed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** This lane's own workspace (distinct from mount.e2e.ts's, lanes run serially
 *  but against the same server — never share seed paths). */
const WORKSPACE_PATH = process.env.DSH_E2E_DRAG_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-drag-workspace')

let api: APIRequestContext

/** Seed one workspace + one session through the host's unary RPC surface. */
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
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Dismiss whatever onboarding takeover is present (same dance as the mount
  // lane), so the pointer can reach the strip without a masking overlay.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-drag] no onboarding takeover appeared; proceeding')
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
        // Masked by a takeover stacked above; retry in the next round.
      }
    }
    if (!dismissed) break
  }

  // openByDefault defaults OFF. The shell-overlay contribution remains
  // reachable while the fourth track is zero.
  const toggles = page.locator('[data-shell-overlay] [data-dsh-better-sidebar-toggles]')
  const expandButton = toggles.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'shell.overlay must offer the collapsed right-sidebar toggle').toHaveCount(1)
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
  // The official grid and its handle animate independently while opening.
  // Sample the baseline only after both have converged on the same seam.
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return Math.abs(geometry.handleX - geometry.conversationRight)
  }, { timeout: 30_000 }).toBeLessThanOrEqual(2)
  const initial = await readGeometry()
  expect(initial.sidebarWidth).toBeLessThan(initial.viewportWidth)
  expect(initial.rootMarginRight).toBe('0px')

  // Drag the official handle left far enough to hit its maximum. AppFrame
  // clamps the fourth track; the conversation edge and handle move together.
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

  // Drag the same AppFrame handle right through the minimum. No plugin-local
  // col-resize strip participates in this lane.
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
