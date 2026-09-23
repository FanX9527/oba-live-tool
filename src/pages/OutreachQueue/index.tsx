import {
  ClipboardCheck,
  LoaderCircle,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { getOutreachFailureAction, TEST_OUTREACH_MESSAGE } from 'shared/outreachPolicy'
import { Title } from '@/components/common/Title'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLeadStore } from '@/hooks/useLeadStore'
import {
  type OutreachTask,
  type OutreachTaskStatus,
  useOutreachQueueStore,
} from '@/hooks/useOutreachQueue'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

const statusLabels: Record<OutreachTaskStatus, string> = {
  pending_review: '待审核',
  ready: '已确认',
  assigned: '已分配设备',
  preparing: '真机准备中',
  awaiting_confirmation: '待确认发送',
  sending: '发送中',
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
}

const statusClasses: Record<OutreachTaskStatus, string> = {
  pending_review: 'border-amber-200 bg-amber-50 text-amber-700',
  ready: 'border-blue-200 bg-blue-50 text-blue-700',
  assigned: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  preparing: 'border-violet-200 bg-violet-50 text-violet-700',
  awaiting_confirmation: 'border-orange-200 bg-orange-50 text-orange-700',
  sending: 'border-violet-200 bg-violet-50 text-violet-700',
  sent: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  skipped: 'border-slate-200 bg-slate-50 text-slate-600',
}

function deviceLabel(device: AndroidDevice) {
  return [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial
}

export default function OutreachQueue() {
  const tasks = useOutreachQueueStore(state => state.tasks)
  const updateTask = useOutreachQueueStore(state => state.updateTask)
  const updateTasks = useOutreachQueueStore(state => state.updateTasks)
  const removeTasks = useOutreachQueueStore(state => state.removeTasks)
  const clearCompleted = useOutreachQueueStore(state => state.clearCompleted)
  const updateLeads = useLeadStore(state => state.updateLeads)
  const { toast } = useToast()
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<'all' | OutreachTaskStatus>('all')
  const [search, setSearch] = useState('')
  const [deviceSerial, setDeviceSerial] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set())

  const refreshDevices = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const next = await window.ipcRenderer.invoke(IPC_CHANNELS.device.list)
      setDevices(next)
      if (!deviceSerial)
        setDeviceSerial(next.find(device => device.state === 'device')?.serial ?? '')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取设备失败')
    } finally {
      setIsRefreshing(false)
    }
  }, [deviceSerial, toast])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return tasks.filter(task => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false
      if (!query) return true
      return [
        task.nickname,
        task.userId,
        task.douyinId,
        task.videoTitle,
        task.need,
        task.comments.join(' '),
      ].some(value => value.toLowerCase().includes(query))
    })
  }, [search, statusFilter, tasks])

  const counts = useMemo(
    () =>
      tasks.reduce(
        (result, task) => {
          result[task.status] += 1
          return result
        },
        {
          pending_review: 0,
          ready: 0,
          assigned: 0,
          preparing: 0,
          awaiting_confirmation: 0,
          sending: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
        } as Record<OutreachTaskStatus, number>,
      ),
    [tasks],
  )

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectVisible = (checked: boolean) => {
    setSelectedIds(current => {
      const next = new Set(current)
      for (const task of visibleTasks) {
        if (checked) next.add(task.id)
        else next.delete(task.id)
      }
      return next
    })
  }

  const confirmSelected = () => {
    const ids = [...selectedIds]
    if (!ids.length) return toast.error('请先选择任务')
    updateTasks(ids, { status: 'ready' })
    toast.success(`已确认 ${ids.length} 条私信任务，等待分配真机`)
  }

  const assignSelected = () => {
    const ids = [...selectedIds]
    if (!ids.length) return toast.error('请先选择任务')
    if (!deviceSerial) return toast.error('请先选择一台已连接的 Android 真机')
    const device = devices.find(item => item.serial === deviceSerial)
    if (device?.state !== 'device') return toast.error('所选设备当前不可用')
    updateTasks(ids, { status: 'assigned', deviceSerial })
    toast.success(`已将 ${ids.length} 条任务分配到 ${deviceLabel(device)}`)
  }

  const skipSelected = () => {
    const ids = [...selectedIds]
    if (!ids.length) return toast.error('请先选择任务')
    updateTasks(ids, { status: 'skipped' })
    updateLeads(
      tasks
        .filter(task => selectedIds.has(task.id))
        .map(task => ({ ids: task.leadIds, patch: { outreachStatus: 'skipped' as const } })),
    )
    setSelectedIds(new Set())
  }

  const markExecuting = (id: string, executing: boolean) => {
    setExecutingIds(current => {
      const next = new Set(current)
      if (executing) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const handleOutreachFailure = (task: OutreachTask, message: string) => {
    if (getOutreachFailureAction(message) === 'remove') {
      updateLeads([{ ids: task.leadIds, patch: { outreachStatus: 'skipped' } }])
      removeTasks([task.id])
      toast.success('对方拒绝陌生人私信，已移除该用户任务')
      return
    }
    updateTask(task.id, { status: 'failed', lastError: message })
    toast.error(message)
  }

  const prepareTask = async (task: OutreachTask) => {
    if (!task.deviceSerial) return toast.error('请先给任务分配一台 Android 真机')
    markExecuting(task.id, true)
    updateTask(task.id, {
      status: 'preparing',
      attemptCount: task.attemptCount + 1,
      lastError: '',
      draftMessage: TEST_OUTREACH_MESSAGE,
    })
    try {
      const result = await window.ipcRenderer.invoke(
        IPC_CHANNELS.device.prepareOutreach,
        task.deviceSerial,
        {
          taskId: task.id,
          userId: task.userId,
          douyinId: task.douyinId,
          nickname: task.nickname,
          draftMessage: TEST_OUTREACH_MESSAGE,
        },
      )
      if (!result.ok) {
        handleOutreachFailure(task, result.message)
        return
      }
      updateTask(task.id, { status: 'awaiting_confirmation', lastError: '' })
      toast.success(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : '真机准备私信失败'
      handleOutreachFailure(task, message)
    } finally {
      markExecuting(task.id, false)
    }
  }

  const sendTask = async (task: OutreachTask) => {
    if (!task.deviceSerial) return toast.error('当前任务没有已分配设备')
    markExecuting(task.id, true)
    updateTask(task.id, { status: 'sending', lastError: '' })
    try {
      const result = await window.ipcRenderer.invoke(
        IPC_CHANNELS.device.confirmOutreach,
        task.deviceSerial,
        task.id,
      )
      if (!result.ok) {
        handleOutreachFailure(task, result.message)
        return
      }
      updateTask(task.id, { status: 'sent', sentAt: Date.now(), lastError: '' })
      updateLeads([{ ids: task.leadIds, patch: { outreachStatus: 'sent' } }])
      toast.success(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : '真机发送失败'
      handleOutreachFailure(task, message)
    } finally {
      markExecuting(task.id, false)
    }
  }

  return (
    <div className="container space-y-5 py-8">
      <div className="flex items-start justify-between gap-4">
        <Title
          title="真机私信队列"
          description="承接 AI 筛选结果，人工确认后分配给已连接的 Android 真机。"
        />
        <div className="flex items-center gap-2">
          <Select
            value={deviceSerial || '__none__'}
            onValueChange={value => setDeviceSerial(value === '__none__' ? '' : value)}
          >
            <SelectTrigger className="w-52">
              <SelectValue placeholder="选择真机" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未选择设备</SelectItem>
              {devices.map(device => (
                <SelectItem
                  key={device.serial}
                  value={device.serial}
                  disabled={device.state !== 'device'}
                >
                  {deviceLabel(device)} · {device.state === 'device' ? '已连接' : device.state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void refreshDevices()} disabled={isRefreshing}>
            {isRefreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            刷新设备
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        真机执行会搜索目标用户、打开私信并填入草稿；只有再次人工确认后才会点击发送。
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="待审核" value={counts.pending_review} />
        <Metric label="已确认" value={counts.ready} />
        <Metric label="已分配" value={counts.assigned} />
        <Metric label="待确认发送" value={counts.awaiting_confirmation} />
        <Metric label="已发送" value={counts.sent} />
        <Metric label="失败" value={counts.failed} />
      </div>

      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">待处理用户</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={confirmSelected}
                disabled={!selectedIds.size}
              >
                <ClipboardCheck /> 确认进入发送队列
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={assignSelected}
                disabled={!selectedIds.size}
              >
                <Smartphone /> 分配真机
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={skipSelected}
                disabled={!selectedIds.size}
              >
                <X /> 跳过
              </Button>
              <Button variant="ghost" size="sm" onClick={clearCompleted}>
                <Trash2 /> 清理已完成
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索用户、视频、评论、需求"
            />
            <Select
              value={statusFilter}
              onValueChange={value => setStatusFilter(value as typeof statusFilter)}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {(Object.keys(statusLabels) as OutreachTaskStatus[]).map(status => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 border-b pb-2 text-xs text-muted-foreground">
            <Checkbox
              aria-label="选择当前全部任务"
              checked={
                visibleTasks.length > 0 && visibleTasks.every(task => selectedIds.has(task.id))
              }
              onCheckedChange={checked => selectVisible(Boolean(checked))}
            />
            <span>
              当前显示 {visibleTasks.length} 条，已选 {selectedIds.size} 条
            </span>
            <span className="ml-auto">
              已连接真机 {devices.filter(device => device.state === 'device').length} 台
            </span>
          </div>
          {visibleTasks.length === 0 ? (
            <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
              暂无队列任务。请先在 AI 筛选页选择可沟通用户并送入真机私信。
            </div>
          ) : (
            visibleTasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                selected={selectedIds.has(task.id)}
                busy={executingIds.has(task.id)}
                onSelect={checked => toggleSelected(task.id, checked)}
                onPrepare={() => void prepareTask(task)}
                onSend={() => void sendTask(task)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function TaskRow({
  task,
  selected,
  busy,
  onSelect,
  onPrepare,
  onSend,
}: {
  task: OutreachTask
  selected: boolean
  busy: boolean
  onSelect: (checked: boolean) => void
  onPrepare: () => void
  onSend: () => void
}) {
  return (
    <div
      className="grid gap-3 rounded-md border p-4 lg:grid-cols-[28px_minmax(180px,0.8fr)_minmax(240px,1fr)_minmax(260px,1.2fr)_150px]"
      data-testid="outreach-task-row"
    >
      <Checkbox
        aria-label={`选择 ${task.nickname || task.douyinId || task.userId}`}
        checked={selected}
        onCheckedChange={value => onSelect(Boolean(value))}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-medium">
          <UserRound className="size-4" />
          {task.nickname || '未知用户'}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          抖音号：{task.douyinId || '未提供'}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          用户 ID：{task.userId || '未提供'}
        </div>
        <Badge variant="outline" className={cn('mt-2 w-fit', statusClasses[task.status])}>
          {statusLabels[task.status]}
        </Badge>
      </div>
      <div className="min-w-0 text-sm">
        <div className="truncate font-medium" title={task.videoTitle}>
          {task.videoTitle || '未归类视频'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {task.need || '未填写需求'} · {task.score === null ? '无分数' : `${task.score}分`}
        </div>
        <div className="mt-2 line-clamp-3 text-xs leading-5" title={task.comments.join('\n')}>
          {task.comments.join(' / ')}
        </div>
        {task.aiReason && (
          <div className="mt-1 text-xs text-muted-foreground">依据：{task.aiReason}</div>
        )}
      </div>
      <div className="min-w-0">
        <Textarea
          value={TEST_OUTREACH_MESSAGE}
          readOnly
          disabled
          placeholder="测试私信固定发送 1"
          className="min-h-24 resize-y"
        />
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>设备：{task.deviceSerial || '未分配'}</span>
          {task.lastError && <span className="text-red-600">{task.lastError}</span>}
        </div>
      </div>
      <div className="flex flex-col items-end justify-between gap-2 text-right">
        <div className="text-xs text-muted-foreground">尝试 {task.attemptCount} 次</div>
        {task.status === 'awaiting_confirmation' ? (
          <div className="flex flex-col items-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onPrepare}
              disabled={busy}
              data-testid="prepare-outreach"
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Smartphone />}
              重新准备
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" disabled={busy} data-testid="confirm-outreach">
                  <Send /> 确认发送
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认在真机上发送这条私信？</AlertDialogTitle>
                  <AlertDialogDescription>
                    目标用户：{task.nickname || task.douyinId || task.userId}
                    。确认后会点击当前抖音会话中的发送按钮。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={onSend}>确认发送</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !['assigned', 'failed'].includes(task.status)}
            onClick={onPrepare}
            title="打开目标用户私信并填入草稿"
            data-testid="prepare-outreach"
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Smartphone />}
            准备私信
          </Button>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}
