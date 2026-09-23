import {
  AppWindowIcon,
  BatteryChargingIcon,
  BatteryIcon,
  CpuIcon,
  DownloadIcon,
  HomeIcon,
  ListIcon,
  LoaderCircleIcon,
  MonitorPlayIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SmartphoneIcon,
  SquareIcon,
  UnplugIcon,
} from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Title } from '@/components/common/Title'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

const stateLabels: Record<AndroidDeviceState, string> = {
  device: '已连接',
  unauthorized: '待授权',
  offline: '离线',
  unknown: '异常',
}

const stateClasses: Record<AndroidDeviceState, string> = {
  device: 'bg-emerald-500',
  unauthorized: 'bg-amber-500',
  offline: 'bg-gray-400',
  unknown: 'bg-red-500',
}

interface PointerPosition {
  deviceX: number
  deviceY: number
  clientX: number
  clientY: number
  startedAt: number
}

function deviceName(device: AndroidDevice) {
  return [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial
}

export default function DeviceControl() {
  const { toast } = useToast()
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [selectedSerial, setSelectedSerial] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [screenImage, setScreenImage] = useState('')
  const [screenError, setScreenError] = useState('')
  const [screenDimensions, setScreenDimensions] = useState<{ width: number; height: number }>()
  const [isSendingCommand, setIsSendingCommand] = useState(false)
  const [isScrcpyRunning, setIsScrcpyRunning] = useState(false)
  const [isStartingScrcpy, setIsStartingScrcpy] = useState(false)
  const [accessibilityStatus, setAccessibilityStatus] = useState<AndroidAccessibilityStatus>()
  const [isConfiguringAccessibility, setIsConfiguringAccessibility] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointerStart = useRef<PointerPosition | null>(null)
  const refreshRunning = useRef(false)

  const selectedDevice = useMemo(
    () => devices.find(device => device.serial === selectedSerial),
    [devices, selectedSerial],
  )

  const refreshDevices = useCallback(
    async (showResult = false) => {
      if (refreshRunning.current) return
      refreshRunning.current = true
      setIsRefreshing(true)
      try {
        const nextDevices = await window.ipcRenderer.invoke(IPC_CHANNELS.device.list)
        setDevices(nextDevices)
        setSelectedSerial(current => {
          if (nextDevices.some(device => device.serial === current)) return current
          return (
            nextDevices.find(device => device.state === 'device')?.serial ||
            nextDevices[0]?.serial ||
            ''
          )
        })
        if (showResult) {
          if (nextDevices.length > 0) toast.success(`已发现 ${nextDevices.length} 台设备`)
          else toast.error('未发现 Android 设备')
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '读取设备失败')
      } finally {
        refreshRunning.current = false
        setIsRefreshing(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    void refreshDevices()
    const timer = window.setInterval(() => void refreshDevices(), 8000)
    return () => window.clearInterval(timer)
  }, [refreshDevices])

  const activeSerial = selectedDevice?.serial
  const activeState = selectedDevice?.state

  useEffect(() => {
    setScreenImage('')
    setScreenError('')
    setScreenDimensions(undefined)
    setIsScrcpyRunning(false)
    if (!activeSerial || activeState !== 'device') return

    let cancelled = false
    let timer: number | undefined

    const capture = async () => {
      try {
        const image = await window.ipcRenderer.invoke(IPC_CHANNELS.device.screenshot, activeSerial)
        if (!cancelled) {
          setScreenImage(image)
          setScreenError('')
        }
      } catch (error) {
        if (!cancelled) {
          setScreenError(error instanceof Error ? error.message : '无法读取手机画面')
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(capture, 1100)
      }
    }

    void capture()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [activeSerial, activeState])

  useEffect(() => {
    if (!activeSerial || activeState !== 'device') return
    let cancelled = false
    const refreshStatus = async () => {
      try {
        const running = await window.ipcRenderer.invoke(IPC_CHANNELS.scrcpy.status, activeSerial)
        if (!cancelled) setIsScrcpyRunning(running)
      } catch {
        if (!cancelled) setIsScrcpyRunning(false)
      }
    }
    void refreshStatus()
    const timer = window.setInterval(() => void refreshStatus(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeSerial, activeState])

  useEffect(() => {
    setAccessibilityStatus(undefined)
    if (!activeSerial || activeState !== 'device') return
    let cancelled = false
    const refreshStatus = async () => {
      try {
        const status = await window.ipcRenderer.invoke(
          IPC_CHANNELS.device.accessibilityStatus,
          activeSerial,
        )
        if (!cancelled) setAccessibilityStatus(status)
      } catch (error) {
        if (!cancelled) {
          setAccessibilityStatus({
            engine: 'accessibility',
            packageName: 'com.obalivetool.accessibility',
            installed: false,
            enabled: false,
            connected: false,
            ready: false,
            message: error instanceof Error ? error.message : '无法读取无障碍控制状态',
          })
        }
      }
    }
    void refreshStatus()
    const timer = window.setInterval(() => void refreshStatus(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeSerial, activeState])

  const runCommand = useCallback(
    async (command: () => Promise<unknown>) => {
      if (selectedDevice?.state !== 'device') return
      setIsSendingCommand(true)
      try {
        await command()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '设备操作失败')
      } finally {
        setIsSendingCommand(false)
      }
    },
    [selectedDevice, toast],
  )

  const sendKey = (key: AndroidDeviceKey) => {
    if (!selectedDevice) return
    void runCommand(() =>
      window.ipcRenderer.invoke(IPC_CHANNELS.device.key, selectedDevice.serial, key),
    )
  }

  const toggleScrcpy = async () => {
    if (selectedDevice?.state !== 'device') return
    setIsStartingScrcpy(true)
    try {
      if (isScrcpyRunning) {
        await window.ipcRenderer.invoke(IPC_CHANNELS.scrcpy.stop, selectedDevice.serial)
        setIsScrcpyRunning(false)
        toast.success('已关闭手机投屏')
      } else {
        await window.ipcRenderer.invoke(IPC_CHANNELS.scrcpy.start, selectedDevice.serial)
        setIsScrcpyRunning(true)
        toast.success('已打开手机投屏窗口')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '投屏启动失败')
    } finally {
      setIsStartingScrcpy(false)
    }
  }

  const configureAccessibility = async () => {
    if (selectedDevice?.state !== 'device' || !accessibilityStatus) return
    setIsConfiguringAccessibility(true)
    try {
      let status: AndroidAccessibilityStatus
      if (!accessibilityStatus.installed) {
        status = await window.ipcRenderer.invoke(
          IPC_CHANNELS.device.installAccessibility,
          selectedDevice.serial,
        )
        toast.success(
          status.installationPending
            ? '手机已打开安装器，请点击“继续”和“安装”'
            : '组件已安装，请在手机上开启“OBA 真机控制”',
        )
      } else if (!accessibilityStatus.enabled) {
        await window.ipcRenderer.invoke(
          IPC_CHANNELS.device.openAccessibilitySettings,
          selectedDevice.serial,
        )
        status = await window.ipcRenderer.invoke(
          IPC_CHANNELS.device.accessibilityStatus,
          selectedDevice.serial,
        )
        toast.success('已打开手机无障碍设置，请开启“OBA 真机控制”')
      } else {
        status = await window.ipcRenderer.invoke(
          IPC_CHANNELS.device.accessibilityStatus,
          selectedDevice.serial,
        )
        if (status.ready) toast.success('无障碍触控已就绪')
        else toast.error('服务尚未连接，请在手机上关闭后重新开启该服务')
      }
      setAccessibilityStatus(status)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '配置真机控制组件失败')
    } finally {
      setIsConfiguringAccessibility(false)
    }
  }

  const mapPointer = (
    event: ReactPointerEvent<HTMLImageElement>,
  ): Omit<PointerPosition, 'startedAt'> | null => {
    const image = imageRef.current
    if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) return null
    const rect = image.getBoundingClientRect()
    const relativeX = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
    const relativeY = Math.min(rect.height, Math.max(0, event.clientY - rect.top))
    return {
      deviceX: Math.round((relativeX / rect.width) * image.naturalWidth),
      deviceY: Math.round((relativeY / rect.height) * image.naturalHeight),
      clientX: event.clientX,
      clientY: event.clientY,
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    const position = mapPointer(event)
    if (!position) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerStart.current = { ...position, startedAt: Date.now() }
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const start = pointerStart.current
    const end = mapPointer(event)
    pointerStart.current = null
    if (!start || !end || !selectedDevice) return

    const clientDistance = Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY)
    if (clientDistance < 8) {
      void runCommand(() =>
        window.ipcRenderer.invoke(
          IPC_CHANNELS.device.tap,
          selectedDevice.serial,
          end.deviceX,
          end.deviceY,
        ),
      )
      return
    }

    void runCommand(() =>
      window.ipcRenderer.invoke(
        IPC_CHANNELS.device.swipe,
        selectedDevice.serial,
        start.deviceX,
        start.deviceY,
        end.deviceX,
        end.deviceY,
        Math.min(1500, Math.max(120, Date.now() - start.startedAt)),
      ),
    )
  }

  const screenRatio = screenDimensions
    ? `${screenDimensions.width} / ${screenDimensions.height}`
    : selectedDevice?.screen
      ? `${selectedDevice.screen.width} / ${selectedDevice.screen.height}`
      : '1 / 2'

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <Title title="真机控制" description="Android 设备与抖音运行状态" />
        <Button variant="outline" onClick={() => void refreshDevices(true)} disabled={isRefreshing}>
          <RefreshCwIcon className={cn(isRefreshing && 'animate-spin')} />
          刷新设备
        </Button>
      </div>

      <div className="grid min-h-[620px] gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-md border bg-white">
          <div className="flex h-12 items-center justify-between border-b px-4">
            <h2 className="text-sm font-semibold">设备</h2>
            <Badge variant="secondary">{devices.length}</Badge>
          </div>

          {devices.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <UnplugIcon className="h-8 w-8" />
              <span className="text-sm">没有检测到设备</span>
            </div>
          ) : (
            <div className="divide-y">
              {devices.map(device => (
                <button
                  type="button"
                  key={device.serial}
                  onClick={() => setSelectedSerial(device.serial)}
                  className={cn(
                    'flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/70',
                    device.serial === selectedSerial && 'bg-muted',
                  )}
                >
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <SmartphoneIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{deviceName(device)}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {device.serial}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={cn('h-2 w-2 rounded-full', stateClasses[device.state])} />
                      {stateLabels[device.state]}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-md border bg-white p-5">
          {!selectedDevice ? (
            <div className="flex h-full min-h-[560px] items-center justify-center text-sm text-muted-foreground">
              请选择设备
            </div>
          ) : selectedDevice.state !== 'device' ? (
            <div className="flex h-full min-h-[560px] flex-col items-center justify-center gap-3 text-center">
              <SmartphoneIcon className="h-10 w-10 text-muted-foreground" />
              <div className="font-medium">{stateLabels[selectedDevice.state]}</div>
              <div className="text-sm text-muted-foreground">{selectedDevice.serial}</div>
            </div>
          ) : (
            <div className="grid h-full gap-6 lg:grid-cols-[minmax(260px,420px)_minmax(240px,1fr)]">
              <div className="flex min-w-0 flex-col items-center">
                <div
                  className="relative max-h-[620px] w-full overflow-hidden rounded-md bg-black shadow-sm"
                  style={{ aspectRatio: screenRatio }}
                >
                  {screenImage ? (
                    <img
                      ref={imageRef}
                      src={screenImage}
                      alt={`${deviceName(selectedDevice)} 屏幕`}
                      draggable={false}
                      onLoad={event => {
                        const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                        setScreenDimensions({ width, height })
                      }}
                      onPointerDown={handlePointerDown}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={() => {
                        pointerStart.current = null
                      }}
                      className="h-full w-full touch-none select-none object-fill"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/70">
                      {screenError || '正在读取屏幕...'}
                    </div>
                  )}
                </div>

                <TooltipProvider>
                  <div className="mt-4 flex h-10 items-center justify-center gap-2">
                    <DeviceKeyButton
                      label="返回"
                      icon={<RotateCcwIcon />}
                      onClick={() => sendKey('BACK')}
                      disabled={isSendingCommand}
                    />
                    <DeviceKeyButton
                      label="主页"
                      icon={<HomeIcon />}
                      onClick={() => sendKey('HOME')}
                      disabled={isSendingCommand}
                    />
                    <DeviceKeyButton
                      label="最近任务"
                      icon={<ListIcon />}
                      onClick={() => sendKey('APP_SWITCH')}
                      disabled={isSendingCommand}
                    />
                  </div>
                </TooltipProvider>
              </div>

              <div className="min-w-0 space-y-6">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
                      <AppWindowIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">
                        {deviceName(selectedDevice)}
                      </h2>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selectedDevice.serial}
                      </p>
                    </div>
                  </div>

                  <Button
                    className="mt-5 w-full"
                    disabled={!selectedDevice.douyinInstalled || isSendingCommand}
                    onClick={() =>
                      void runCommand(() =>
                        window.ipcRenderer.invoke(
                          IPC_CHANNELS.device.launchDouyin,
                          selectedDevice.serial,
                        ),
                      )
                    }
                  >
                    <PlayIcon />
                    启动抖音
                  </Button>

                  <Button
                    variant={isScrcpyRunning ? 'secondary' : 'outline'}
                    className="mt-2 w-full"
                    disabled={isStartingScrcpy}
                    onClick={() => void toggleScrcpy()}
                  >
                    {isScrcpyRunning ? <SquareIcon /> : <MonitorPlayIcon />}
                    {isScrcpyRunning ? '关闭手机投屏' : '打开手机投屏'}
                  </Button>
                  <Button
                    variant={accessibilityStatus?.ready ? 'secondary' : 'outline'}
                    className="mt-2 w-full"
                    disabled={
                      !accessibilityStatus ||
                      accessibilityStatus.ready ||
                      isConfiguringAccessibility
                    }
                    onClick={() => void configureAccessibility()}
                  >
                    {isConfiguringAccessibility ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : accessibilityStatus?.installed ? (
                      <CpuIcon />
                    ) : (
                      <DownloadIcon />
                    )}
                    {isConfiguringAccessibility
                      ? '正在配置'
                      : accessibilityStatus?.ready
                        ? '真机触控已就绪'
                        : accessibilityStatus?.installed
                          ? accessibilityStatus.enabled
                            ? '重新连接真机触控'
                            : '打开手机无障碍授权'
                          : '安装真机控制组件'}
                  </Button>
                  <p className="mt-2 text-center text-xs text-muted-foreground">
                    {accessibilityStatus
                      ? `${accessibilityStatus.message}${accessibilityStatus.version ? ` · v${accessibilityStatus.version}` : ''}`
                      : '正在检测无障碍控制组件'}
                  </p>
                </div>

                <div className="divide-y rounded-md border">
                  <InfoRow label="系统" value={`Android ${selectedDevice.androidVersion ?? '-'}`} />
                  <InfoRow
                    label="屏幕"
                    value={
                      selectedDevice.screen
                        ? `${selectedDevice.screen.width} × ${selectedDevice.screen.height}`
                        : '-'
                    }
                  />
                  <InfoRow
                    label="电量"
                    value={
                      selectedDevice.battery ? (
                        <span className="inline-flex items-center gap-1.5">
                          {selectedDevice.battery.charging ? (
                            <BatteryChargingIcon className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <BatteryIcon className="h-4 w-4" />
                          )}
                          {selectedDevice.battery.level}%
                        </span>
                      ) : (
                        '-'
                      )
                    }
                  />
                  <InfoRow
                    label="抖音"
                    value={selectedDevice.douyinInstalled ? '已安装' : '未安装'}
                  />
                  <InfoRow
                    label="真机触控"
                    value={
                      accessibilityStatus?.ready
                        ? '无障碍服务'
                        : accessibilityStatus?.installed
                          ? accessibilityStatus.enabled
                            ? '等待连接'
                            : '等待授权'
                          : '未安装'
                    }
                  />
                  <InfoRow
                    label="UI 读取"
                    value={accessibilityStatus?.ready ? 'Accessibility' : '未初始化'}
                  />
                  <InfoRow label="当前应用" value={selectedDevice.currentPackage ?? '-'} />
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function DeviceKeyButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid min-h-11 grid-cols-[88px_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  )
}
