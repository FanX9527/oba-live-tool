import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { createLogger } from '#/logger'

const execFileAsync = promisify(execFile)
const logger = createLogger('AndroidAccessibilityManager')
const COMPANION_PACKAGE = 'com.obalivetool.accessibility'
const COMPANION_SERVICE = `${COMPANION_PACKAGE}/${COMPANION_PACKAGE}.ObaAccessibilityService`
const COMPANION_ACTIVITY = `${COMPANION_PACKAGE}/.MainActivity`
const DEVICE_PORT = 27191

interface CompanionResponse {
  ok: boolean
  message?: string
  service?: boolean
  version?: string
  port?: number
  hierarchy?: string
}

interface CompanionForward {
  hostPort: number
  owned: boolean
}

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

class AndroidAccessibilityManager {
  private adbPath?: string

  private forwards = new Map<string, CompanionForward>()

  private async findAdbPath(): Promise<string> {
    if (this.adbPath && existsSync(this.adbPath)) return this.adbPath

    const executable = process.platform === 'win32' ? 'adb.exe' : 'adb'
    const bundledAdb = app.isPackaged
      ? path.join(process.resourcesPath, 'scrcpy', executable)
      : path.join(app.getAppPath(), 'resources', 'scrcpy', 'scrcpy-win64-v4.1', executable)
    const candidates = [
      process.env.ADB_PATH,
      bundledAdb,
      process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', executable),
      process.env.ANDROID_SDK_ROOT &&
        path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', executable),
      process.platform === 'win32' &&
        process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', executable),
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.adbPath = candidate
        return candidate
      }
    }

    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await execFileAsync(locator, ['adb'], { windowsHide: true })
    const located = stdout
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean)
    if (located && existsSync(located)) {
      this.adbPath = located
      return located
    }
    throw new Error('未找到 ADB，请安装 Android SDK Platform-Tools')
  }

  private validateSerial(serial: string) {
    const value = serial.trim()
    if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error('无效的设备序列号')
    return value
  }

  private async executeForDevice(serial: string, args: string[], timeout = 15_000) {
    const adbPath = await this.findAdbPath()
    try {
      return await execFileAsync(adbPath, ['-s', this.validateSerial(serial), ...args], {
        windowsHide: true,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      })
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string }
      throw new Error(detail.stderr?.trim() || detail.stdout?.trim() || detail.message)
    }
  }

  private async shell(serial: string, args: string[], timeout?: number) {
    const { stdout } = await this.executeForDevice(serial, ['shell', ...args], timeout)
    return stdout.trim()
  }

  private apkPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'android-accessibility', 'oba-accessibility.apk')
      : path.join(app.getAppPath(), 'resources', 'android-accessibility', 'oba-accessibility.apk')
  }

  private request(
    hostPort: number,
    pathname: '/health' | '/command',
    payload?: Record<string, unknown>,
  ): Promise<CompanionResponse> {
    const body = payload ? JSON.stringify(payload) : ''
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: hostPort,
          path: pathname,
          method: payload ? 'POST' : 'GET',
          headers: payload
            ? {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
              }
            : undefined,
          timeout: 6_000,
        },
        response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompanionResponse
              resolve(parsed)
            } catch (error) {
              reject(new Error(`真机控制组件返回了无效数据：${errorMessage(error)}`))
            }
          })
        },
      )
      request.on('timeout', () => request.destroy(new Error('真机控制组件响应超时')))
      request.on('error', reject)
      if (body) request.write(body)
      request.end()
    })
  }

  private async removeForward(serial: string) {
    const existing = this.forwards.get(serial)
    this.forwards.delete(serial)
    if (!existing?.owned) return
    await this.executeForDevice(serial, ['forward', '--remove', `tcp:${existing.hostPort}`]).catch(
      error => logger.debug(`清理设备 ${serial} 端口转发失败`, error),
    )
  }

  private async ensureForward(serial: string, recreate = false) {
    const normalizedSerial = this.validateSerial(serial)
    if (recreate) await this.removeForward(normalizedSerial)
    const existing = this.forwards.get(normalizedSerial)
    if (existing) return existing

    const { stdout: listed } = await this.executeForDevice(normalizedSerial, ['forward', '--list'])
    for (const line of listed.split(/\r?\n/)) {
      const [forwardSerial, local, remote] = line.trim().split(/\s+/)
      if (forwardSerial !== normalizedSerial || remote !== `tcp:${DEVICE_PORT}`) continue
      const hostPort = Number(local?.replace(/^tcp:/, ''))
      if (!Number.isInteger(hostPort) || hostPort <= 0) continue
      try {
        const response = await this.request(hostPort, '/health')
        if (response.ok && response.service) {
          const forward = { hostPort, owned: false }
          this.forwards.set(normalizedSerial, forward)
          return forward
        }
      } catch {
        // An older forward can remain registered after its connection dies.
      }
    }

    const { stdout } = await this.executeForDevice(normalizedSerial, [
      'forward',
      'tcp:0',
      `tcp:${DEVICE_PORT}`,
    ])
    const hostPort = Number(stdout.trim())
    if (!Number.isInteger(hostPort) || hostPort <= 0) {
      throw new Error(`ADB 未返回可用的真机控制端口：${stdout.trim() || '空响应'}`)
    }
    const forward = { hostPort, owned: true }
    this.forwards.set(normalizedSerial, forward)
    return forward
  }

  private async health(serial: string, recreate = false) {
    const forward = await this.ensureForward(serial, recreate)
    const response = await this.request(forward.hostPort, '/health')
    if (!response.ok || !response.service) {
      throw new Error(response.message || '真机无障碍服务尚未连接')
    }
    return response
  }

  async status(serial: string): Promise<AndroidAccessibilityStatus> {
    const normalizedSerial = this.validateSerial(serial)
    let installed = false
    let enabled = false
    let connected = false
    let version: string | undefined

    try {
      const packagePath = await this.shell(normalizedSerial, ['pm', 'path', COMPANION_PACKAGE])
      installed = packagePath.startsWith('package:')
      if (installed) {
        const packageInfo = await this.shell(normalizedSerial, [
          'dumpsys',
          'package',
          COMPANION_PACKAGE,
        ])
        version = packageInfo.match(/versionName=([^\s]+)/)?.[1]
      }
    } catch (error) {
      logger.debug(`读取设备 ${normalizedSerial} companion 安装状态失败`, error)
    }

    if (installed) {
      try {
        const [accessibilityEnabled, enabledServices] = await Promise.all([
          this.shell(normalizedSerial, ['settings', 'get', 'secure', 'accessibility_enabled']),
          this.shell(normalizedSerial, [
            'settings',
            'get',
            'secure',
            'enabled_accessibility_services',
          ]),
        ])
        enabled =
          accessibilityEnabled === '1' &&
          enabledServices
            .split(':')
            .some(
              component =>
                component === COMPANION_SERVICE ||
                (component.startsWith(`${COMPANION_PACKAGE}/`) &&
                  component.endsWith('.ObaAccessibilityService')),
            )
      } catch (error) {
        logger.debug(`读取设备 ${normalizedSerial} 无障碍授权状态失败`, error)
      }
    }

    if (enabled) {
      try {
        let response: CompanionResponse
        try {
          response = await this.health(normalizedSerial)
        } catch {
          response = await this.health(normalizedSerial, true)
        }
        connected = true
        version = response.version || version
      } catch (error) {
        logger.debug(`连接设备 ${normalizedSerial} 无障碍服务失败`, error)
      }
    } else {
      await this.removeForward(normalizedSerial)
    }

    return {
      engine: 'accessibility',
      packageName: COMPANION_PACKAGE,
      installed,
      enabled,
      connected,
      ready: installed && enabled && connected,
      version,
      message: !installed
        ? '等待安装真机控制组件'
        : !enabled
          ? 'MIUI 当前未启用 OBA 真机控制，请打开详情页开启，并将 OBA 设置为允许自启动、电池不限制'
          : connected
            ? '无障碍触控已就绪'
            : '无障碍已开启但控制端口未连接，正在自动重试；请保持 OBA 前台通知和后台权限',
    }
  }

  async install(serial: string): Promise<AndroidAccessibilityStatus> {
    const apk = this.apkPath()
    if (!existsSync(apk)) throw new Error(`真机控制组件不存在：${apk}`)
    await this.removeForward(serial)
    try {
      const { stdout } = await this.executeForDevice(serial, ['install', '-r', apk], 120_000)
      if (!stdout.includes('Success')) throw new Error(stdout.trim() || '安装真机控制组件失败')
      await this.shell(serial, [
        'pm',
        'grant',
        COMPANION_PACKAGE,
        'android.permission.WRITE_SECURE_SETTINGS',
      ]).catch(error => logger.debug('ADB 自动授权安全设置失败，将打开手机设置页', error))
      await this.shell(serial, ['am', 'start', '-n', COMPANION_ACTIVITY])
      await delay(800)
      const status = await this.status(serial)
      if (!status.enabled) await this.openSettings(serial)
      return status
    } catch (error) {
      const message = errorMessage(error)
      if (!message.includes('INSTALL_FAILED_USER_RESTRICTED')) throw error

      const deviceApk = '/sdcard/Download/OBA-Accessibility.apk'
      await this.executeForDevice(serial, ['push', apk, deviceApk], 120_000)
      await this.shell(serial, [
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        `file://${deviceApk}`,
        '-t',
        'application/vnd.android.package-archive',
        '-f',
        '0x10000000',
      ])
      const status = await this.status(serial)
      return {
        ...status,
        installationPending: true,
        message: 'MIUI 已打开可见安装器，请在手机上点击“继续”和“安装”',
      }
    }
  }

  async openSettings(serial: string): Promise<void> {
    const component = COMPANION_SERVICE
    try {
      await this.shell(serial, [
        'am',
        'start',
        '-a',
        'android.settings.ACCESSIBILITY_DETAILS_SETTINGS',
        '-n',
        'com.android.settings/.Settings$AccessibilityDetailsSettingsActivity',
        '--es',
        'android.intent.extra.COMPONENT_NAME',
        component,
      ])
      await delay(300)
      const focus = await this.shell(serial, ['dumpsys', 'window', 'windows'])
      if (!focus.includes('com.android.settings')) {
        throw new Error('MIUI 未打开无障碍详情页')
      }
    } catch (error) {
      logger.debug('打开 OBA 无障碍详情页失败，回退到无障碍列表', error)
      await this.shell(serial, ['am', 'start', '-a', 'android.settings.ACCESSIBILITY_SETTINGS'])
    }
  }

  async command(serial: string, payload: Record<string, unknown>): Promise<void> {
    let forward = await this.ensureForward(serial)
    let response: CompanionResponse
    try {
      response = await this.request(forward.hostPort, '/command', payload)
    } catch {
      forward = await this.ensureForward(serial, true)
      await delay(80)
      response = await this.request(forward.hostPort, '/command', payload)
    }
    if (!response.ok) throw new Error(response.message || '真机无障碍操作失败')
  }

  async dumpUi(serial: string): Promise<string> {
    let forward = await this.ensureForward(serial)
    let response: CompanionResponse
    try {
      response = await this.request(forward.hostPort, '/command', { action: 'dump_hierarchy' })
    } catch {
      forward = await this.ensureForward(serial, true)
      await delay(80)
      response = await this.request(forward.hostPort, '/command', { action: 'dump_hierarchy' })
    }
    if (!response.ok) throw new Error(response.message || '真机 UI 层级读取失败')
    if (!response.hierarchy?.includes('<hierarchy')) {
      throw new Error('真机无障碍服务未返回 UI 层级')
    }
    return response.hierarchy
  }

  async stop() {
    await Promise.all([...this.forwards.keys()].map(serial => this.removeForward(serial)))
  }
}

export const androidAccessibilityManager = new AndroidAccessibilityManager()
