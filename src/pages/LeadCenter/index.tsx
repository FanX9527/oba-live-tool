import {
  Archive,
  BrainCircuit,
  Check,
  CheckCircle2,
  Download,
  FileDown,
  FileUp,
  Link2,
  LoaderCircle,
  MessageSquareText,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { TEST_OUTREACH_MESSAGE } from 'shared/outreachPolicy'
import { Title } from '@/components/common/Title'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAccounts } from '@/hooks/useAccounts'
import { useAIProvider } from '@/hooks/useAIProvider'
import { useAutoReply } from '@/hooks/useAutoReply'
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'
import {
  type ConsentStatus,
  type LeadIntent,
  type LeadRecord,
  type OutreachStatus,
  useLeadStore,
} from '@/hooks/useLeadStore'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

const intentLabels: Record<LeadIntent, string> = {
  high_intent: '高意向',
  considering: '观望中',
  knowledgeable: '懂行可沟通',
  engagement: '普通互动',
  irrelevant: '无关',
  unknown: '待分析',
}

const intentClasses: Record<LeadIntent, string> = {
  high_intent: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  considering: 'border-amber-200 bg-amber-50 text-amber-700',
  knowledgeable: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  engagement: 'border-blue-200 bg-blue-50 text-blue-700',
  irrelevant: 'border-slate-200 bg-slate-50 text-slate-600',
  unknown: 'border-border bg-muted text-muted-foreground',
}

const outreachLabels: Record<OutreachStatus, string> = {
  draft: '草稿',
  pending_review: '待确认',
  sent: '已发送',
  skipped: '已跳过',
}

const consentLabels: Record<ConsentStatus, string> = {
  unknown: '未确认',
  opted_in: '已同意联系',
  declined: '拒绝联系',
}

const collectionPhaseLabels: Record<VideoCommentCollectionProgress['phase'], string> = {
  opening: '准备接口',
  root: '读取主评论',
  replies: '读取回复',
  verification: '等待验证',
  complete: '采集结束',
}

const MAX_RENDERED_LEADS = 500
const UNASSIGNED_VIDEO_KEY = '__unassigned_video__'

interface VideoLeadGroup {
  key: string
  videoId: string
  title: string
  sourceUrl: string
  newestAt: number
  leads: LeadRecord[]
}

function getVideoGroupKey(videoId: string) {
  return videoId || UNASSIGNED_VIDEO_KEY
}

function getVideoGroupTitle(group: VideoLeadGroup) {
  if (group.title) return group.title
  return group.videoId ? `视频 ${group.videoId}` : '直播评论 / 未归类'
}

function getVideoIntentSummary(leads: LeadRecord[]) {
  const analyzed = leads.filter(lead => lead.intent !== 'unknown')
  if (analyzed.length === 0) return `待判断 ${leads.length} 条`

  const counts = new Map<LeadIntent, number>()
  for (const lead of analyzed) counts.set(lead.intent, (counts.get(lead.intent) ?? 0) + 1)
  const primary = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
  const pending = leads.length - analyzed.length
  return `${primary ? `${intentLabels[primary]}为主` : '已判断'} · 待判断 ${pending} 条`
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"') {
      current += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  result.push(current)
  return result
}

function parseImportText(text: string): Partial<LeadRecord>[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.leads) ? parsed.leads : []
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map(header => header.trim())
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function csvEscape(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function normalizeIntent(value: unknown): LeadIntent {
  const text = String(value ?? '').toLowerCase()
  if (text.includes('high') || text.includes('高意向')) return 'high_intent'
  if (text.includes('consider') || text.includes('观望')) return 'considering'
  if (text.includes('knowledge') || text.includes('懂行') || text.includes('可沟通')) {
    return 'knowledgeable'
  }
  if (text.includes('engage') || text.includes('互动')) return 'engagement'
  if (text.includes('irrelevant') || text.includes('无关')) return 'irrelevant'
  return 'unknown'
}

function parseAiResult(text: string) {
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) {
    return {
      intent: 'unknown' as const,
      score: null,
      need: '',
      matchedKeywords: [],
      analysisSource: '' as const,
      aiReason: text,
      draftMessage: '',
    }
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const score = Number(parsed.score)
    const rawKeywords = parsed.keywords ?? parsed.matchedKeywords
    return {
      intent: normalizeIntent(parsed.intent ?? parsed.category),
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
      need: String(parsed.need ?? parsed.demand ?? parsed.want ?? ''),
      matchedKeywords: Array.isArray(rawKeywords) ? rawKeywords.map(String).filter(Boolean) : [],
      analysisSource: 'ai' as const,
      aiReason: String(parsed.reason ?? parsed.evidence ?? ''),
      draftMessage: TEST_OUTREACH_MESSAGE,
    }
  } catch {
    return {
      intent: 'unknown' as const,
      score: null,
      need: '',
      matchedKeywords: [],
      analysisSource: '' as const,
      aiReason: text,
      draftMessage: '',
    }
  }
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function getTemplate() {
  return [
    'commentId,parentCommentId,isReply,userId,douyinId,nickname,comment,createdAt,videoId,videoTitle',
    'example-comment-1,,false,公开用户ID,抖音号,示例用户,想了解一下价格,2026-01-01T12:00:00.000Z,example-video,示例视频标题',
  ].join('\n')
}

export default function LeadCenter() {
  const leads = useLeadStore(state => state.leads)
  const ingest = useLeadStore(state => state.importLeads)
  const ingestVideoComments = useLeadStore(state => state.ingestVideoComments)
  const updateLead = useLeadStore(state => state.updateLead)
  const clearLeads = useLeadStore(state => state.clearLeads)
  const { config: aiConfig, apiKeys, customBaseURL } = useAIProvider('chat')
  const { currentAccountId } = useAccounts()
  const { config: replyConfig } = useAutoReplyConfig()
  const { isListening, setIsListening } = useAutoReply()
  const isConnected = useCurrentLiveControl(context => context.isConnected)
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [intentFilter, setIntentFilter] = useState<'all' | LeadIntent>('unknown')
  const [selectedVideoKey, setSelectedVideoKey] = useState('')
  const selectedVideoKeyRef = useRef('')
  const [selectedId, setSelectedId] = useState<string | null>(leads[0]?.id ?? null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set())
  const [videoUrl, setVideoUrl] = useState('')
  const [collectingVideo, setCollectingVideo] = useState(false)
  const [collectionSummary, setCollectionSummary] = useState('')
  const [collectionProgress, setCollectionProgress] =
    useState<VideoCommentCollectionProgress | null>(null)
  const activeCollectionRef = useRef<{ requestId: string; accountId: string } | null>(null)
  const streamedImportedRef = useRef(0)
  const autoStartAttempted = useRef(false)

  const selectVideo = useCallback((key: string) => {
    if (selectedVideoKeyRef.current === key) return
    selectedVideoKeyRef.current = key
    setSelectedVideoKey(key)
    setSelectedId(null)
    setSelectedIds(new Set())
    setSearch('')
  }, [])

  useEffect(
    () =>
      window.ipcRenderer.on(IPC_CHANNELS.tasks.videoComments.progress, progress => {
        const activeCollection = activeCollectionRef.current
        if (!activeCollection || progress.requestId !== activeCollection.requestId) return

        if (progress.comments.length > 0) {
          streamedImportedRef.current += ingestVideoComments(activeCollection.accountId, {
            videoId: progress.videoId,
            videoTitle: progress.videoTitle,
            sourceUrl: progress.sourceUrl,
            finalUrl: progress.sourceUrl,
            comments: progress.comments,
            officialCommentCount: progress.officialCommentCount,
            unavailableCommentCount: progress.unavailableCommentCount,
            pagesObserved: progress.pagesObserved,
            hasMore: null,
            status: 'partial',
            sessionMode: 'standalone',
            message: progress.message,
          })
          if (progress.videoId) selectVideo(getVideoGroupKey(progress.videoId))
        }
        setCollectionProgress(progress)
        setCollectionSummary(
          `${collectionPhaseLabels[progress.phase]} · ${progress.totalComments} 条 · ${progress.commentsPerSecond.toFixed(1)} 条/秒`,
        )
      }),
    [ingestVideoComments, selectVideo],
  )

  const videoGroups = useMemo(() => {
    const groups = new Map<string, VideoLeadGroup>()
    for (const lead of leads) {
      const key = getVideoGroupKey(lead.videoId)
      const existing = groups.get(key)
      if (existing) {
        existing.leads.push(lead)
        existing.title ||= lead.videoTitle
        existing.sourceUrl ||= lead.sourceUrl
        existing.newestAt = Math.max(existing.newestAt, lead.createdAt)
      } else {
        groups.set(key, {
          key,
          videoId: lead.videoId,
          title: lead.videoTitle,
          sourceUrl: lead.sourceUrl,
          newestAt: lead.createdAt,
          leads: [lead],
        })
      }
    }
    return [...groups.values()].sort((left, right) => right.newestAt - left.newestAt)
  }, [leads])

  const activeVideoGroup =
    videoGroups.find(group => group.key === selectedVideoKey) ?? videoGroups[0]
  const activeVideoLeads = activeVideoGroup?.leads ?? []

  useEffect(() => {
    if (videoGroups.length === 0) {
      if (selectedVideoKey) selectVideo('')
      return
    }
    if (!videoGroups.some(group => group.key === selectedVideoKey)) {
      selectVideo(videoGroups[0].key)
    }
  }, [selectedVideoKey, selectVideo, videoGroups])

  const visibleLeads = useMemo(() => {
    const query = search.trim().toLowerCase()
    return activeVideoLeads.filter(lead => {
      const matchesIntent = intentFilter === 'all' || lead.intent === intentFilter
      const matchesSearch =
        !query ||
        [lead.userId, lead.douyinId, lead.nickname, lead.comment].some(value =>
          value.toLowerCase().includes(query),
        )
      return matchesIntent && matchesSearch
    })
  }, [activeVideoLeads, intentFilter, search])
  const displayedLeads = visibleLeads.slice(0, MAX_RENDERED_LEADS)

  const selectedLead = visibleLeads.find(lead => lead.id === selectedId) ?? visibleLeads[0]

  const analyzeLead = async (lead: LeadRecord, notify = true): Promise<boolean> => {
    const apiKey = apiKeys[aiConfig.provider]
    if (!apiKey) {
      if (notify) toast.error('请先在 AI 助手中配置 API Key')
      return false
    }
    setAnalyzingIds(current => new Set(current).add(lead.id))
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.aiChat.normalChat, {
        messages: [
          {
            role: 'system',
            content:
              '你是直播获客线索分析器。阅读用户公开评论的完整语义，不依赖固定关键词，也不推断隐私信息。必须返回 JSON：{"intent":"high_intent|considering|knowledgeable|engagement|irrelevant","score":0到100,"need":"用户想要什么或可沟通主题","keywords":["判断依据词"],"reason":"证据"}。明确需求为 high_intent；主动了解、提问或表现兴趣为 considering；熟悉产品或领域、给出具体经验且适合沟通为 knowledgeable；普通互动为 engagement；无关内容为 irrelevant。不要输出 JSON 以外的内容。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              userId: lead.userId,
              douyinId: lead.douyinId,
              nickname: lead.nickname,
              videoId: lead.videoId,
              videoTitle: lead.videoTitle,
              comment: lead.comment,
              createdAt: formatTime(lead.createdAt),
            }),
          },
        ],
        provider: aiConfig.provider,
        model: aiConfig.model,
        apiKey,
        customBaseURL,
      })
      if (typeof result !== 'string' || !result) throw new Error('AI 没有返回分析结果')
      updateLead(lead.id, { ...parseAiResult(result), analyzedAt: Date.now() })
      if (notify) toast.success('AI 判断完成，已移出待判断队列')
      return true
    } catch (error) {
      if (notify) toast.error(error instanceof Error ? error.message : 'AI 分析失败')
      return false
    } finally {
      setAnalyzingIds(current => {
        const next = new Set(current)
        next.delete(lead.id)
        return next
      })
    }
  }

  const analyzeSelected = async () => {
    if (!apiKeys[aiConfig.provider]) {
      toast.error('请先在 AI 助手中配置 API Key')
      return
    }
    const targets = activeVideoLeads.filter(lead => selectedIds.has(lead.id))
    if (!targets.length) {
      toast.error('请先选择要分析的评论')
      return
    }
    const completed = new Set<string>()
    for (const lead of targets) {
      if (await analyzeLead(lead, false)) completed.add(lead.id)
    }
    setSelectedIds(current => {
      const next = new Set(current)
      for (const id of completed) next.delete(id)
      return next
    })
    setIntentFilter('unknown')
    const failed = targets.length - completed.size
    if (completed.size > 0) {
      toast.success(
        `已判断 ${completed.size} 条并移出待判断队列${failed ? `，${failed} 条失败已保留` : ''}`,
      )
    } else {
      toast.error('本批 AI 判断失败，评论仍保留在待判断队列')
    }
  }

  const collectVideoComments = async () => {
    const sourceUrl = videoUrl.trim()
    if (!sourceUrl) {
      toast.error('请输入抖音视频地址')
      return
    }
    const requestId = crypto.randomUUID()
    const collectionAccountId = currentAccountId || 'public-video'
    const collectionStartedAt = Date.now()
    activeCollectionRef.current = { requestId, accountId: collectionAccountId }
    streamedImportedRef.current = 0
    setCollectionProgress(null)
    setCollectingVideo(true)
    setCollectionSummary(
      '正在读取全部主评论和回复；需要登录或验证时，请在弹出的抖音窗口完成操作，随后会自动续跑。',
    )
    try {
      const result = await window.ipcRenderer.invoke(
        IPC_CHANNELS.tasks.videoComments.collect,
        currentAccountId,
        {
          videoUrl: sourceUrl,
          requestId,
          maxPages: 1000,
          maxComments: 100_000,
          interactiveAuthWaitMs: 300_000,
        },
      )
      const elapsedMs = Math.max(Date.now() - collectionStartedAt, 1)
      const rootComments = result.comments.filter(comment => !comment.isReply).length
      const replies = result.comments.length - rootComments
      setCollectionProgress({
        requestId,
        videoId: result.videoId,
        videoTitle: result.videoTitle,
        sourceUrl: result.sourceUrl,
        phase: 'complete',
        comments: [],
        totalComments: result.comments.length,
        rootComments,
        replies,
        officialCommentCount: result.officialCommentCount,
        unavailableCommentCount: result.unavailableCommentCount,
        pagesObserved: result.pagesObserved,
        elapsedMs,
        commentsPerSecond: result.comments.length / (elapsedMs / 1000),
        message: result.message,
      })
      const imported =
        streamedImportedRef.current + ingestVideoComments(collectionAccountId, result)
      if (result.videoId) selectVideo(getVideoGroupKey(result.videoId))
      const mode = result.sessionMode === 'account' ? '账号登录态' : '独立浏览器'
      setCollectionSummary(`${mode} · 接口读取 ${result.pagesObserved} 页 · ${result.message}`)
      const officialSummary =
        result.officialCommentCount === null
          ? ''
          : `，官方计数 ${result.officialCommentCount} 条，未纳入 ${result.unavailableCommentCount} 条`
      const summary = `读取 ${result.comments.length} 条评论${officialSummary}，新增 ${imported} 条线索`
      if (result.status === 'login_required' || result.status === 'verification_required') {
        toast.error(`${result.message}；${summary}`)
      } else if (result.status === 'empty' || result.status === 'partial') {
        toast.error(result.message)
      } else {
        toast.success(summary)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '视频评论采集失败')
    } finally {
      if (activeCollectionRef.current?.requestId === requestId) {
        activeCollectionRef.current = null
      }
      setCollectingVideo(false)
    }
  }

  const toggleSelected = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startListening = useCallback(async () => {
    if (isConnected !== 'connected') {
      toast.error('请先在中控台连接当前账号')
      return
    }
    try {
      setIsListening('waiting')
      const ok = await window.ipcRenderer.invoke(
        IPC_CHANNELS.tasks.autoReply.startCommentListener,
        currentAccountId,
        {
          source: replyConfig.entry,
          ws: replyConfig.ws?.enable ? { port: replyConfig.ws.port } : undefined,
        },
      )
      if (!ok) throw new Error('监听器启动失败')
      setIsListening('listening')
      toast.success('已开始接收评论事件，线索会自动入库')
    } catch (error) {
      setIsListening('error')
      toast.error(error instanceof Error ? error.message : '监听评论失败')
    }
  }, [currentAccountId, isConnected, replyConfig.entry, replyConfig.ws, setIsListening, toast])

  useEffect(() => {
    if (isConnected === 'connected' && isListening === 'stopped' && !autoStartAttempted.current) {
      autoStartAttempted.current = true
      void startListening()
    }
  }, [isConnected, isListening, startListening])

  const stopListening = async () => {
    await window.ipcRenderer.invoke(
      IPC_CHANNELS.tasks.autoReply.stopCommentListener,
      currentAccountId,
    )
    setIsListening('stopped')
    toast.success('已停止接收评论事件')
  }

  const importFile = async (file: File) => {
    try {
      const imported = ingest(parseImportText(await file.text()))
      toast.success(`已导入 ${imported} 条线索`)
    } catch {
      toast.error('文件格式无法识别，请使用 CSV 或 JSON')
    }
  }

  const exportFilename = activeVideoGroup?.videoId || 'unassigned'
  const exportJson = () =>
    downloadFile(
      `douyin-leads-${exportFilename}.json`,
      JSON.stringify(activeVideoLeads, null, 2),
      'application/json',
    )
  const exportCsv = () => {
    const columns = [
      'commentId',
      'parentCommentId',
      'isReply',
      'userId',
      'douyinId',
      'nickname',
      'comment',
      'createdAt',
      'videoId',
      'videoTitle',
      'intent',
      'score',
      'sourceUrl',
    ]
    const rows = activeVideoLeads.map(lead =>
      columns.map(column => csvEscape(lead[column as keyof LeadRecord])).join(','),
    )
    downloadFile(
      `douyin-leads-${exportFilename}.csv`,
      [columns.join(','), ...rows].join('\n'),
      'text/csv;charset=utf-8',
    )
  }

  return (
    <div className="container py-8 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <Title title="获客线索" description="从已授权的评论数据事件直接结构化，不使用视觉 OCR" />
        <div className="flex items-center gap-2">
          {isListening === 'listening' ? (
            <Button variant="outline" onClick={stopListening}>
              <Pause />
              停止采集
            </Button>
          ) : (
            <Button onClick={startListening} disabled={isListening === 'waiting'}>
              <Play />
              {isListening === 'waiting' ? '连接中...' : '开始采集评论'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            title="导入 CSV 或 JSON"
          >
            <FileUp />
            导入
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,application/json,text/csv"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file) void importFile(file)
              event.target.value = ''
            }}
          />
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-3 md:grid-cols-[16px_minmax(0,1fr)_auto]">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={videoUrl}
              onChange={event => setVideoUrl(event.target.value)}
              placeholder="粘贴抖音公开视频地址"
              onKeyDown={event => {
                if (event.key === 'Enter') void collectVideoComments()
              }}
            />
            <Button
              className="col-start-2 md:col-start-3 md:row-start-1"
              onClick={() => void collectVideoComments()}
              disabled={collectingVideo}
            >
              {collectingVideo && <LoaderCircle className="animate-spin" />}
              {collectingVideo ? '登录验证或采集中...' : '读取全部评论'}
            </Button>
          </div>
          {collectionSummary && (
            <p className="text-xs text-muted-foreground md:pl-7" aria-live="polite">
              {collectionSummary}
            </p>
          )}
          {collectionProgress && (
            <div
              className="grid grid-cols-2 gap-x-6 gap-y-2 border-t pt-3 text-xs md:ml-7 md:grid-cols-4 lg:grid-cols-7"
              data-testid="collection-progress"
            >
              <CollectionStat
                label="阶段"
                value={collectionPhaseLabels[collectionProgress.phase]}
              />
              <CollectionStat
                label="官方计数"
                value={
                  collectionProgress.officialCommentCount === null
                    ? '读取中'
                    : `${collectionProgress.officialCommentCount} 条`
                }
              />
              <CollectionStat label="已读取" value={`${collectionProgress.totalComments} 条`} />
              <CollectionStat
                label="未纳入"
                value={`${collectionProgress.unavailableCommentCount} 条`}
              />
              <CollectionStat
                label="实时均速"
                value={`${collectionProgress.commentsPerSecond.toFixed(1)} 条/秒`}
              />
              <CollectionStat
                label="主评论 / 回复"
                value={`${collectionProgress.rootComments} / ${collectionProgress.replies}`}
              />
              <CollectionStat label="接口页数" value={String(collectionProgress.pagesObserved)} />
            </div>
          )}
        </CardContent>
      </Card>

      {videoGroups.length > 0 && (
        <section className="space-y-2" aria-label="视频分组">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">视频分组</h2>
              <p className="text-xs text-muted-foreground">
                每个视频独立统计和处理，AI 判断成功后自动离开待判断队列。
              </p>
            </div>
            <Badge variant="outline">{videoGroups.length} 个视频</Badge>
          </div>
          <Tabs value={activeVideoGroup?.key} onValueChange={selectVideo}>
            <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto bg-transparent p-0">
              {videoGroups.map(group => (
                <TabsTrigger
                  key={group.key}
                  value={group.key}
                  className="h-auto min-w-60 max-w-80 flex-none justify-start border bg-background px-3 py-2 text-left whitespace-normal data-[state=active]:border-primary"
                  data-testid={`video-group-${group.videoId || 'unassigned'}`}
                >
                  <Video className="size-4 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate" title={getVideoGroupTitle(group)}>
                      {getVideoGroupTitle(group)}
                    </span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {group.leads.length} 条 · {getVideoIntentSummary(group.leads)}
                    </span>
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </section>
      )}

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="本视频评论"
          value={activeVideoLeads.length}
          icon={<MessageSquareText />}
        />
        <MetricCard
          label="高意向"
          value={activeVideoLeads.filter(lead => lead.intent === 'high_intent').length}
          icon={<Sparkles />}
        />
        <MetricCard
          label="待 AI 筛选"
          value={activeVideoLeads.filter(lead => lead.intent === 'unknown').length}
          icon={<BrainCircuit />}
        />
        <MetricCard
          label="已补全用户 ID"
          value={activeVideoLeads.filter(lead => lead.userId || lead.douyinId).length}
          icon={<UserRound />}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>
                {activeVideoGroup ? getVideoGroupTitle(activeVideoGroup) : '评论数据流'}
              </CardTitle>
              <CardDescription>
                {activeVideoGroup?.videoId
                  ? `视频 ID ${activeVideoGroup.videoId} · 用户信息和 AI 结果按本视频独立保存。`
                  : '用户 ID、抖音号和原始评论按条保存；缺失字段显示为未提供。'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  downloadFile('douyin-leads-template.csv', getTemplate(), 'text/csv;charset=utf-8')
                }
              >
                <Download />
                下载模板
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={exportCsv}
                disabled={!activeVideoLeads.length}
                title="导出当前视频"
              >
                <FileDown />
                CSV
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={exportJson}
                disabled={!activeVideoLeads.length}
                title="导出当前视频"
              >
                <Archive />
                JSON
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={clearLeads}
                disabled={!leads.length}
                title="清空所有视频的线索"
              >
                <Trash2 />
                清空全部
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="搜索用户 ID、抖音号、昵称或评论"
              />
            </div>
            <Select
              value={intentFilter}
              onValueChange={value => setIntentFilter(value as typeof intentFilter)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部 AI 类型</SelectItem>
                {(Object.keys(intentLabels) as LeadIntent[]).map(intent => (
                  <SelectItem key={intent} value={intent}>
                    {intentLabels[intent]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={analyzeSelected}
              disabled={!selectedIds.size || analyzingIds.size > 0}
            >
              <BrainCircuit />
              批量 AI 判断 ({selectedIds.size})
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="p-0">
          <div className="grid grid-cols-[36px_150px_150px_1fr_100px_100px] gap-3 px-4 py-2 text-xs text-muted-foreground border-b bg-muted/30">
            <span>
              <input
                type="checkbox"
                aria-label="选择全部"
                checked={
                  visibleLeads.length > 0 && visibleLeads.every(lead => selectedIds.has(lead.id))
                }
                onChange={event =>
                  setSelectedIds(
                    event.target.checked ? new Set(visibleLeads.map(lead => lead.id)) : new Set(),
                  )
                }
              />
            </span>
            <span>用户 ID</span>
            <span>抖音号</span>
            <span>评论内容</span>
            <span>AI 意向</span>
            <span>状态</span>
          </div>
          <ScrollArea className="h-[360px]">
            {visibleLeads.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                {activeVideoLeads.length === 0
                  ? '暂无评论线索，点击“开始采集评论”或导入文件。'
                  : '当前队列为空，可切换 AI 类型查看已判断结果。'}
              </div>
            ) : (
              displayedLeads.map(lead => (
                <button
                  type="button"
                  key={lead.id}
                  onClick={() => setSelectedId(lead.id)}
                  className={cn(
                    'grid w-full grid-cols-[36px_150px_150px_1fr_100px_100px] items-center gap-3 border-b px-4 py-3 text-left hover:bg-muted/40',
                    selectedLead?.id === lead.id && 'bg-primary/5',
                  )}
                >
                  <span>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${lead.nickname || lead.commentId}`}
                      checked={selectedIds.has(lead.id)}
                      onClick={event => event.stopPropagation()}
                      onChange={() => toggleSelected(lead.id)}
                    />
                  </span>
                  <span className="truncate text-sm" title={lead.userId}>
                    {lead.userId || '未提供'}
                  </span>
                  <span className="truncate text-sm" title={lead.douyinId}>
                    {lead.douyinId || '未提供'}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      {lead.isReply && (
                        <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                          回复
                        </Badge>
                      )}
                      <span className="truncate">{lead.comment}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {lead.nickname || '未知用户'} · {formatTime(lead.createdAt)}
                    </span>
                  </span>
                  <Badge variant="outline" className={cn('w-fit', intentClasses[lead.intent])}>
                    {intentLabels[lead.intent]}
                    {lead.score === null ? '' : ` ${lead.score}`}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {outreachLabels[lead.outreachStatus]}
                  </span>
                </button>
              ))
            )}
          </ScrollArea>
          {visibleLeads.length > displayedLeads.length && (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              当前显示前 {displayedLeads.length} 条，搜索和全选仍覆盖全部 {visibleLeads.length}{' '}
              条结果。
            </div>
          )}
        </CardContent>
      </Card>

      {selectedLead && (
        <LeadDetail
          lead={selectedLead}
          analyzing={analyzingIds.has(selectedLead.id)}
          onAnalyze={() => void analyzeLead(selectedLead)}
          onUpdate={patch => updateLead(selectedLead.id, patch)}
        />
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
          私信默认只生成草稿并进入人工确认；不会无确认批量发送。
        </span>
        <span>监听状态：{isListening === 'listening' ? '接收中' : '未接收'}</span>
      </div>
    </div>
  )
}

function CollectionStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-muted-foreground">{label}</span>
      <span className="mt-0.5 block truncate font-medium text-foreground" title={value}>
        {value}
      </span>
    </div>
  )
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string
  value: number
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold">{value}</p>
        </div>
        <div className="rounded-md bg-primary/10 p-2 text-primary">{icon}</div>
      </CardContent>
    </Card>
  )
}

function LeadDetail({
  lead,
  analyzing,
  onAnalyze,
  onUpdate,
}: {
  lead: LeadRecord
  analyzing: boolean
  onAnalyze: () => void
  onUpdate: (patch: Partial<LeadRecord>) => void
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>线索详情</CardTitle>
            <CardDescription>
              {formatTime(lead.createdAt)} · 来源：
              {lead.source === 'live-comment' ? '评论事件' : '文件导入'}
            </CardDescription>
          </div>
          <Button onClick={onAnalyze} disabled={analyzing}>
            <BrainCircuit />
            {analyzing ? '分析中...' : lead.analyzedAt ? '重新分析' : 'AI 分析'}
          </Button>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="grid grid-cols-[1fr_1fr] gap-5 p-5">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="用户 ID" value={lead.userId || '未提供'} />
            <Field label="抖音号" value={lead.douyinId || '未提供'} />
            <Field label="昵称" value={lead.nickname || '未提供'} />
            <Field label="评论 ID" value={lead.commentId} />
          </div>
          <div>
            <Label>原始评论</Label>
            <div className="mt-1 rounded-md border bg-muted/30 p-3 text-sm leading-6">
              {lead.comment}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={intentClasses[lead.intent]}>
              {intentLabels[lead.intent]}
              {lead.score === null ? '' : ` · ${lead.score}分`}
            </Badge>
            <Badge variant="outline">联系：{consentLabels[lead.consentStatus]}</Badge>
            <Badge variant="outline">{outreachLabels[lead.outreachStatus]}</Badge>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <Label>AI 分析依据</Label>
            <div className="mt-1 min-h-20 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              {lead.aiReason || '点击 AI 分析生成意向判断和依据。'}
            </div>
          </div>
          <div>
            <Label htmlFor="draft-message">私信草稿</Label>
            <Textarea
              id="draft-message"
              className="mt-1 min-h-28"
              value={lead.draftMessage}
              onChange={event => onUpdate({ draftMessage: event.target.value })}
              placeholder="AI 生成的草稿会出现在这里，发送前请人工检查。"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => onUpdate({ outreachStatus: 'pending_review' })}
              disabled={!lead.draftMessage}
            >
              <CheckCircle2 />
              加入人工确认
            </Button>
            <Button variant="outline" onClick={() => onUpdate({ consentStatus: 'opted_in' })}>
              <Check />
              标记已同意
            </Button>
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => onUpdate({ consentStatus: 'declined', outreachStatus: 'skipped' })}
            >
              <X />
              拒绝联系
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 truncate rounded-md border px-3 py-2 text-sm" title={value}>
        {value}
      </div>
    </div>
  )
}
