import type { BrowserContext, Page, Request, Response } from 'playwright'
import { hasNormalCommentText } from 'shared/commentText'
import { signReplyABogus } from './replyABogus'

const COMMENT_URL_HINTS = [
  '/comment/list',
  '/comment/detail',
  '/aweme/v1/web/comment',
  '/aweme/v1/comment',
  'comment/?',
]

type JsonRecord = Record<string, unknown>
type RestrictedStatus = 'login_required' | 'verification_required'
type CommentPageKind = 'root' | 'reply'

interface DirectCommentPageResult {
  status: number
  url: string
  body: unknown
  text: string
  error: string
}

interface CommentPageUrlOptions {
  kind: CommentPageKind
  cursor: string
  count: number
  videoId: string
  commentId?: string
}

const VOLATILE_SIGNATURE_PARAMS = new Set([
  'a_bogus',
  'x-bogus',
  '_signature',
  'x-secsdk-web-signature',
  'timestamp',
  'verifyfp',
  'fp',
  'mstoken',
])

const DOUYIN_RISK_STATUS_CODES = new Set([8, 2154, 2156, 10000, 10001])

const SIGNING_TRANSPORT_INIT_SCRIPT = `
(() => {
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const state = {
    capture: false,
    url: '',
    init: null,
    request(input, init) {
      return nativeFetch.call(window, input, init);
    },
  };
  window.__videoCommentSigningTransport = state;

  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (state.capture) {
      state.url = url || '';
      if (input instanceof Request) {
        state.init = {
          method: input.method,
          headers: Array.from(input.headers.entries()),
          credentials: input.credentials,
          cache: input.cache,
          mode: input.mode,
          redirect: input.redirect,
          referrer: input.referrer,
          referrerPolicy: input.referrerPolicy,
        };
      } else {
        state.init = init ? { ...init, headers: init.headers } : {};
      }
      return Promise.reject(new DOMException('comment-signature-captured', 'AbortError'));
    }
    return nativeFetch.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    if (state.capture) {
      state.url = String(url || '');
      throw new DOMException('comment-signature-captured', 'AbortError');
    }
    return nativeOpen.apply(this, arguments);
  };
})();
`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const result = asString(value)
    if (result) return result
  }
  return ''
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return null
}

function normalizeTimestamp(value: number | null): number {
  if (value === null || value <= 0) return Date.now()
  return value < 10_000_000_000 ? value * 1000 : value
}

function getVideoId(videoUrl: string): string {
  try {
    const url = new URL(videoUrl)
    const fromQuery = firstString(
      url.searchParams.get('aweme_id'),
      url.searchParams.get('item_id'),
      url.searchParams.get('video_id'),
      url.searchParams.get('modal_id'),
    )
    if (fromQuery) return fromQuery
    const match = url.pathname.match(/(?:video|note)\/(\d+)/)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

function getVideoIdFromRequestUrl(requestUrl: string): string {
  try {
    const url = new URL(requestUrl)
    return firstString(
      url.searchParams.get('aweme_id'),
      url.searchParams.get('item_id'),
      url.searchParams.get('video_id'),
      url.searchParams.get('modal_id'),
    )
  } catch {
    return ''
  }
}

async function readVideoTitle(page: Page): Promise<string> {
  const title = await page
    .evaluate(() => {
      const metaTitle = document.querySelector<HTMLMetaElement>(
        'meta[property="og:title"]',
      )?.content
      const videoDescription = document
        .querySelector<HTMLElement>('[data-e2e="video-desc"]')
        ?.innerText.trim()
      return metaTitle?.trim() || videoDescription || document.title.trim()
    })
    .catch(() => '')

  return title
    .replace(/\s*[-_|]\s*抖音(?:\s*-\s*记录美好生活)?\s*$/u, '')
    .replace(/^抖音\s*[-_|]\s*/u, '')
    .trim()
}

function isAllowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'douyin.com' ||
    normalized.endsWith('.douyin.com') ||
    normalized === 'iesdouyin.com' ||
    normalized.endsWith('.iesdouyin.com')
  )
}

function isCommentResponse(url: string): boolean {
  const normalized = url.toLowerCase()
  return COMMENT_URL_HINTS.some(hint => normalized.includes(hint))
}

function isReplyResponse(url: string): boolean {
  return url.toLowerCase().includes('/comment/list/reply')
}

function isRootCommentResponse(url: string): boolean {
  const normalized = url.toLowerCase()
  return normalized.includes('/comment/list/') && !isReplyResponse(normalized)
}

function readHasMore(value: unknown): boolean | null {
  if (!isRecord(value)) return null
  for (const key of ['has_more', 'hasMore', 'has_more_comments']) {
    const candidate = value[key]
    if (typeof candidate === 'boolean') return candidate
    if (candidate === 1 || candidate === '1') return true
    if (candidate === 0 || candidate === '0') return false
  }
  for (const child of Object.values(value)) {
    const nested = readHasMore(child)
    if (nested !== null) return nested
  }
  return null
}

function readCursor(value: unknown): string {
  if (!isRecord(value)) return ''
  const cursor = firstString(value.cursor, value.max_cursor, value.maxCursor, value.next_cursor)
  if (cursor) return cursor
  for (const child of Object.values(value)) {
    if (typeof child !== 'object' || child === null) continue
    const nested = readCursor(child)
    if (nested) return nested
  }
  return ''
}

export function readOfficialCommentCount(value: unknown): number | null {
  if (!isRecord(value)) return null
  const total = firstNumber(
    value.total,
    value.comment_total,
    value.comment_count,
    value.commentCount,
  )
  return total === null ? null : Math.max(Math.trunc(total), 0)
}

export function getUnavailableCommentCount(
  officialCommentCount: number | null,
  collectedCommentCount: number,
): number {
  if (officialCommentCount === null) return 0
  return Math.max(officialCommentCount - collectedCommentCount, 0)
}

function restrictionFromText(text: string): RestrictedStatus | null {
  if (
    /验证码|安全验证|完成验证|访问频繁|操作频繁|captcha\s*(?:required|challenge)|verif(?:y|ication)\s*required/i.test(
      text,
    )
  ) {
    return 'verification_required'
  }
  if (/登录后(?:即可|查看)|请先登录|扫码登录|手机号登录|账号登录/.test(text)) {
    return 'login_required'
  }
  return null
}

function restrictionFromPayload(value: unknown, depth = 0): RestrictedStatus | null {
  if (!isRecord(value) || depth > 2) return null
  const statusCode = firstNumber(value.status_code, value.statusCode, value.error_code)
  if (statusCode !== null && DOUYIN_RISK_STATUS_CODES.has(statusCode)) {
    return statusCode === 8 ? 'login_required' : 'verification_required'
  }
  const statusText = firstString(
    value.status_msg,
    value.status_message,
    value.message,
    value.error_msg,
    value.description,
  )
  const fromStatus = restrictionFromText(statusText)
  if (fromStatus) return fromStatus

  if (depth <= 1 && (value.captcha || value.verify_data || value.verification_data)) {
    return 'verification_required'
  }
  for (const key of ['data', 'extra', 'status']) {
    const nested = restrictionFromPayload(value[key], depth + 1)
    if (nested) return nested
  }
  return null
}

function restrictionFromUrl(url: string): RestrictedStatus | null {
  const normalized = url.toLowerCase()
  if (/captcha|verify|secsdk/.test(normalized)) return 'verification_required'
  if (/passport|\/login|sso\./.test(normalized)) return 'login_required'
  return null
}

async function detectPageRestriction(page: Page): Promise<RestrictedStatus | null> {
  const frames = page.frames().filter(frame => !frame.isDetached())
  for (const frame of frames) {
    const fromUrl = restrictionFromUrl(frame.url())
    if (fromUrl) return fromUrl
  }

  for (const frame of frames) {
    const frameText = await frame
      .locator('body')
      .innerText({ timeout: frame === page.mainFrame() ? 1500 : 500 })
      .catch(() => '')
    const fromText = restrictionFromText(frameText.slice(0, 20_000))
    if (fromText) return fromText
  }
  return null
}

function readUser(value: JsonRecord): JsonRecord {
  const candidate = value.user ?? value.user_info ?? value.author ?? value.author_info
  return isRecord(candidate) ? candidate : {}
}

function readComment(
  value: JsonRecord,
  sourceUrl: string,
  videoId: string,
): VideoCommentRecord | null {
  const user = readUser(value)
  const commentId = firstString(value.cid, value.comment_id, value.commentId, value.commentIdStr)
  const comment = firstString(value.text, value.content, value.comment_text, value.commentText)
  if (!commentId || !hasNormalCommentText(comment)) return null

  const rawParentCommentId = firstString(
    value.reply_id,
    value.replyId,
    value.parent_id,
    value.parentId,
  )
  const parentCommentId = rawParentCommentId === '0' ? '' : rawParentCommentId

  const userId = firstString(user.uid, user.user_id, user.userId, value.user_id, value.uid)
  const douyinId = firstString(
    user.unique_id,
    user.uniqueId,
    user.display_id,
    user.short_id,
    user.shortId,
    value.douyin_id,
    value.display_id,
    value.short_id,
  )
  const nickname = firstString(user.nickname, user.nick_name, value.nick_name, value.nickname)
  const createdAt = normalizeTimestamp(
    firstNumber(value.create_time, value.createTime, value.created_at, value.timestamp),
  )

  return {
    commentId,
    parentCommentId,
    isReply: Boolean(parentCommentId),
    userId,
    douyinId,
    nickname,
    comment,
    createdAt,
    videoId,
    sourceUrl,
  }
}

function collectComments(
  value: unknown,
  sourceUrl: string,
  videoId: string,
  output: Map<string, VideoCommentRecord>,
) {
  if (Array.isArray(value)) {
    for (const item of value) collectComments(item, sourceUrl, videoId, output)
    return
  }
  if (!isRecord(value)) return

  const comment = readComment(value, sourceUrl, videoId)
  if (comment && !output.has(comment.commentId)) output.set(comment.commentId, comment)

  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) {
      collectComments(child, sourceUrl, videoId, output)
    }
  }
}

export function parseVideoCommentPayload(
  value: unknown,
  sourceUrl: string,
  videoId: string,
): VideoCommentRecord[] {
  const comments = new Map<string, VideoCommentRecord>()
  collectComments(value, sourceUrl, videoId, comments)
  return [...comments.values()]
}

function collectReplyTargets(value: unknown, output: Set<string>) {
  if (!isRecord(value)) return
  const items = value.comments
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue
      const replyId = firstString(item.reply_id, item.replyId)
      const commentId = firstString(item.cid, item.comment_id, item.commentId)
      const replyTotal = firstNumber(
        item.reply_comment_total,
        item.replyCommentTotal,
        item.reply_count,
      )
      if ((!replyId || replyId === '0') && commentId && (replyTotal ?? 0) > 0) {
        output.add(commentId)
      }
    }
  }
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) collectReplyTargets(child, output)
  }
}

export function buildCommentPageUrl(templateUrl: string, options: CommentPageUrlOptions): string {
  const url = new URL(templateUrl)
  for (const key of [...url.searchParams.keys()]) {
    if (VOLATILE_SIGNATURE_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
  }

  url.pathname =
    options.kind === 'root' ? '/aweme/v1/web/comment/list/' : '/aweme/v1/web/comment/list/reply/'
  url.searchParams.set('cursor', options.cursor)
  url.searchParams.set('count', String(options.count))
  url.searchParams.set('item_type', '0')

  if (options.kind === 'root') {
    url.searchParams.set('aweme_id', options.videoId)
    for (const key of ['item_id', 'comment_id']) url.searchParams.delete(key)
  } else {
    url.searchParams.set('item_id', options.videoId)
    url.searchParams.set('comment_id', options.commentId ?? '')
    url.searchParams.set('cut_version', '1')
    for (const key of ['aweme_id', 'insert_ids', 'whale_cut_token', 'rcFT']) {
      url.searchParams.delete(key)
    }
  }
  return url.href
}

async function buildFallbackCommentTemplate(page: Page, videoId: string): Promise<string> {
  const profile = await page.evaluate(() => {
    const chromeVersion = navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1]
    const firefoxVersion = navigator.userAgent.match(/Firefox\/([\d.]+)/)?.[1]
    const browserName = firefoxVersion ? 'Firefox' : 'Chrome'
    const browserVersion = firefoxVersion ?? chromeVersion ?? '130.0.0.0'
    return {
      origin: location.origin,
      screenWidth: screen.width,
      screenHeight: screen.height,
      language: navigator.language || 'zh-CN',
      platform: navigator.platform || 'Win32',
      browserName,
      browserVersion,
      engineName: firefoxVersion ? 'Gecko' : 'Blink',
      cpuCoreNum: navigator.hardwareConcurrency || 8,
      deviceMemory: Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 8,
    }
  })
  const url = new URL('/aweme/v1/web/comment/list/', profile.origin)
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '290100',
    version_name: '29.1.0',
    cookie_enabled: 'true',
    screen_width: String(profile.screenWidth),
    screen_height: String(profile.screenHeight),
    browser_language: profile.language,
    browser_platform: profile.platform,
    browser_name: profile.browserName,
    browser_version: profile.browserVersion,
    browser_online: 'true',
    engine_name: profile.engineName,
    engine_version: profile.browserVersion,
    os_name: profile.platform.toLowerCase().includes('win') ? 'Windows' : profile.platform,
    os_version: '10',
    cpu_core_num: String(profile.cpuCoreNum),
    device_memory: String(profile.deviceMemory),
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '0',
    update_version_code: '170400',
    aweme_id: videoId,
    cursor: '0',
    count: '20',
    item_type: '0',
    insert_ids: '',
    whale_cut_token: '',
    cut_version: '1',
    rcFT: '',
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.href
}

async function fetchCommentPage(
  page: Page,
  templateUrl: string,
  options: CommentPageUrlOptions,
  replyUserAgent = '',
): Promise<DirectCommentPageResult> {
  let requestUrl = buildCommentPageUrl(templateUrl, options)
  if (options.kind === 'reply') {
    const userAgent = replyUserAgent || (await page.evaluate(() => navigator.userAgent))
    const signedUrl = new URL(requestUrl)
    signedUrl.searchParams.append('a_bogus', signReplyABogus(signedUrl.search.slice(1), userAgent))
    requestUrl = signedUrl.href
  }
  return page.evaluate(async url => {
    type SigningTransport = {
      capture: boolean
      url: string
      init: RequestInit | null
      request: typeof window.fetch
    }
    const signingWindow = window as typeof window & {
      __videoCommentSigningTransport?: SigningTransport
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20_000)
    try {
      const transport = signingWindow.__videoCommentSigningTransport
      if (!transport) throw new Error('抖音签名传输层尚未初始化')

      let signedUrl = url
      if (!new URL(url, location.origin).pathname.includes('/comment/list/reply/')) {
        signedUrl = ''
        for (const delay of [250, 400, 650, 1000]) {
          transport.capture = true
          transport.url = ''
          transport.init = null
          try {
            await window.fetch(url, { method: 'GET' })
          } catch {
            // The pre-page transport deliberately aborts after the SDK signs the URL.
          } finally {
            transport.capture = false
          }

          if (transport.url) {
            const captured = new URL(transport.url, location.origin)
            if (captured.searchParams.has('a_bogus')) {
              signedUrl = captured.href
              break
            }
          }
          await new Promise(resolve => window.setTimeout(resolve, delay))
        }
        if (!signedUrl) throw new Error('抖音页面脚本未生成 a_bogus')
      }

      const replayInit: RequestInit = transport.init ?? {}
      const response = await transport.request(signedUrl, {
        ...replayInit,
        credentials: 'include',
        headers: replayInit.headers ?? { Accept: 'application/json, text/plain, */*' },
        signal: controller.signal,
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        // Challenge pages and empty responses are classified by their text below.
      }
      return {
        status: response.status,
        url: response.url || url,
        body,
        text: text.slice(0, 20_000),
        error: '',
      }
    } catch (error) {
      return {
        status: 0,
        url,
        body: null,
        text: '',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      window.clearTimeout(timeout)
    }
  }, requestUrl)
}

async function clickCommentPanel(page: Page) {
  const selectors = [
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e="comment-icon"]',
    'button:has-text("评论")',
    '[aria-label*="评论"]',
  ]
  for (const selector of selectors) {
    const button = page.locator(selector).first()
    if ((await button.count()) === 0) continue
    try {
      await button.click({ timeout: 1500 })
      await page.waitForTimeout(500)
      return
    } catch {
      // The page may already have the comment panel open.
    }
  }
}

async function waitForInteractiveAccess(
  page: Page,
  sourceUrl: string,
  timeoutMs: number,
  getResponseRestriction: () => RestrictedStatus | null,
  resetResponseRestriction: () => void,
): Promise<RestrictedStatus | null> {
  let restriction = (await detectPageRestriction(page)) ?? getResponseRestriction()
  if (!restriction || timeoutMs <= 0) return restriction

  const deadline = Date.now() + timeoutMs
  let unrestrictedChecks = 0
  while (Date.now() < deadline && !page.isClosed()) {
    await page.waitForTimeout(1000).catch(() => undefined)
    if (page.isClosed()) return restriction

    const current = await detectPageRestriction(page).catch(() => restriction)
    if (current) {
      restriction = current
      unrestrictedChecks = 0
      continue
    }

    unrestrictedChecks += 1
    if (unrestrictedChecks < 2) continue

    resetResponseRestriction()
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1500)
    restriction = (await detectPageRestriction(page)) ?? getResponseRestriction()
    if (!restriction) return null
    unrestrictedChecks = 0
  }
  return restriction
}

export function getCommentRequestDelay(
  kind: CommentPageKind,
  completedRequestCount: number,
  throttleLevel = 0,
  randomValue = Math.random(),
): number {
  if (kind === 'root' && completedRequestCount === 0) return 0

  const profile =
    kind === 'reply'
      ? { baseDelay: 180, jitter: 220, pauseEvery: 48, pauseDelay: 2000 }
      : { baseDelay: 120, jitter: 180, pauseEvery: 40, pauseDelay: 1500 }
  const boundedRandom = Math.min(Math.max(randomValue, 0), 0.999_999)
  const multiplier = 2 ** Math.min(Math.max(Math.floor(throttleLevel), 0), 2)
  let delay = profile.baseDelay + Math.floor(boundedRandom * (profile.jitter + 1))
  if (completedRequestCount > 0 && completedRequestCount % profile.pauseEvery === 0) {
    delay += profile.pauseDelay
  }
  return delay * multiplier
}

export function getReplyConcurrency(throttleLevel = 0): number {
  if (throttleLevel >= 2) return 1
  if (throttleLevel === 1) return 3
  return 6
}

async function waitBeforeApiRequest(
  page: Page,
  kind: CommentPageKind,
  completedRequestCount: number,
  throttleLevel: number,
) {
  const delay = getCommentRequestDelay(kind, completedRequestCount, throttleLevel)
  if (delay > 0) await page.waitForTimeout(delay)
}

export class VideoCommentCollector {
  constructor(
    private context: BrowserContext,
    private initialPage?: Page,
  ) {}

  async collect(
    options: VideoCommentCollectOptions,
    onProgress?: (progress: VideoCommentCollectionProgress) => void,
  ): Promise<VideoCommentCollectionResult> {
    const sourceUrl = options.videoUrl.trim()
    const parsedUrl = new URL(sourceUrl)
    if (parsedUrl.protocol !== 'https:' || !isAllowedHost(parsedUrl.hostname)) {
      throw new Error('只支持抖音公开页面地址')
    }

    const page =
      this.initialPage && !this.initialPage.isClosed()
        ? this.initialPage
        : await this.context.newPage()
    this.initialPage = undefined
    await page.addInitScript(SIGNING_TRANSPORT_INIT_SCRIPT)
    const comments = new Map<string, VideoCommentRecord>()
    const replyTargets = new Set<string>()
    let videoId = getVideoId(sourceUrl)
    let videoTitle = ''
    const maxPages = Math.min(Math.max(options.maxPages ?? 1000, 1), 5000)
    const maxComments = Math.min(Math.max(options.maxComments ?? 100_000, 1), 200_000)
    const interactiveAuthWaitMs = Math.min(Math.max(options.interactiveAuthWaitMs ?? 0, 0), 300_000)
    const pendingResponses = new Set<Promise<void>>()
    let rootRequestTemplate = ''
    let replyRequestTemplate = ''
    let rootHasMore: boolean | null = null
    let rootComplete = false
    let repliesComplete = true
    let directFetchFailed = false
    let pagesObserved = 0
    let responseRestriction: RestrictedStatus | null = null
    let pageRestriction: RestrictedStatus | null = null
    let finalUrl = sourceUrl
    let recoveryAttempts = 0
    let throttleLevel = 0
    let rootComments = 0
    let replies = 0
    let officialCommentCount: number | null = null
    const startedAt = Date.now()

    const emitProgress = (
      phase: VideoCommentCollectionProgress['phase'],
      newComments: VideoCommentRecord[] = [],
      message = '',
    ) => {
      if (!onProgress) return
      const elapsedMs = Math.max(Date.now() - startedAt, 1)
      onProgress({
        requestId: options.requestId ?? '',
        videoId,
        videoTitle,
        sourceUrl,
        phase,
        comments: newComments,
        totalComments: comments.size,
        rootComments,
        replies,
        officialCommentCount,
        unavailableCommentCount: getUnavailableCommentCount(officialCommentCount, comments.size),
        pagesObserved,
        elapsedMs,
        commentsPerSecond: comments.size / (elapsedMs / 1000),
        message,
      })
    }

    const addComments = (parsedComments: VideoCommentRecord[]) => {
      const added: VideoCommentRecord[] = []
      for (const comment of parsedComments) {
        if (comments.has(comment.commentId) || comments.size >= maxComments) continue
        comments.set(comment.commentId, comment)
        if (comment.isReply) replies += 1
        else rootComments += 1
        added.push(comment)
      }
      return added
    }

    emitProgress('opening', [], '正在打开抖音视频并准备评论接口')

    const processResponse = async (response: Response) => {
      if (!isCommentResponse(response.url())) return
      const requestVideoId = getVideoIdFromRequestUrl(response.url())
      if (videoId && requestVideoId && requestVideoId !== videoId) return
      videoId = videoId || requestVideoId
      pagesObserved += 1
      if (response.status() === 401) responseRestriction = 'login_required'
      if (response.status() === 403 || response.status() === 429) {
        responseRestriction = 'verification_required'
      }
      try {
        const body = await response.json()
        responseRestriction = restrictionFromPayload(body) ?? responseRestriction
        const responseHasMore = readHasMore(body)
        if (!isReplyResponse(response.url()) && responseHasMore !== null) {
          rootHasMore = responseHasMore
        }
        if (isRootCommentResponse(response.url())) {
          officialCommentCount = readOfficialCommentCount(body) ?? officialCommentCount
          collectReplyTargets(body, replyTargets)
        }
        const added = addComments(parseVideoCommentPayload(body, sourceUrl, videoId))
        emitProgress(isReplyResponse(response.url()) ? 'replies' : 'root', added)
      } catch {
        // Some endpoints return an empty body or a non-JSON challenge response.
      }
    }
    const onResponse = (response: Response) => {
      const task = processResponse(response).finally(() => pendingResponses.delete(task))
      pendingResponses.add(task)
    }
    const onRequest = (request: Request) => {
      if (!isRootCommentResponse(request.url()) && !isReplyResponse(request.url())) return
      const requestVideoId = getVideoIdFromRequestUrl(request.url())
      if (videoId && requestVideoId && requestVideoId !== videoId) return
      if (isReplyResponse(request.url())) {
        replyRequestTemplate ||= request.url()
      } else {
        rootRequestTemplate ||= request.url()
      }
    }

    const recordDirectPage = (result: DirectCommentPageResult, kind: CommentPageKind) => {
      pagesObserved += 1
      if (result.status === 401) responseRestriction = 'login_required'
      if (result.status === 403 || result.status === 429) {
        responseRestriction = 'verification_required'
      }
      responseRestriction =
        (isRecord(result.body)
          ? restrictionFromPayload(result.body)
          : restrictionFromText(result.text)) ?? responseRestriction
      if (result.error || !isRecord(result.body)) {
        if (!responseRestriction) directFetchFailed = true
        return false
      }
      if (kind === 'root') {
        officialCommentCount = readOfficialCommentCount(result.body) ?? officialCommentCount
        collectReplyTargets(result.body, replyTargets)
      }
      const added = addComments(parseVideoCommentPayload(result.body, sourceUrl, videoId))
      emitProgress(kind === 'reply' ? 'replies' : 'root', added)
      return true
    }

    const recoverDirectAccess = async () => {
      if (!responseRestriction || recoveryAttempts >= 2) return false
      recoveryAttempts += 1
      emitProgress('verification', [], '需要登录或安全验证，完成后将从当前进度继续')
      pageRestriction = await waitForInteractiveAccess(
        page,
        sourceUrl,
        interactiveAuthWaitMs,
        () => responseRestriction,
        () => {
          responseRestriction = null
        },
      )
      if (pageRestriction || responseRestriction) return false
      await clickCommentPanel(page)
      await page.waitForTimeout(1000)
      return true
    }

    page.on('response', onResponse)
    page.on('request', onRequest)
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      videoId = videoId || getVideoId(page.url())
      await page.waitForTimeout(1500)
      videoTitle = await readVideoTitle(page)
      pageRestriction = await detectPageRestriction(page)
      if (pageRestriction || responseRestriction) {
        pageRestriction = await waitForInteractiveAccess(
          page,
          sourceUrl,
          interactiveAuthWaitMs,
          () => responseRestriction,
          () => {
            responseRestriction = null
          },
        )
      }

      if (!pageRestriction && !responseRestriction) {
        await clickCommentPanel(page)

        const templateDeadline = Date.now() + 8000
        while (!rootRequestTemplate && Date.now() < templateDeadline) {
          await page.waitForTimeout(200)
        }
        if (pendingResponses.size) await Promise.all([...pendingResponses])
        page.off('response', onResponse)
        page.off('request', onRequest)

        if (!rootRequestTemplate) {
          rootRequestTemplate = await buildFallbackCommentTemplate(page, videoId)
        }

        let rootCursor = '0'
        let rootRequestCount = 0
        for (
          let pageIndex = 0;
          pageIndex < maxPages && comments.size < maxComments;
          pageIndex += 1
        ) {
          await waitBeforeApiRequest(page, 'root', rootRequestCount, throttleLevel)
          const result = await fetchCommentPage(page, rootRequestTemplate, {
            kind: 'root',
            cursor: rootCursor,
            count: 20,
            videoId,
          })
          rootRequestCount += 1
          const pageRecorded = recordDirectPage(result, 'root')
          if (responseRestriction) {
            if (await recoverDirectAccess()) {
              throttleLevel = Math.min(throttleLevel + 1, 2)
              pageIndex -= 1
              continue
            }
            break
          }
          if (!pageRecorded) break
          rootRequestTemplate = result.url || rootRequestTemplate
          rootHasMore = readHasMore(result.body)
          if (rootHasMore === false) {
            rootComplete = true
            break
          }

          const nextCursor = readCursor(result.body)
          if (!nextCursor || nextCursor === rootCursor) {
            directFetchFailed = true
            break
          }
          rootCursor = nextCursor
        }

        if (rootHasMore === true && !rootComplete) repliesComplete = false

        const replyUserAgent = await page.evaluate(() => navigator.userAgent)
        const replyThreads = [...replyTargets].map(commentId => ({
          commentId,
          cursor: '0',
          pageIndex: 0,
          complete: false,
        }))
        const replyQueue = [...replyThreads]
        let replyRequestCount = 0
        let stopReplyCollection = false

        while (replyQueue.length > 0 && !stopReplyCollection) {
          if (comments.size >= maxComments || responseRestriction) break

          const concurrency = getReplyConcurrency(throttleLevel)
          const batch = replyQueue.splice(0, concurrency)
          const templateUrl = replyRequestTemplate || rootRequestTemplate
          const batchResults = await Promise.all(
            batch.map(async thread => {
              const requestIndex = replyRequestCount
              replyRequestCount += 1
              await waitBeforeApiRequest(page, 'reply', requestIndex, throttleLevel)
              const result = await fetchCommentPage(
                page,
                templateUrl,
                {
                  kind: 'reply',
                  cursor: thread.cursor,
                  count: 20,
                  videoId,
                  commentId: thread.commentId,
                },
                replyUserAgent,
              )
              return { thread, result }
            }),
          )

          const retryAfterRecovery: typeof replyQueue = []
          for (const { thread, result } of batchResults) {
            const restriction =
              result.status === 401
                ? 'login_required'
                : result.status === 403 || result.status === 429
                  ? 'verification_required'
                  : isRecord(result.body)
                    ? restrictionFromPayload(result.body)
                    : restrictionFromText(result.text)
            const pageRecorded = recordDirectPage(result, 'reply')
            if (restriction) {
              retryAfterRecovery.push(thread)
              continue
            }
            if (!pageRecorded) continue

            replyRequestTemplate ||= result.url
            const hasMore = readHasMore(result.body)
            if (hasMore === false) {
              thread.complete = true
              continue
            }

            const nextCursor = readCursor(result.body)
            if (!nextCursor || nextCursor === thread.cursor) {
              directFetchFailed = true
              continue
            }
            thread.cursor = nextCursor
            thread.pageIndex += 1
            if (thread.pageIndex < maxPages) {
              replyQueue.push(thread)
            }
          }

          if (responseRestriction) {
            if (await recoverDirectAccess()) {
              throttleLevel = Math.min(throttleLevel + 1, 2)
              replyQueue.unshift(...retryAfterRecovery)
              continue
            }
            stopReplyCollection = true
          }
        }

        if (replyThreads.some(thread => !thread.complete) || stopReplyCollection) {
          repliesComplete = false
        }
      }
      if (pendingResponses.size) await Promise.all([...pendingResponses])
    } finally {
      finalUrl = page.url()
      // A late overlay can contain generic verification copy even after authenticated API
      // requests succeeded. Only use page text as a fallback when the API produced no usable data.
      pageRestriction =
        comments.size === 0 || directFetchFailed
          ? await detectPageRestriction(page).catch(() => null)
          : null
      page.off('response', onResponse)
      page.off('request', onRequest)
      await page.close().catch(() => undefined)
    }

    const restriction = responseRestriction ?? pageRestriction
    const paginationComplete = rootComplete && repliesComplete && !directFetchFailed
    const unavailableCommentCount = getUnavailableCommentCount(officialCommentCount, comments.size)
    const collectionComplete = paginationComplete && unavailableCommentCount === 0
    const status: VideoCommentCollectionResult['status'] = restriction
      ? restriction
      : comments.size === 0
        ? 'empty'
        : collectionComplete
          ? 'complete'
          : 'partial'
    const message =
      status === 'verification_required'
        ? '抖音要求完成安全验证，已保留当前成功采集的评论'
        : status === 'login_required'
          ? '该视频评论需要登录后查看，已保留当前成功采集的评论'
          : status === 'empty'
            ? '接口未返回公开评论，视频可能没有评论或评论未公开'
            : status === 'partial'
              ? paginationComplete && officialCommentCount !== null
                ? `已读完网页接口可返回的文字评论；官方计数 ${officialCommentCount}，采集文字评论 ${comments.size} 条，另有 ${unavailableCommentCount} 条未纳入（无文字内容已过滤，也可能包含已删除、审核折叠或权限不可见的评论）`
                : '已通过接口读取部分评论，达到采集上限、游标停滞或抖音仍有更多数据'
              : '已读完网页接口可返回的全部主评论和回复，全程无需滚动页面'

    emitProgress('complete', [], message)

    return {
      videoId,
      videoTitle,
      sourceUrl,
      finalUrl,
      comments: [...comments.values()].slice(0, maxComments),
      officialCommentCount,
      unavailableCommentCount,
      pagesObserved,
      hasMore: paginationComplete ? false : rootHasMore,
      status,
      sessionMode: 'standalone',
      message,
    }
  }
}
