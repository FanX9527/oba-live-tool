import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createLogger } from '#/logger'

const logger = createLogger('ScrcpyManager')

interface ScrcpySession {
  serial: string
  pid?: number
}

function isWindows() {
  return process.platform === 'win32'
}

class ScrcpyManager {
  private readonly processes = new Map<string, ChildProcess>()

  private resolveExecutable() {
    const executable = isWindows() ? 'scrcpy.exe' : 'scrcpy'
    const candidates = [
      process.env.SCRCPY_PATH,
      path.join(process.resourcesPath, 'scrcpy', executable),
      path.join(process.env.APP_ROOT ?? '', 'resources', 'scrcpy', 'scrcpy-win64-v4.1', executable),
      path.join(process.env.APP_ROOT ?? '', 'resources', 'scrcpy', executable),
    ].filter((candidate): candidate is string => Boolean(candidate))

    const resolved = candidates.find(candidate => existsSync(candidate))
    if (!resolved) {
      throw new Error('未找到 scrcpy 投屏组件，请重新安装或设置 SCRCPY_PATH')
    }
    return resolved
  }

  private validateSerial(serial: string) {
    if (!/^[a-zA-Z0-9._:-]+$/.test(serial)) throw new Error('无效的设备序列号')
    return serial
  }

  async start(serial: string): Promise<ScrcpySession> {
    const safeSerial = this.validateSerial(serial)
    const current = this.processes.get(safeSerial)
    if (current && !current.killed) return { serial: safeSerial, pid: current.pid }

    const executable = this.resolveExecutable()
    const child = spawn(
      executable,
      [
        '--serial',
        safeSerial,
        '--window-title',
        `真机投屏 - ${safeSerial}`,
        '--keyboard=uhid',
        '--mouse=uhid',
        '--no-audio',
        '--max-fps=60',
        '--video-bit-rate=8M',
      ],
      {
        cwd: path.dirname(executable),
        detached: false,
        windowsHide: false,
        stdio: 'ignore',
      },
    )

    this.processes.set(safeSerial, child)
    child.once('error', error => {
      logger.warn(`scrcpy 启动失败（${safeSerial}）`, error)
      if (this.processes.get(safeSerial) === child) this.processes.delete(safeSerial)
    })
    child.once('exit', (code, signal) => {
      logger.debug(`scrcpy 已退出（${safeSerial}，code=${code ?? '-'}，signal=${signal ?? '-'}）`)
      if (this.processes.get(safeSerial) === child) this.processes.delete(safeSerial)
    })

    return { serial: safeSerial, pid: child.pid }
  }

  stop(serial: string) {
    const safeSerial = this.validateSerial(serial)
    const child = this.processes.get(safeSerial)
    if (!child) return false
    if (isWindows()) child.kill()
    else child.kill('SIGTERM')
    this.processes.delete(safeSerial)
    return true
  }

  status(serial: string) {
    const safeSerial = this.validateSerial(serial)
    const child = this.processes.get(safeSerial)
    return Boolean(child && !child.killed)
  }

  stopAll() {
    for (const serial of this.processes.keys()) this.stop(serial)
  }
}

export const scrcpyManager = new ScrcpyManager()
