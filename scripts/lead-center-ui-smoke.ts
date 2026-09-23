import { chromium } from 'playwright'
import { IPC_CHANNELS } from '../shared/ipcChannels'

const cdpUrl = process.env.ELECTRON_CDP_URL ?? 'http://127.0.0.1:9222'
const arguments_ = process.argv.slice(2)
const videoUrl = arguments_.find(argument => !argument.startsWith('--'))
const shouldWatch = arguments_.includes('--watch')
const collectionMaxWaitMs = Number(process.env.VIDEO_COLLECTION_MAX_WAIT_MS ?? 45 * 60_000)
const collectionStallTimeoutMs = Number(process.env.VIDEO_COLLECTION_STALL_TIMEOUT_MS ?? 2 * 60_000)
const progressLogIntervalMs = 30_000

async function waitForCollectionToFinish(
  progressRegion: import('playwright').Locator,
  collectButton: import('playwright').Locator,
) {
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let lastLogAt = 0
  let previousProgressText = ''

  while (!(await collectButton.isVisible().catch(() => false))) {
    const progressText = (await progressRegion.innerText().catch(() => '')).replaceAll('\n', ' | ')
    const now = Date.now()
    if (progressText && progressText !== previousProgressText) {
      previousProgressText = progressText
      lastProgressAt = now
    }
    if (progressText && now - lastLogAt >= progressLogIntervalMs) {
      console.error(`[video-comments] ${progressText}`)
      lastLogAt = now
    }
    if (now - lastProgressAt > collectionStallTimeoutMs) {
      throw new Error(`评论采集连续 ${Math.round(collectionStallTimeoutMs / 1000)} 秒没有进度`)
    }
    if (now - startedAt > collectionMaxWaitMs) {
      throw new Error(`评论采集超过最大等待时间 ${Math.round(collectionMaxWaitMs / 60_000)} 分钟`)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

const browser = await chromium.connectOverCDP(cdpUrl)

try {
  const page = browser
    .contexts()
    .flatMap(context => context.pages())
    .find(candidate => candidate.url().startsWith('http://localhost:'))

  if (!page) throw new Error(`未在 ${cdpUrl} 找到开发版 Electron 页面`)

  const origin = new URL(page.url()).origin
  if (!page.url().includes('#/lead-center')) await page.goto(`${origin}/#/lead-center`)
  await page.getByRole('heading', { name: '获客线索' }).waitFor()

  const videoInput = page.getByPlaceholder('粘贴抖音公开视频地址')
  const speedSelect = page.getByRole('combobox', { name: '采集速度' })
  const collectButton = page.getByRole('button', { name: '读取全部评论' })
  const progressRegion = page.locator('[data-testid="collection-progress"]')
  let firstProgressText = ''
  await videoInput.waitFor()
  await collectButton.waitFor()

  if (videoUrl) {
    await page.evaluate(channel => {
      const state = { events: 0, nonEmptyEvents: 0, streamedComments: 0 }
      Object.assign(window, { __videoProgressSmoke: state })
      window.ipcRenderer.on(channel, progress => {
        state.events += 1
        if (progress.comments.length > 0) state.nonEmptyEvents += 1
        state.streamedComments += progress.comments.length
      })
    }, IPC_CHANNELS.tasks.videoComments.progress)
    await videoInput.fill(videoUrl)
    await collectButton.click()
    await page.getByRole('button', { name: /登录验证或采集中/ }).waitFor({ timeout: 10_000 })
    await progressRegion.waitFor({ timeout: 30_000 })
    await page.waitForFunction(
      () =>
        /已读取\s*[1-9]\d*\s*条/.test(
          document.querySelector('[data-testid="collection-progress"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 90_000 },
    )
    firstProgressText = ((await progressRegion.innerText()) ?? '').replaceAll('\n', ' · ')
    await waitForCollectionToFinish(progressRegion, collectButton)
  } else if (shouldWatch) {
    if (!(await collectButton.isVisible().catch(() => false))) {
      await progressRegion.waitFor({ timeout: 30_000 })
      await waitForCollectionToFinish(progressRegion, collectButton)
    }
  }

  const liveRegion = page.locator('[aria-live="polite"]').first()
  const summary = (await liveRegion.count()) ? ((await liveRegion.textContent()) ?? '') : ''
  const progressText = (await progressRegion.count())
    ? ((await progressRegion.innerText()) ?? '').replaceAll('\n', ' · ')
    : ''
  const progressEvidence = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __videoProgressSmoke?: {
            events: number
            nonEmptyEvents: number
            streamedComments: number
          }
        }
      ).__videoProgressSmoke ?? null,
  )
  console.log(
    JSON.stringify(
      {
        url: page.url(),
        rendered: true,
        speedSelectorRemoved: (await speedSelect.count()) === 0,
        collecting: await page
          .getByRole('button', { name: /登录验证或采集中/ })
          .isVisible()
          .catch(() => false),
        collectionTriggered: Boolean(videoUrl),
        realtimeProgressAvailable: videoUrl
          ? (await progressRegion.count()) > 0
          : (await page.getByText('待 AI 筛选', { exact: true }).count()) > 0,
        firstProgressText,
        progressText,
        progressEvidence,
        summary,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
