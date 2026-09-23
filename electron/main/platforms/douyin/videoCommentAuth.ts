import type { BrowserContext, Page } from 'playwright'

const DOUYIN_HOME_URL = 'https://www.douyin.com/'

const AUTH_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'sid_ucp_v1',
  'ssid_ucp_v1',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
  'passport_auth_status_ss',
])

export async function hasDouyinLoginSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(DOUYIN_HOME_URL)
  return cookies.some(cookie => AUTH_COOKIE_NAMES.has(cookie.name) && Boolean(cookie.value))
}

async function openLoginPanel(page: Page) {
  const selectors = [
    '[data-e2e="login-button"]',
    'button:has-text("登录")',
    '[role="button"]:has-text("登录")',
  ]
  for (const selector of selectors) {
    const button = page.locator(selector).first()
    if ((await button.count()) === 0) continue
    try {
      await button.click({ timeout: 2000 })
      return
    } catch {
      // The login panel may already be visible or covered by a site prompt.
    }
  }
}

export async function prepareDouyinLogin(
  context: BrowserContext,
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  if (await hasDouyinLoginSession(context)) return true

  await page.goto(DOUYIN_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1500)
  await openLoginPanel(page)

  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 300_000)
  while (Date.now() < deadline && !page.isClosed()) {
    if (await hasDouyinLoginSession(context)) {
      await page.waitForTimeout(1200)
      return true
    }
    await page.waitForTimeout(1000)
  }
  return false
}
