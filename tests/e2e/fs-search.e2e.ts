/**
 * fs-search end-to-end lane: mount the packed plugin in a real DSH web app,
 * search from the Files window, and verify the host route and rendered rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — run this spec through scripts/e2e-mount.sh')
}

const WORKSPACE_PATH = join(
  process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace'),
  'fs-search',
)
const SEARCH_QUERY = 'SeArCh-E2E'
const EXPECTED_MATCHES = [
  '.search-e2e-hidden.txt',
  'search-e2e-dir',
  'src/search-e2e-file.TXT',
]

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(join(WORKSPACE_PATH, 'src'), { recursive: true })
  mkdirSync(join(WORKSPACE_PATH, 'search-e2e-dir'), { recursive: true })
  mkdirSync(join(WORKSPACE_PATH, '.git'), { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'src', 'search-e2e-file.TXT'), 'search result\n')
  writeFileSync(join(WORKSPACE_PATH, 'search-e2e-dir', 'child.txt'), 'keeps the directory discoverable by ripgrep\n')
  writeFileSync(join(WORKSPACE_PATH, '.search-e2e-hidden.txt'), 'hidden search result\n')
  writeFileSync(join(WORKSPACE_PATH, '.git', 'search-e2e-secret.txt'), 'must stay excluded\n')

  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: {
      type: 'client-request',
      rpcId: 'fs-search-e2e-workspace',
      method: 'workspace.create',
      payload: { path: WORKSPACE_PATH },
    },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId

  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: {
      type: 'client-request',
      rpcId: 'fs-search-e2e-session',
      method: 'session.create',
      payload: { workspaceId },
    },
  })
  expect(session.ok(), `session.create: ${session.status()} ${await session.text()}`).toBe(true)
}

async function dismissOnboarding(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    return
  }
  for (let round = 0; round < 8; round += 1) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // Another onboarding takeover may temporarily mask this button.
      }
    }
    if (!dismissed) return
  }
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

test('fs-search e2e: searches the mounted workspace from the Files window', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(String(error)))

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)

  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton).toHaveCount(1, { timeout: 90_000 })
  await expandButton.click()

  const searchInput = sidebar.getByPlaceholder(/Search files by name|按文件名搜索/).first()
  await expect(searchInput).toBeVisible({ timeout: 30_000 })
  const searchResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && response.url().endsWith('/sidebar/api/fs.search')
  ))
  await searchInput.fill(SEARCH_QUERY)

  const response = await searchResponse
  expect(response.ok(), `fs.search: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as { ok: boolean; value?: { matches: string[]; truncated: boolean } }
  expect(body).toEqual({ ok: true, value: { matches: EXPECTED_MATCHES, truncated: false } })

  const resultRows = sidebar.locator('button[title]:visible').filter({ hasText: /search-e2e/i })
  await expect(resultRows).toHaveCount(EXPECTED_MATCHES.length)
  await expect
    .poll(() => resultRows.evaluateAll(rows => rows.map(row => row.getAttribute('title'))))
    .toEqual(EXPECTED_MATCHES)
  await expect(sidebar.getByText('search-e2e-secret.txt', { exact: false })).toHaveCount(0)

  await sidebar.locator('button[title="src/search-e2e-file.TXT"]:visible').click()
  await expect(sidebar.locator('input[placeholder^="File path"]:visible')).toHaveValue(/search-e2e-file\.TXT$/)
  expect(pageErrors).toEqual([])
})
