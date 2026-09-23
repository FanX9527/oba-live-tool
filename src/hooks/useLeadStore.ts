import { hasNormalCommentText } from 'shared/commentText'
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

const MAX_STORED_LEADS = 100_000
const LEAD_DATABASE_NAME = 'oba-live-tool-leads'
const LEAD_DATABASE_STORE = 'state'
const pendingLeadWrites = new Map<string, string | null>()
let leadWriteTimer: ReturnType<typeof setTimeout> | null = null

function openLeadDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEAD_DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEAD_DATABASE_STORE)) {
        request.result.createObjectStore(LEAD_DATABASE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readLeadState(name: string): Promise<string | null> {
  const database = await openLeadDatabase()
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(LEAD_DATABASE_STORE)
      .objectStore(LEAD_DATABASE_STORE)
      .get(name)
    request.onsuccess = () => {
      database.close()
      resolve(typeof request.result === 'string' ? request.result : null)
    }
    request.onerror = () => {
      database.close()
      reject(request.error)
    }
  })
}

async function writeLeadState(name: string, value: string | null) {
  const database = await openLeadDatabase()
  return new Promise<void>((resolve, reject) => {
    const store = database
      .transaction(LEAD_DATABASE_STORE, 'readwrite')
      .objectStore(LEAD_DATABASE_STORE)
    const request = value === null ? store.delete(name) : store.put(value, name)
    request.onsuccess = () => {
      database.close()
      resolve()
    }
    request.onerror = () => {
      database.close()
      reject(request.error)
    }
  })
}

async function flushLeadWrites() {
  const entries = [...pendingLeadWrites]
  pendingLeadWrites.clear()
  leadWriteTimer = null
  await Promise.all(entries.map(([name, value]) => writeLeadState(name, value)))
}

function scheduleLeadWrite(name: string, value: string | null) {
  pendingLeadWrites.set(name, value)
  if (leadWriteTimer) clearTimeout(leadWriteTimer)
  leadWriteTimer = setTimeout(() => {
    void flushLeadWrites()
  }, 750)
}

const leadStorage: StateStorage = {
  getItem: async name => {
    if (pendingLeadWrites.has(name)) return pendingLeadWrites.get(name) ?? null
    try {
      const stored = await readLeadState(name)
      if (stored !== null) return stored
      const legacy = localStorage.getItem(name)
      if (legacy !== null) await writeLeadState(name, legacy)
      return legacy
    } catch {
      return localStorage.getItem(name)
    }
  },
  setItem: (name, value) => {
    scheduleLeadWrite(name, value)
  },
  removeItem: name => {
    scheduleLeadWrite(name, null)
  },
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && pendingLeadWrites.size > 0) void flushLeadWrites()
})

export type LeadIntent =
  | 'high_intent'
  | 'considering'
  | 'knowledgeable'
  | 'engagement'
  | 'irrelevant'
  | 'unknown'
export type ConsentStatus = 'unknown' | 'opted_in' | 'declined'
export type OutreachStatus = 'draft' | 'pending_review' | 'sent' | 'skipped'
export type AnalysisSource = '' | 'keyword' | 'ai'

export interface LeadRecord {
  id: string
  accountId: string
  videoId: string
  videoTitle: string
  commentId: string
  parentCommentId: string
  isReply: boolean
  userId: string
  douyinId: string
  nickname: string
  comment: string
  createdAt: number
  sourceUrl: string
  source: 'live-comment' | 'video-comment' | 'import'
  intent: LeadIntent
  score: number | null
  need: string
  matchedKeywords: string[]
  analysisSource: AnalysisSource
  aiReason: string
  draftMessage: string
  consentStatus: ConsentStatus
  outreachStatus: OutreachStatus
  analyzedAt: number | null
}

interface LeadStore {
  leads: LeadRecord[]
  ingestLiveMessage: (accountId: string, message: LiveMessage) => void
  ingestVideoComments: (accountId: string, result: VideoCommentCollectionResult) => number
  importLeads: (records: Partial<LeadRecord>[]) => number
  updateLead: (id: string, patch: Partial<LeadRecord>) => void
  updateLeads: (updates: Array<{ ids: string[]; patch: Partial<LeadRecord> }>) => void
  clearLeads: () => void
}

const commentTypes = new Set([
  'comment',
  'wechat_channel_live_msg',
  'xiaohongshu_comment',
  'taobao_comment',
])

function getOptionalString(message: LiveMessage, key: string): string {
  const value = (message as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function createLeadId(accountId: string, commentId: string) {
  return `${accountId}:${commentId}`
}

function makeLead(
  accountId: string,
  message: LiveMessage,
  source: LeadRecord['source'],
): LeadRecord | null {
  const comment = getOptionalString(message, 'content')
  if (!commentTypes.has(message.msg_type) || !comment || !message.msg_id) return null

  return {
    id: createLeadId(accountId, message.msg_id),
    accountId,
    videoId: getOptionalString(message, 'video_id') || getOptionalString(message, 'room_id'),
    videoTitle: getOptionalString(message, 'video_title'),
    commentId: message.msg_id,
    parentCommentId: '',
    isReply: false,
    userId: getOptionalString(message, 'user_id'),
    douyinId:
      getOptionalString(message, 'douyin_id') ||
      getOptionalString(message, 'display_id') ||
      getOptionalString(message, 'short_id'),
    nickname: message.nick_name || '',
    comment,
    createdAt: message.time || Date.now(),
    sourceUrl: getOptionalString(message, 'source_url'),
    source,
    intent: 'unknown',
    score: null,
    need: '',
    matchedKeywords: [],
    analysisSource: '',
    aiReason: '',
    draftMessage: '',
    consentStatus: 'unknown',
    outreachStatus: 'draft',
    analyzedAt: null,
  }
}

function normalizeImportedRecord(record: Partial<LeadRecord>, index: number): LeadRecord | null {
  const comment = String(record.comment ?? '').trim()
  if (!hasNormalCommentText(comment)) return null
  const accountId = String(record.accountId ?? 'imported')
  const commentId = String(record.commentId ?? `import-${Date.now()}-${index}`)
  return {
    id: String(record.id ?? createLeadId(accountId, commentId)),
    accountId,
    videoId: String(record.videoId ?? ''),
    videoTitle: String(record.videoTitle ?? ''),
    commentId,
    parentCommentId: String(record.parentCommentId ?? ''),
    isReply: Boolean(record.isReply),
    userId: String(record.userId ?? ''),
    douyinId: String(record.douyinId ?? ''),
    nickname: String(record.nickname ?? ''),
    comment,
    createdAt: Number(record.createdAt ?? Date.now()),
    sourceUrl: String(record.sourceUrl ?? ''),
    source: 'import',
    intent: record.intent ?? 'unknown',
    score: typeof record.score === 'number' ? record.score : null,
    need: String(record.need ?? ''),
    matchedKeywords: Array.isArray(record.matchedKeywords)
      ? record.matchedKeywords.map(String)
      : [],
    analysisSource:
      record.analysisSource === 'keyword' || record.analysisSource === 'ai'
        ? record.analysisSource
        : typeof record.analyzedAt === 'number'
          ? 'ai'
          : '',
    aiReason: String(record.aiReason ?? ''),
    draftMessage: String(record.draftMessage ?? ''),
    consentStatus: record.consentStatus ?? 'unknown',
    outreachStatus: record.outreachStatus ?? 'draft',
    analyzedAt: typeof record.analyzedAt === 'number' ? record.analyzedAt : null,
  }
}

export const useLeadStore = create<LeadStore>()(
  persist(
    immer(set => ({
      leads: [],
      ingestLiveMessage: (accountId, message) => {
        const lead = makeLead(accountId, message, 'live-comment')
        if (!lead) return
        set(state => {
          const existing = state.leads.find(item => item.id === lead.id)
          if (existing) {
            existing.userId ||= lead.userId
            existing.douyinId ||= lead.douyinId
            existing.nickname ||= lead.nickname
            return
          }
          state.leads.unshift(lead)
          state.leads = state.leads.slice(0, MAX_STORED_LEADS)
        })
      },
      ingestVideoComments: (accountId, result) => {
        let imported = 0
        set(state => {
          const existingById = new Map(state.leads.map(item => [item.id, item]))
          const newLeads: LeadRecord[] = []
          for (const comment of result.comments) {
            if (!comment.commentId || !hasNormalCommentText(comment.comment)) continue
            const id = createLeadId(accountId, comment.commentId)
            const existing = existingById.get(id)
            if (existing) {
              existing.userId ||= comment.userId
              existing.douyinId ||= comment.douyinId
              existing.nickname ||= comment.nickname
              existing.videoId ||= comment.videoId
              existing.videoTitle ||= result.videoTitle
              existing.sourceUrl ||= comment.sourceUrl
              continue
            }
            const lead: LeadRecord = {
              id,
              accountId,
              videoId: comment.videoId,
              videoTitle: result.videoTitle,
              commentId: comment.commentId,
              parentCommentId: comment.parentCommentId,
              isReply: comment.isReply,
              userId: comment.userId,
              douyinId: comment.douyinId,
              nickname: comment.nickname,
              comment: comment.comment,
              createdAt: comment.createdAt || Date.now(),
              sourceUrl: comment.sourceUrl || result.sourceUrl,
              source: 'video-comment',
              intent: 'unknown',
              score: null,
              need: '',
              matchedKeywords: [],
              analysisSource: '',
              aiReason: '',
              draftMessage: '',
              consentStatus: 'unknown',
              outreachStatus: 'draft',
              analyzedAt: null,
            }
            newLeads.push(lead)
            existingById.set(id, lead)
            imported += 1
          }
          state.leads.unshift(...newLeads.reverse())
          state.leads = state.leads.slice(0, MAX_STORED_LEADS)
        })
        return imported
      },
      importLeads: records => {
        let imported = 0
        set(state => {
          const known = new Set(state.leads.map(item => item.id))
          for (const [index, record] of records.entries()) {
            const lead = normalizeImportedRecord(record, index)
            if (!lead || known.has(lead.id)) continue
            state.leads.unshift(lead)
            known.add(lead.id)
            imported += 1
          }
          state.leads = state.leads.slice(0, MAX_STORED_LEADS)
        })
        return imported
      },
      updateLead: (id, patch) =>
        set(state => {
          const lead = state.leads.find(item => item.id === id)
          if (lead) Object.assign(lead, patch)
        }),
      updateLeads: updates =>
        set(state => {
          const patches = new Map<string, Partial<LeadRecord>>()
          for (const update of updates) {
            for (const id of update.ids) patches.set(id, update.patch)
          }
          for (const lead of state.leads) {
            const patch = patches.get(lead.id)
            if (patch) Object.assign(lead, patch)
          }
        }),
      clearLeads: () => set({ leads: [] }),
    })),
    {
      name: 'lead-center-storage',
      storage: createJSONStorage(() => leadStorage),
      partialize: state => ({ leads: state.leads }),
      version: 4,
      migrate: persistedState => {
        const state = persistedState as { leads?: LeadRecord[] }
        return {
          ...state,
          leads: Array.isArray(state.leads)
            ? state.leads
                .filter(lead => hasNormalCommentText(lead.comment))
                .map(lead => ({
                  ...lead,
                  videoTitle: String(lead.videoTitle ?? ''),
                  need: String(lead.need ?? ''),
                  matchedKeywords: Array.isArray(lead.matchedKeywords)
                    ? lead.matchedKeywords.map(String)
                    : [],
                  analysisSource:
                    lead.analysisSource === 'keyword' || lead.analysisSource === 'ai'
                      ? lead.analysisSource
                      : typeof lead.analyzedAt === 'number'
                        ? 'ai'
                        : '',
                }))
            : [],
        }
      },
    },
  ),
)

export function useLeadCount() {
  return useLeadStore(state => state.leads.length)
}
