import fs from 'node:fs/promises'
import path from 'node:path'
import { Result } from '@praha/byethrow'
import { app } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { accountManager } from '#/managers/AccountManager'
import { browserManager, type StorageState } from '#/managers/BrowserSessionManager'
import { prepareDouyinLogin } from '#/platforms/douyin/videoCommentAuth'
import { VideoCommentCollector } from '#/platforms/douyin/videoCommentCollector'
import { typedIpcMainHandle } from '#/utils'

const STANDALONE_SESSION_FILE = 'douyin-video-comments-session.json'

function getStandaloneSessionPath() {
  return path.join(app.getPath('userData'), STANDALONE_SESSION_FILE)
}

async function loadStandaloneStorageState(): Promise<StorageState | undefined> {
  try {
    return JSON.parse(await fs.readFile(getStandaloneSessionPath(), 'utf8')) as StorageState
  } catch {
    return undefined
  }
}

async function collectWithStandaloneBrowser(
  options: VideoCommentCollectOptions,
  onProgress?: (progress: VideoCommentCollectionProgress) => void,
) {
  const browserSession = await browserManager.createSession(
    false,
    await loadStandaloneStorageState(),
  )
  try {
    const loginWaitMs = Math.min(Math.max(options.interactiveAuthWaitMs ?? 300_000, 0), 300_000)
    const loggedIn = await prepareDouyinLogin(
      browserSession.context,
      browserSession.page,
      loginWaitMs,
    )
    if (!loggedIn) {
      return {
        videoId: '',
        videoTitle: '',
        sourceUrl: options.videoUrl.trim(),
        finalUrl: browserSession.page.url(),
        comments: [],
        officialCommentCount: null,
        unavailableCommentCount: 0,
        pagesObserved: 0,
        hasMore: null,
        status: 'login_required' as const,
        sessionMode: 'standalone' as const,
        message: '等待登录超时，请重新开始并在弹出的抖音窗口完成登录',
      }
    }

    const collector = new VideoCommentCollector(browserSession.context, browserSession.page)
    const result = await collector.collect(options, onProgress)
    return { ...result, sessionMode: 'standalone' as const }
  } finally {
    const state = await browserSession.context.storageState().catch(() => null)
    if (state) {
      await fs
        .writeFile(getStandaloneSessionPath(), JSON.stringify(state), 'utf8')
        .catch(() => undefined)
    }
    await browserSession.browser.close().catch(() => undefined)
  }
}

export function setupVideoCommentIpcHandlers() {
  typedIpcMainHandle(
    IPC_CHANNELS.tasks.videoComments.collect,
    async (event, accountId: string, options: VideoCommentCollectOptions) => {
      const onProgress = (progress: VideoCommentCollectionProgress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.tasks.videoComments.progress, progress)
        }
      }
      const session = accountManager.getSession(accountId)
      if (Result.isSuccess(session)) {
        const result = await session.value.collectVideoComments(options, onProgress)
        if (Result.isSuccess(result)) {
          return { ...result.value, sessionMode: 'account' as const }
        }
      }

      return collectWithStandaloneBrowser(options, onProgress)
    },
  )
}
