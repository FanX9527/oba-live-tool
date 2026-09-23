import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { prepareDouyinLogin } from '../electron/main/platforms/douyin/videoCommentAuth'
import { VideoCommentCollector } from '../electron/main/platforms/douyin/videoCommentCollector'

const PAGINATION_PARAMETER_NAMES = [
  'count',
  'item_type',
  'insert_ids',
  'whale_cut_token',
  'rcFT',
  'sort_type',
  'comment_sort',
] as const

function summarizeParameterValues(values: Map<string, Set<string>>) {
  return Object.fromEntries(
    [...values].map(([key, variants]) => {
      const nonEmpty = [...variants].filter(Boolean)
      return [
        key,
        {
          distinctValues: variants.size,
          nonEmptyValues: nonEmpty.length,
          lengths: [...new Set(nonEmpty.map(value => value.length))].sort((a, b) => a - b),
        },
      ]
    }),
  )
}

const sessionPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'oba-live-tool', 'douyin-video-comments-session.json')
  : path.resolve('douyin-video-comments-session.json')

const storageState = await fs
  .readFile(sessionPath, 'utf8')
  .then(value => JSON.parse(value))
  .catch(() => undefined)

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
})

try {
  const context = await browser.newContext({ locale: 'zh-CN', storageState })
  const requestEvidence: Array<{
    kind: 'root' | 'reply'
    cursor: string
    signatureParams: string[]
    parameterNames: string[]
    headerNames: string[]
  }> = []
  const responseEvidence: Array<{
    kind: 'root' | 'reply'
    cursor: string
    httpStatus: number
    statusCode: string
    comments: number
    hasMore: string
    contentType: string
    bodyBytes: number
    challenge: boolean
  }> = []
  const rawCommentIds = {
    root: new Set<string>(),
    reply: new Set<string>(),
  }
  const rawEmptyTextIds = {
    root: new Set<string>(),
    reply: new Set<string>(),
  }
  const rootReplyTotals = new Map<string, number>()
  const paginationParameterValues = {
    root: new Map<string, Set<string>>(),
    reply: new Map<string, Set<string>>(),
  }
  const rawCommentOccurrences = {
    root: 0,
    reply: 0,
  }
  const rawCommentShape = {
    root: { missingId: 0, emptyText: 0, replyTotal: 0 },
    reply: { missingId: 0, emptyText: 0, replyTotal: 0 },
  }
  const emptyTextFieldCounts = {
    root: new Map<string, number>(),
    reply: new Map<string, number>(),
  }
  const emptyTextSamples: Record<'root' | 'reply', Array<Record<string, unknown>>> = {
    root: [],
    reply: [],
  }
  context.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.includes('/aweme/v1/web/comment/list/')) return
    const signatureParams = [
      'a_bogus',
      'msToken',
      'verifyFp',
      'fp',
      'uifid',
      'timestamp',
      'x-secsdk-web-signature',
    ].filter(key => url.searchParams.has(key))
    requestEvidence.push({
      kind: url.pathname.includes('/reply/') ? 'reply' : 'root',
      cursor: url.searchParams.get('cursor') ?? '',
      signatureParams,
      parameterNames: [...url.searchParams.keys()].sort(),
      headerNames: Object.keys(request.headers()).sort(),
    })
    const kind = url.pathname.includes('/reply/') ? 'reply' : 'root'
    for (const key of PAGINATION_PARAMETER_NAMES) {
      if (!url.searchParams.has(key)) continue
      const variants = paginationParameterValues[kind].get(key) ?? new Set<string>()
      variants.add(url.searchParams.get(key) ?? '')
      paginationParameterValues[kind].set(key, variants)
    }
  })
  context.on('response', async response => {
    const url = new URL(response.url())
    if (!url.pathname.includes('/aweme/v1/web/comment/list/')) return
    const responseText = await response.text().catch(() => '')
    const body = (() => {
      try {
        return JSON.parse(responseText)
      } catch {
        return null
      }
    })()
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const comments = Array.isArray(record.comments) ? record.comments.length : 0
    const kind = url.pathname.includes('/reply/') ? 'reply' : 'root'
    if (Array.isArray(record.comments)) {
      for (const item of record.comments) {
        rawCommentOccurrences[kind] += 1
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          rawCommentShape[kind].missingId += 1
          continue
        }
        const comment = item as Record<string, unknown>
        const id = String(comment.cid ?? comment.comment_id ?? comment.commentId ?? '').trim()
        const text = String(comment.text ?? comment.content ?? '').trim()
        if (id) {
          rawCommentIds[kind].add(id)
        } else rawCommentShape[kind].missingId += 1
        if (!text) {
          rawCommentShape[kind].emptyText += 1
          if (id) rawEmptyTextIds[kind].add(id)
          for (const [key, value] of Object.entries(comment)) {
            const populated =
              value !== null &&
              value !== undefined &&
              value !== '' &&
              (!Array.isArray(value) || value.length > 0) &&
              (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)
            if (populated) {
              emptyTextFieldCounts[kind].set(key, (emptyTextFieldCounts[kind].get(key) ?? 0) + 1)
            }
          }
          if (emptyTextSamples[kind].length < 5) {
            emptyTextSamples[kind].push({
              keys: Object.keys(comment).sort(),
              commentType: comment.comment_type ?? null,
              imageCount: Array.isArray(comment.image_list) ? comment.image_list.length : 0,
              stickerCount: Array.isArray(comment.sticker) ? comment.sticker.length : 0,
              hasSticker: Boolean(comment.sticker),
              hasImage: Boolean(comment.image_list),
              hasTextExtra: Boolean(comment.text_extra),
            })
          }
        }
        const replyTotal = Number(
          comment.reply_comment_total ?? comment.replyCommentTotal ?? comment.reply_count ?? 0,
        )
        if (Number.isFinite(replyTotal) && replyTotal > 0) {
          rawCommentShape[kind].replyTotal += Math.trunc(replyTotal)
          if (kind === 'root' && id) {
            rootReplyTotals.set(id, Math.max(rootReplyTotals.get(id) ?? 0, Math.trunc(replyTotal)))
          }
        }
      }
    }
    responseEvidence.push({
      kind,
      cursor: url.searchParams.get('cursor') ?? '',
      httpStatus: response.status(),
      statusCode: String(record.status_code ?? record.statusCode ?? ''),
      comments,
      hasMore: String(record.has_more ?? record.hasMore ?? ''),
      contentType: response.headers()['content-type'] ?? '',
      bodyBytes: new TextEncoder().encode(responseText).length,
      challenge: /captcha|verify|secsdk|argus|\u9a8c\u8bc1/i.test(responseText),
    })
  })
  const loginPage = await context.newPage()
  console.log('请在弹出的抖音窗口完成登录，登录成功后会自动继续采集。')
  const loggedIn = await prepareDouyinLogin(context, loginPage, 300_000)
  if (!loggedIn) throw new Error('等待抖音登录超时')
  await fs.mkdir(path.dirname(sessionPath), { recursive: true })
  await fs.writeFile(sessionPath, JSON.stringify(await context.storageState()), 'utf8')

  let videoUrl = process.argv[2]?.trim()

  if (!videoUrl) {
    const discoveryPage = await context.newPage()
    await discoveryPage.goto('https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F?type=video', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await discoveryPage.waitForTimeout(5000)
    const videoLinks = discoveryPage.locator('a[href*="/video/"]')
    const href = (await videoLinks.count()) ? await videoLinks.first().getAttribute('href') : ''
    videoUrl = href ? new URL(href, discoveryPage.url()).href : ''
    const finalUrl = discoveryPage.url()
    const pageText = await discoveryPage
      .locator('body')
      .innerText()
      .catch(() => '')
    await discoveryPage.close()
    if (!videoUrl) {
      throw new Error(
        `未找到公开视频，搜索页停在 ${finalUrl}：${pageText.slice(0, 160).replaceAll('\n', ' ')}`,
      )
    }
  }

  if (!videoUrl) throw new Error('请把抖音视频链接作为第一个参数传入')

  const collector = new VideoCommentCollector(context, loginPage)
  const requestedMaxPages = Number(process.env.VIDEO_COMMENT_MAX_PAGES ?? 1000)
  const collectionStartedAt = Date.now()
  let progressEvents = 0
  let streamedComments = 0
  let latestProgress: VideoCommentCollectionProgress | null = null
  const result = await collector.collect(
    {
      videoUrl,
      requestId: 'smoke-test',
      maxPages: Number.isFinite(requestedMaxPages) ? requestedMaxPages : 1000,
      maxComments: 100_000,
      interactiveAuthWaitMs: 300_000,
    },
    progress => {
      progressEvents += 1
      streamedComments += progress.comments.length
      latestProgress = progress
    },
  )
  const elapsedMs = Date.now() - collectionStartedAt
  await fs.writeFile(sessionPath, JSON.stringify(await context.storageState()), 'utf8')
  const fullOutput = process.argv.includes('--full')
  const includeEvidence = process.argv.includes('--evidence')
  console.log(
    JSON.stringify(
      fullOutput
        ? result
        : {
            videoId: result.videoId,
            comments: result.comments.length,
            officialCommentCount: result.officialCommentCount,
            unavailableCommentCount: result.unavailableCommentCount,
            rootComments: result.comments.filter(comment => !comment.isReply).length,
            replies: result.comments.filter(comment => comment.isReply).length,
            pagesObserved: result.pagesObserved,
            hasMore: result.hasMore,
            status: result.status,
            elapsedMs,
            commentsPerSecond: result.comments.length / Math.max(elapsedMs / 1000, 0.001),
            progressEvents,
            streamedComments,
            finalProgressPhase:
              (latestProgress as VideoCommentCollectionProgress | null)?.phase ?? null,
            message: result.message,
            rawResponseSummary: {
              root: {
                occurrences: rawCommentOccurrences.root,
                uniqueIds: rawCommentIds.root.size,
                duplicateOccurrences: rawCommentOccurrences.root - rawCommentIds.root.size,
                uniqueEmptyTextIds: rawEmptyTextIds.root.size,
                declaredRepliesAcrossUniqueRoots: [...rootReplyTotals.values()].reduce(
                  (sum, value) => sum + value,
                  0,
                ),
                ...rawCommentShape.root,
              },
              reply: {
                occurrences: rawCommentOccurrences.reply,
                uniqueIds: rawCommentIds.reply.size,
                duplicateOccurrences: rawCommentOccurrences.reply - rawCommentIds.reply.size,
                uniqueEmptyTextIds: rawEmptyTextIds.reply.size,
                ...rawCommentShape.reply,
              },
            },
            paginationParameterSummary: {
              root: summarizeParameterValues(paginationParameterValues.root),
              reply: summarizeParameterValues(paginationParameterValues.reply),
            },
            ...(includeEvidence
              ? {
                  requestEvidence,
                  responseEvidence,
                  emptyTextStructure: {
                    root: {
                      populatedFields: Object.fromEntries(
                        [...emptyTextFieldCounts.root].sort((a, b) => b[1] - a[1]),
                      ),
                      samples: emptyTextSamples.root,
                    },
                    reply: {
                      populatedFields: Object.fromEntries(
                        [...emptyTextFieldCounts.reply].sort((a, b) => b[1] - a[1]),
                      ),
                      samples: emptyTextSamples.reply,
                    },
                  },
                }
              : {
                  requestEvidenceCount: requestEvidence.length,
                  responseEvidenceCount: responseEvidence.length,
                }),
          },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
