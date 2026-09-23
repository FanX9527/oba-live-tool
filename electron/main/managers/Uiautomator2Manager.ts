import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { app } from 'electron'
import { createLogger } from '#/logger'

const execFileAsync = promisify(execFile)
const logger = createLogger('Uiautomator2Manager')
const RESPONSE_PREFIX = '__OBA_UIA2__'
const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 90_000

interface PythonRuntime {
  command: string
  args: string[]
  version: string
  managed: boolean
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type AutomationAction =
  | 'app_current'
  | 'app_start'
  | 'clear_text'
  | 'click'
  | 'connect'
  | 'disconnect'
  | 'dump_hierarchy'
  | 'ping'
  | 'press'
  | 'send_keys'
  | 'swipe'

interface InputCapability {
  available: boolean
  message?: string
}

const INPUT_ACTIONS = new Set<AutomationAction>([
  'clear_text',
  'click',
  'press',
  'send_keys',
  'swipe',
])

function isInputPermissionError(message: string) {
  return /INJECT_EVENTS|injectInputEvent|SecurityException/i.test(message)
}

function isConnectionError(message: string) {
  return /device offline|device not found|connection (?:refused|reset)|transport error/i.test(
    message,
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

class Uiautomator2Manager {
  private worker?: ChildProcessWithoutNullStreams

  private runtime?: PythonRuntime

  private discovery?: Promise<PythonRuntime | undefined>

  private nextRequestId = 1

  private pending = new Map<number, PendingRequest>()

  private readyDevices = new Set<string>()

  private inputCapabilities = new Map<string, InputCapability>()

  private lastError = ''

  private bridgePath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'uiautomator2', 'bridge.py')
      : path.join(app.getAppPath(), 'resources', 'uiautomator2', 'bridge.py')
  }

  private requirementsPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'uiautomator2', 'requirements.txt')
      : path.join(app.getAppPath(), 'resources', 'uiautomator2', 'requirements.txt')
  }

  private managedPythonPath() {
    const executable = process.platform === 'win32' ? 'python.exe' : 'python'
    const folder = process.platform === 'win32' ? 'Scripts' : 'bin'
    return path.join(
      app.getPath('userData'),
      'runtime',
      'uiautomator2',
      '.venv',
      folder,
      executable,
    )
  }

  private pythonCandidates(): Array<{ command: string; args: string[]; managed: boolean }> {
    const candidates: Array<{ command: string; args: string[]; managed: boolean }> = []
    if (process.env.OBA_PYTHON_PATH) {
      candidates.push({ command: process.env.OBA_PYTHON_PATH, args: [], managed: false })
    }
    candidates.push({ command: this.managedPythonPath(), args: [], managed: true })
    if (process.platform === 'win32') {
      candidates.push(
        { command: 'python.exe', args: [], managed: false },
        { command: 'py.exe', args: ['-3.12'], managed: false },
        { command: 'py.exe', args: ['-3.11'], managed: false },
        { command: 'py.exe', args: ['-3.10'], managed: false },
        { command: 'py.exe', args: ['-3.9'], managed: false },
        { command: 'py.exe', args: ['-3.8'], managed: false },
      )
    } else {
      candidates.push(
        { command: 'python3', args: [], managed: false },
        { command: 'python', args: [], managed: false },
      )
    }
    return candidates
  }

  private async inspectRuntime(candidate: {
    command: string
    args: string[]
    managed: boolean
  }): Promise<PythonRuntime | undefined> {
    if (path.isAbsolute(candidate.command) && !existsSync(candidate.command)) return undefined
    try {
      const { stdout } = await execFileAsync(
        candidate.command,
        [
          ...candidate.args,
          '-c',
          "import importlib.metadata as m; print(m.version('uiautomator2'))",
        ],
        { windowsHide: true, timeout: 10_000 },
      )
      const version = stdout.trim().split(/\r?\n/).at(-1)
      if (!version) return undefined
      return { ...candidate, version, managed: candidate.managed }
    } catch {
      return undefined
    }
  }

  private async discoverRuntime(force = false): Promise<PythonRuntime | undefined> {
    if (force) {
      this.runtime = undefined
      this.discovery = undefined
    }
    if (this.runtime) return this.runtime
    if (!this.discovery) {
      this.discovery = (async () => {
        for (const candidate of this.pythonCandidates()) {
          const runtime = await this.inspectRuntime(candidate)
          if (runtime) {
            this.runtime = runtime
            return runtime
          }
        }
        return undefined
      })()
    }
    return this.discovery
  }

  private async findBasePython(): Promise<{ command: string; args: string[] }> {
    for (const candidate of this.pythonCandidates().filter(candidate => !candidate.managed)) {
      if (path.isAbsolute(candidate.command) && !existsSync(candidate.command)) continue
      try {
        const { stdout } = await execFileAsync(
          candidate.command,
          [
            ...candidate.args,
            '-c',
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
          ],
          { windowsHide: true, timeout: 10_000 },
        )
        const [major = 0, minor = 0] = stdout
          .trim()
          .split('.', 2)
          .map(part => Number(part))
        if (major < 3 || (major === 3 && minor < 8)) continue
        return candidate
      } catch {
        // Try the next Python launcher.
      }
    }
    throw new Error('未找到 Python 3.8 或更高版本，无法安装自动化引擎')
  }

  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  private attachWorker(worker: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: worker.stdout })
    lines.on('line', line => {
      if (!line.startsWith(RESPONSE_PREFIX)) {
        if (line.trim()) logger.debug(line)
        return
      }
      try {
        const response = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as WorkerResponse
        const pending = this.pending.get(response.id)
        if (!pending) return
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(new Error(response.error || 'uiautomator2 执行失败'))
      } catch (error) {
        logger.warn('解析 uiautomator2 返回数据失败', error)
      }
    })
    worker.stderr.on('data', chunk => {
      const message = chunk.toString().trim()
      if (message) logger.debug(message)
    })
    worker.on('error', error => {
      this.lastError = error.message
      this.rejectPending(`自动化执行器启动失败：${error.message}`)
    })
    worker.on('exit', (code, signal) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.readyDevices.clear()
      this.inputCapabilities.clear()
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      this.lastError = `自动化执行器已退出（${detail}）`
      this.rejectPending(this.lastError)
    })
  }

  private request<T>(
    action: AutomationAction,
    serial?: string,
    params: Record<string, unknown> = {},
    timeout = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const worker = this.worker
    if (!worker?.stdin.writable) return Promise.reject(new Error('自动化执行器未启动'))
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`自动化动作 ${action} 执行超时`))
      }, timeout)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
      worker.stdin.write(`${JSON.stringify({ id, action, serial, params })}\n`, error => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      })
    })
  }

  private async startWorker() {
    if (this.worker?.stdin.writable) return
    const runtime = await this.discoverRuntime()
    if (!runtime) throw new Error('uiautomator2 尚未安装，请先安装自动化引擎')
    const bridge = this.bridgePath()
    if (!existsSync(bridge)) throw new Error(`自动化桥接脚本不存在：${bridge}`)

    const worker = spawn(runtime.command, [...runtime.args, '-u', bridge], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.worker = worker
    this.attachWorker(worker)
    try {
      await this.request<{ version: string }>('ping', undefined, {}, 15_000)
      this.lastError = ''
    } catch (error) {
      this.stop()
      throw error
    }
  }

  async status(serial?: string): Promise<AndroidAutomationStatus> {
    const runtime = await this.discoverRuntime()
    const available = Boolean(runtime)
    const ready = Boolean(serial && this.readyDevices.has(serial) && this.worker?.stdin.writable)
    const inputCapability = serial ? this.inputCapabilities.get(serial) : undefined
    return {
      engine: 'uiautomator2',
      available,
      running: Boolean(this.worker?.stdin.writable),
      ready,
      inputAvailable: inputCapability?.available,
      inputMessage: inputCapability?.message,
      canInstall: true,
      version: runtime?.version,
      managedRuntime: runtime?.managed ?? false,
      message: ready
        ? inputCapability?.available === false
          ? 'UI 读取已就绪，触控被手机系统拦截'
          : inputCapability?.available
            ? '控件读取和触控均已就绪'
            : 'UI 读取已就绪，等待首次触控测试'
        : available
          ? '引擎可用，等待初始化设备'
          : this.lastError || '自动化引擎尚未安装',
    }
  }

  async prepare(serial: string): Promise<AndroidAutomationStatus> {
    const normalizedSerial = serial.trim()
    if (!normalizedSerial) throw new Error('设备序列号不能为空')
    await this.startWorker()
    try {
      await this.request('connect', normalizedSerial, {}, CONNECT_TIMEOUT_MS)
      this.readyDevices.add(normalizedSerial)
      this.lastError = ''
      return this.status(normalizedSerial)
    } catch (error) {
      this.readyDevices.delete(normalizedSerial)
      this.lastError = errorMessage(error)
      throw new Error(`初始化 uiautomator2 失败：${this.lastError}`)
    }
  }

  async install(): Promise<AndroidAutomationStatus> {
    this.stop()
    const python = await this.findBasePython()
    const managedPython = this.managedPythonPath()
    const venvRoot = path.resolve(managedPython, '..', '..')
    const requirements = this.requirementsPath()
    if (!existsSync(requirements)) throw new Error(`缺少自动化依赖文件：${requirements}`)

    if (!existsSync(managedPython)) {
      await execFileAsync(python.command, [...python.args, '-m', 'venv', venvRoot], {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    }
    try {
      await execFileAsync(
        managedPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', requirements],
        { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      )
    } catch (error) {
      throw new Error(`安装 uiautomator2 失败：${errorMessage(error)}`)
    }
    await this.discoverRuntime(true)
    return this.status()
  }

  async run<T>(
    serial: string,
    action: Exclude<AutomationAction, 'connect' | 'disconnect' | 'ping'>,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.readyDevices.has(serial) || !this.worker?.stdin.writable) {
      await this.prepare(serial)
    }
    try {
      const result = await this.request<T>(action, serial, params)
      if (INPUT_ACTIONS.has(action)) {
        this.inputCapabilities.set(serial, { available: true })
      }
      return result
    } catch (error) {
      const message = errorMessage(error)
      if (INPUT_ACTIONS.has(action) && isInputPermissionError(message)) {
        this.inputCapabilities.set(serial, {
          available: false,
          message: 'MIUI 拒绝模拟触控；UI 读取仍可用，手动控制可使用 scrcpy UHID 投屏',
        })
      }
      if (isConnectionError(message)) {
        this.readyDevices.delete(serial)
        this.lastError = message
      }
      throw error
    }
  }

  stop() {
    const worker = this.worker
    this.worker = undefined
    this.readyDevices.clear()
    this.inputCapabilities.clear()
    this.rejectPending('自动化执行器已停止')
    if (!worker) return
    worker.stdin.end()
    if (!worker.killed) worker.kill()
  }
}

export const uiautomator2Manager = new Uiautomator2Manager()
