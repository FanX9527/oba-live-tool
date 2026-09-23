import { chromium } from 'playwright'

const DEVICE_SERIAL = '5efba685'
const LIMIT = 10

const shouldSend = process.argv.includes('--send')

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser
  .contexts()
  .flatMap(context => context.pages())
  .find(candidate => candidate.url().startsWith('http://localhost:5173/'))

if (!page) throw new Error('未找到正在运行的 OBA 项目页面')

const targets = await page.evaluate(
  async ({ serial, limit, send }) => {
    const { useLeadStore } = await import('/src/hooks/useLeadStore.ts')
    const { useOutreachQueueStore } = await import('/src/hooks/useOutreachQueue.ts')
    const leadStore = useLeadStore.getState()
    const queueStore = useOutreachQueueStore.getState()
    const rejected = queueStore.tasks.filter(task =>
      /仅他关注的人可发消息|仅关注的人可发消息|暂无法给对方发送消息|暂不接受陌生人私信|目标用户主页未开放私信入口/.test(
        task.lastError,
      ),
    )
    if (send && rejected.length) {
      leadStore.updateLeads(
        rejected.map(task => ({ ids: task.leadIds, patch: { outreachStatus: 'skipped' } })),
      )
      queueStore.removeTasks(rejected.map(task => task.id))
    }

    const recipientKey = lead => (lead.userId || lead.douyinId || lead.nickname).toLowerCase()
    const existing = new Set(useOutreachQueueStore.getState().tasks.map(task => recipientKey(task)))
    for (const lead of useLeadStore.getState().leads) {
      if (lead.outreachStatus === 'sent') existing.add(recipientKey(lead))
    }
    const groups = new Map()
    for (const lead of useLeadStore.getState().leads) {
      if (!['high_intent', 'considering', 'knowledgeable'].includes(lead.intent)) continue
      if (lead.analysisSource !== 'ai') continue
      if (['sent', 'skipped'].includes(lead.outreachStatus)) continue
      if (lead.consentStatus === 'declined') continue
      const identity = lead.userId || lead.douyinId || lead.nickname || lead.commentId
      const id = `${lead.videoId || '__unassigned_video__'}:${identity}`
      const key = recipientKey(lead)
      if (existing.has(key)) continue
      const group = groups.get(key)
      if (group) group.leads.push(lead)
      else groups.set(key, { id, leads: [lead] })
    }

    const picked = [...groups.values()]
      .sort((left, right) => {
        const score = group => Math.max(...group.leads.map(lead => lead.score ?? 0))
        const numeric = group => Number(/^\d+$/.test(group.leads[0].douyinId))
        return numeric(right) - numeric(left) || score(right) - score(left)
      })
      .slice(0, limit)
      .map(group => {
        const lead = group.leads[0]
        return {
          id: group.id,
          leadIds: group.leads.map(item => item.id),
          accountId: lead.accountId,
          videoId: lead.videoId,
          videoTitle: lead.videoTitle,
          userId: lead.userId,
          douyinId: lead.douyinId,
          nickname: lead.nickname,
          comments: group.leads.map(item => item.comment),
          intent: lead.intent,
          score: lead.score,
          need: lead.need,
          analysisSource: lead.analysisSource,
          aiReason: lead.aiReason,
          draftMessage: '1',
        }
      })

    if (send && picked.length < limit) {
      throw new Error(`已筛选且未联系的用户只有 ${picked.length} 位，无法测试 ${limit} 位`)
    }

    if (send) {
      queueStore.enqueueTasks(picked)
      queueStore.updateTasks(
        picked.map(task => task.id),
        { status: 'assigned', deviceSerial: serial, draftMessage: '1' },
      )
      leadStore.updateLeads(
        picked.map(task => ({ ids: task.leadIds, patch: { outreachStatus: 'pending_review' } })),
      )
    }
    return picked.map(({ id, leadIds, userId, douyinId, nickname }) => ({
      id,
      leadIds,
      userId,
      douyinId,
      nickname,
    }))
  },
  { serial: DEVICE_SERIAL, limit: LIMIT, send: shouldSend },
)

console.log(
  JSON.stringify({ selected: targets.length, serial: DEVICE_SERIAL, send: shouldSend, targets }),
)
if (!shouldSend) {
  await browser.close()
  process.exit(0)
}
if (targets.length < LIMIT) {
  console.log('可用的已筛选用户不足 10 位，只处理现有目标')
}

async function record(task, result) {
  await page.evaluate(
    async ({ task, result }) => {
      const { useLeadStore } = await import('/src/hooks/useLeadStore.ts')
      const { useOutreachQueueStore } = await import('/src/hooks/useOutreachQueue.ts')
      const queue = useOutreachQueueStore.getState()
      const leads = useLeadStore.getState()
      if (!result.ok && result.rejected) {
        leads.updateLeads([{ ids: task.leadIds, patch: { outreachStatus: 'skipped' } }])
        queue.removeTasks([task.id])
      } else if (!result.ok) {
        queue.updateTask(task.id, { status: 'failed', lastError: result.message })
      } else {
        queue.updateTask(task.id, { status: 'sent', sentAt: Date.now(), lastError: '' })
        leads.updateLeads([{ ids: task.leadIds, patch: { outreachStatus: 'sent' } }])
      }
    },
    { task, result },
  )
}

const outcomes = []
for (const [index, task] of targets.entries()) {
  console.log(JSON.stringify({ number: index + 1, user: task.nickname, stage: 'prepare' }))
  try {
    const prepared = await page.evaluate(
      async ({ task, serial }) => {
        const { useOutreachQueueStore } = await import('/src/hooks/useOutreachQueue.ts')
        useOutreachQueueStore.getState().updateTask(task.id, {
          status: 'preparing',
          attemptCount: 1,
          lastError: '',
        })
        return window.ipcRenderer.invoke('device:prepareOutreach', serial, {
          taskId: task.id,
          userId: task.userId,
          douyinId: task.douyinId,
          nickname: task.nickname,
          draftMessage: '1',
        })
      },
      { task, serial: DEVICE_SERIAL },
    )
    if (!prepared.ok) {
      const rejected =
        /仅他关注的人可发消息|仅关注的人可发消息|暂无法给对方发送消息|暂不接受陌生人私信|目标用户主页未开放私信入口/.test(
          prepared.message,
        )
      const result = { ok: false, rejected, message: prepared.message }
      await record(task, result)
      outcomes.push({ number: index + 1, user: task.nickname, ...result })
      console.log(JSON.stringify(outcomes.at(-1)))
      continue
    }

    const recipientMatches = await page.evaluate(
      async ({ task, serial }) => {
        const snapshot = await window.ipcRenderer.invoke('device:dumpUi', serial)
        return snapshot.nodes.some(
          node =>
            node.className.endsWith('TextView') &&
            node.bounds?.top < 250 &&
            node.text.trim() === task.nickname,
        )
      },
      { task, serial: DEVICE_SERIAL },
    )
    if (!recipientMatches) {
      const result = { ok: false, rejected: false, message: '私信页昵称与目标不一致，未发送' }
      await record(task, result)
      outcomes.push({ number: index + 1, user: task.nickname, ...result })
      console.log(JSON.stringify(outcomes.at(-1)))
      break
    }

    await page.evaluate(async id => {
      const { useOutreachQueueStore } = await import('/src/hooks/useOutreachQueue.ts')
      useOutreachQueueStore.getState().updateTask(id, { status: 'sending' })
    }, task.id)
    const sent = await page.evaluate(
      ({ task, serial }) => window.ipcRenderer.invoke('device:confirmOutreach', serial, task.id),
      { task, serial: DEVICE_SERIAL },
    )
    const result = {
      ok: sent.ok,
      rejected:
        !sent.ok &&
        /仅他关注的人可发消息|仅关注的人可发消息|暂无法给对方发送消息|暂不接受陌生人私信|目标用户主页未开放私信入口/.test(
          sent.message,
        ),
      message: sent.message,
    }
    await record(task, result)
    outcomes.push({ number: index + 1, user: task.nickname, ...result })
    console.log(JSON.stringify(outcomes.at(-1)))
  } catch (error) {
    const result = {
      ok: false,
      rejected: false,
      message: error instanceof Error ? error.message : String(error),
    }
    await record(task, result)
    outcomes.push({ number: index + 1, user: task.nickname, ...result })
    console.log(JSON.stringify(outcomes.at(-1)))
    break
  }
}

console.log(
  JSON.stringify({
    attempted: outcomes.length,
    sent: outcomes.filter(x => x.ok).length,
    rejected: outcomes.filter(x => x.rejected).length,
    failed: outcomes.filter(x => !x.ok && !x.rejected).length,
  }),
)
await browser.close()
