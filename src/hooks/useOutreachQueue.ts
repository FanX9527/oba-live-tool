import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { AnalysisSource, LeadIntent } from './useLeadStore'

export type OutreachTaskStatus =
  | 'pending_review'
  | 'ready'
  | 'assigned'
  | 'preparing'
  | 'awaiting_confirmation'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'

export interface OutreachTask {
  id: string
  leadIds: string[]
  accountId: string
  videoId: string
  videoTitle: string
  userId: string
  douyinId: string
  nickname: string
  comments: string[]
  intent: LeadIntent
  score: number | null
  need: string
  analysisSource: AnalysisSource
  aiReason: string
  draftMessage: string
  status: OutreachTaskStatus
  deviceSerial: string
  attemptCount: number
  lastError: string
  createdAt: number
  updatedAt: number
  sentAt: number | null
}

export type OutreachTaskInput = Omit<
  OutreachTask,
  'status' | 'deviceSerial' | 'attemptCount' | 'lastError' | 'createdAt' | 'updatedAt' | 'sentAt'
>

interface EnqueueResult {
  added: number
  updated: number
}

interface OutreachQueueStore {
  tasks: OutreachTask[]
  enqueueTasks: (tasks: OutreachTaskInput[]) => EnqueueResult
  updateTask: (id: string, patch: Partial<OutreachTask>) => void
  updateTasks: (ids: string[], patch: Partial<OutreachTask>) => void
  removeTasks: (ids: string[]) => void
  clearCompleted: () => void
}

export const useOutreachQueueStore = create<OutreachQueueStore>()(
  persist(
    immer(set => ({
      tasks: [],
      enqueueTasks: inputs => {
        let added = 0
        let updated = 0
        const now = Date.now()
        set(state => {
          const existingById = new Map(state.tasks.map(task => [task.id, task]))
          for (const input of inputs) {
            const existing = existingById.get(input.id)
            if (existing) {
              existing.leadIds = input.leadIds
              existing.accountId = input.accountId
              existing.videoId = input.videoId
              existing.videoTitle = input.videoTitle
              existing.userId = input.userId
              existing.douyinId = input.douyinId
              existing.nickname = input.nickname
              existing.comments = input.comments
              existing.intent = input.intent
              existing.score = input.score
              existing.need = input.need
              existing.analysisSource = input.analysisSource
              existing.aiReason = input.aiReason
              if (!existing.draftMessage) existing.draftMessage = input.draftMessage
              existing.updatedAt = now
              updated += 1
              continue
            }
            const task: OutreachTask = {
              ...input,
              status: 'pending_review',
              deviceSerial: '',
              attemptCount: 0,
              lastError: '',
              createdAt: now,
              updatedAt: now,
              sentAt: null,
            }
            state.tasks.unshift(task)
            existingById.set(task.id, task)
            added += 1
          }
        })
        return { added, updated }
      },
      updateTask: (id, patch) =>
        set(state => {
          const task = state.tasks.find(item => item.id === id)
          if (task) Object.assign(task, patch, { updatedAt: Date.now() })
        }),
      updateTasks: (ids, patch) =>
        set(state => {
          const selected = new Set(ids)
          const now = Date.now()
          for (const task of state.tasks) {
            if (selected.has(task.id)) Object.assign(task, patch, { updatedAt: now })
          }
        }),
      removeTasks: ids =>
        set(state => {
          const selected = new Set(ids)
          state.tasks = state.tasks.filter(task => !selected.has(task.id))
        }),
      clearCompleted: () =>
        set(state => {
          state.tasks = state.tasks.filter(
            task => task.status !== 'sent' && task.status !== 'skipped',
          )
        }),
    })),
    {
      name: 'outreach-queue-storage',
      version: 1,
      partialize: state => ({ tasks: state.tasks }),
    },
  ),
)

export function usePendingOutreachCount() {
  return useOutreachQueueStore(
    state => state.tasks.filter(task => task.status !== 'sent' && task.status !== 'skipped').length,
  )
}
