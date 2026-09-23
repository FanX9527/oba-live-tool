import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  isExpectedOutreachChatHeader,
  isExpectedOutreachProfile,
  isOutreachDeliveryRejected,
  TEST_OUTREACH_MESSAGE,
} from 'shared/outreachPolicy'
import { createLogger } from '#/logger'
import { androidAccessibilityManager } from './AndroidAccessibilityManager'
import {
  nodeContains,
  nodeEquals,
  nodeTexts,
  normalizeUiText,
  parseAndroidUiHierarchy,
} from './androidUiHierarchy'
import { uiautomator2Manager } from './Uiautomator2Manager'

const execFileAsync = promisify(execFile)
const logger = createLogger('AndroidDeviceManager')
const DOUYIN_PACKAGE = 'com.ss.android.ugc.aweme'
const PREPARED_OUTREACH_TTL_MS = 10 * 60 * 1000
const SEARCH_RETURN_MAX_BACK_PRESSES = 4

interface AdbOutput {
  stdout: string
  stderr: string
}

interface ParsedAdbDevice {
  serial: string
  state: AndroidDeviceState
  model?: string
  product?: string
  device?: string
}

interface PreparedOutreach {
  taskId: string
  douyinId: string
  nickname: string
  draftMessage: string
  preparedAt: number
}

type UiNodeMatcher = (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function normalizeState(state: string): AndroidDeviceState {
  if (state === 'device' || state === 'unauthorized' || state === 'offline') return state
  return 'unknown'
}

export function parseAdbDevices(output: string): ParsedAdbDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [serial = '', rawState = '', ...metadata] = line.split(/\s+/)
      const attributes = Object.fromEntries(
        metadata
          .map(item => item.split(':', 2))
          .filter((item): item is [string, string] => item.length === 2),
      )

      return {
        serial,
        state: normalizeState(rawState),
        model: attributes.model?.replaceAll('_', ' '),
        product: attributes.product,
        device: attributes.device,
      }
    })
    .filter(device => device.serial)
}

class AndroidDeviceManager {
  private adbPath?: string

  private preparedOutreach = new Map<string, PreparedOutreach>()

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

    try {
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
    } catch (error) {
      logger.debug('未在 PATH 中找到 ADB', error)
    }

    throw new Error('未找到 ADB，请安装 Android SDK Platform-Tools')
  }

  private async execute(args: string[], timeout = 10_000): Promise<AdbOutput> {
    const adbPath = await this.findAdbPath()
    try {
      const result = await execFileAsync(adbPath, args, {
        windowsHide: true,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string }
      const message = detail.stderr?.trim() || detail.stdout?.trim() || detail.message
      throw new Error(message)
    }
  }

  private validateSerial(serial: string): string {
    if (!/^[a-zA-Z0-9._:-]+$/.test(serial)) throw new Error('无效的设备序列号')
    return serial
  }

  private coordinate(value: number): string {
    if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new Error('无效的屏幕坐标')
    return String(Math.round(value))
  }

  private async executeForDevice(serial: string, args: string[], timeout?: number) {
    return this.execute(['-s', this.validateSerial(serial), ...args], timeout)
  }

  private async shell(serial: string, args: string[], timeout?: number): Promise<string> {
    const { stdout } = await this.executeForDevice(serial, ['shell', ...args], timeout)
    return stdout.trim()
  }

  private async accessibilityCommand(
    serial: string,
    action: 'clear_text' | 'global' | 'set_text' | 'swipe' | 'tap',
    params: Record<string, unknown> = {},
  ) {
    try {
      await androidAccessibilityManager.command(serial, { action, ...params })
      return
    } catch (error) {
      logger.debug(`无障碍组件 ${action} 不可用`, error)
      throw new Error(
        `真机控制服务未就绪，无法执行 ${action}。请在手机的无障碍设置中开启 OBA 真机控制后重试`,
      )
    }
  }

  private async currentPackage(serial: string) {
    const focus = await this.shell(serial, ['dumpsys', 'window', 'windows'])
    return focus.match(/mCurrentFocus=.*?\s([\w.]+)\//)?.[1]
  }

  private async currentActivity(serial: string) {
    const focus = await this.shell(serial, ['dumpsys', 'window', 'windows'])
    return focus.match(/mCurrentFocus=.*?\s[\w.]+\/([^\s}]+)/)?.[1] ?? ''
  }

  private actionableNode(snapshot: AndroidUiSnapshot, node: AndroidUiNode) {
    let current: AndroidUiNode | undefined = node
    while (current) {
      if (current.enabled && current.clickable && current.bounds) return current
      current = current.parentIndex === null ? undefined : snapshot.nodes[current.parentIndex]
    }
    return node.enabled && node.bounds ? node : undefined
  }

  private async tapUiNode(serial: string, snapshot: AndroidUiSnapshot, node: AndroidUiNode) {
    const target = this.actionableNode(snapshot, node)
    if (!target?.bounds) throw new Error('目标控件没有可点击区域')
    await this.tap(serial, target.bounds.centerX, target.bounds.centerY)
  }

  private async waitForUiNode(
    serial: string,
    matcher: UiNodeMatcher,
    label: string,
    timeout = 12_000,
  ) {
    const deadline = Date.now() + timeout
    let latest: AndroidUiSnapshot | null = null
    while (Date.now() < deadline) {
      latest = await this.dumpUi(serial)
      const node = matcher(latest)
      if (node) return { snapshot: latest, node }
      await delay(600)
    }
    const visibleText = (latest?.nodes ?? [])
      .flatMap(node => [node.text, node.contentDescription])
      .filter(Boolean)
      .slice(0, 12)
      .join(' / ')
    throw new Error(`未找到${label}${visibleText ? `；当前页面：${visibleText}` : ''}`)
  }

  private findSearchButton(snapshot: AndroidUiSnapshot) {
    return snapshot.nodes
      .filter(node => node.enabled && node.bounds && nodeContains(node, ['搜索', 'search']))
      .sort((left, right) => {
        const score = (node: AndroidUiNode) =>
          (nodeEquals(node, ['搜索', 'search']) ? 20 : 0) +
          (node.clickable ? 10 : 0) +
          (node.resourceId.toLowerCase().includes('search') ? 5 : 0)
        return score(right) - score(left)
      })[0]
  }

  private async ensureSearchInput(serial: string) {
    const currentPackage = await this.currentPackage(serial).catch(() => undefined)
    if (currentPackage !== DOUYIN_PACKAGE) {
      await this.launchDouyin(serial)
      await delay(1_500)
    }

    for (let attempt = 0; attempt <= SEARCH_RETURN_MAX_BACK_PRESSES; attempt += 1) {
      const snapshot = await this.dumpUi(serial)
      const input = this.findTextInput(snapshot, 'search')
      if (input) {
        await this.tapUiNode(serial, snapshot, input)
        await this.clearFocusedInput(serial)
        return
      }

      const activity = await this.currentActivity(serial)
      if (/ChatRoomActivity|UserProfileActivity/.test(activity)) {
        await this.key(serial, 'BACK')
        await delay(700)
        continue
      }

      const searchButton = this.findSearchButton(snapshot)
      if (searchButton) {
        await this.tapUiNode(serial, snapshot, searchButton)
        await delay(700)
        continue
      }

      if (attempt < SEARCH_RETURN_MAX_BACK_PRESSES) {
        await this.key(serial, 'BACK')
        await delay(700)
      }
    }

    throw new Error('发送后未能回到抖音搜索框，请检查真机当前页面')
  }

  private findTextInput(snapshot: AndroidUiSnapshot, kind: 'search' | 'chat') {
    const inputs = snapshot.nodes.filter(
      node =>
        node.enabled &&
        node.bounds &&
        (node.className.endsWith('EditText') || node.resourceId.toLowerCase().includes('edit')) &&
        (kind !== 'search' ||
          node.resourceId.toLowerCase().includes('search') ||
          nodeContains(node, ['搜索', 'search'])),
    )
    const hints =
      kind === 'search' ? ['搜索', 'search'] : ['发送消息', '发消息', '输入', 'message', 'edit']
    return inputs.sort((left, right) => {
      const score = (node: AndroidUiNode) =>
        (nodeContains(node, hints) ? 20 : 0) + (node.focused ? 10 : 0)
      return score(right) - score(left)
    })[0]
  }

  private findUserTab(snapshot: AndroidUiSnapshot) {
    return snapshot.nodes.find(
      node => node.enabled && node.bounds && nodeEquals(node, ['用户', 'users']),
    )
  }

  private findUserResult(snapshot: AndroidUiSnapshot, target: AndroidOutreachTarget, index = 0) {
    if (!target.douyinId.trim()) return undefined
    const matchesTarget = (node: AndroidUiNode) => {
      return nodeTexts(node).some(text => isExpectedOutreachProfile([text], target.douyinId))
    }

    const candidates = snapshot.nodes
      .filter(node => node.enabled && !node.className.endsWith('EditText') && matchesTarget(node))
      .map(node => {
        let current: AndroidUiNode | undefined = node
        while (current && !current.bounds) {
          current = current.parentIndex === null ? undefined : snapshot.nodes[current.parentIndex]
        }
        return current
      })
      .filter((node): node is AndroidUiNode => Boolean(node?.bounds))

    const matched = candidates.sort(
      (left, right) => Number(right.clickable) - Number(left.clickable),
    )[0]
    if (index === 0 && matched) return matched

    // Douyin draws some user cards without accessible text. Open the first
    // candidate only; the profile account ID is checked before opening chat.
    const followButton = snapshot.nodes.filter(
      node => node.enabled && node.bounds && nodeContains(node, ['关注按钮']),
    )[index]
    if (!followButton?.bounds) return undefined
    const { top, bottom } = followButton.bounds
    return {
      ...followButton,
      clickable: false,
      parentIndex: null,
      bounds: {
        left: 120,
        right: 700,
        top,
        bottom,
        centerX: 400,
        centerY: Math.round((top + bottom) / 2),
      },
    }
  }

  private findPrivateMessageButton(snapshot: AndroidUiSnapshot) {
    return snapshot.nodes
      .filter(
        node =>
          node.enabled &&
          node.bounds &&
          (nodeEquals(node, ['私信', '发私信']) || nodeContains(node, ['私信'])),
      )
      .sort((left, right) => Number(right.clickable) - Number(left.clickable))[0]
  }

  private findSendButton(snapshot: AndroidUiSnapshot) {
    return snapshot.nodes
      .filter(
        node =>
          node.enabled &&
          node.bounds &&
          (nodeEquals(node, ['发送', 'send']) ||
            (node.resourceId.toLowerCase().includes('send') && node.clickable)),
      )
      .sort((left, right) => {
        const score = (node: AndroidUiNode) =>
          (nodeEquals(node, ['发送', 'send']) ? 20 : 0) + (node.clickable ? 10 : 0)
        return score(right) - score(left)
      })[0]
  }

  private findDeliveryRejection(snapshot: AndroidUiSnapshot) {
    const texts = snapshot.nodes.flatMap(node => nodeTexts(node)).filter(Boolean)
    const combined = texts.join(' ')
    if (!isOutreachDeliveryRejected(combined)) return undefined
    return texts.find(text => isOutreachDeliveryRejected(text)) || combined
  }

  private async clearFocusedInput(serial: string) {
    await this.accessibilityCommand(serial, 'clear_text')
  }

  private async getDeviceDetails(device: ParsedAdbDevice): Promise<AndroidDevice> {
    if (device.state !== 'device') return device

    const safeShell = async (args: string[]) => {
      try {
        return await this.shell(device.serial, args)
      } catch (error) {
        logger.debug(`读取设备 ${device.serial} 信息失败`, error)
        return ''
      }
    }

    const [
      manufacturer,
      model,
      androidVersion,
      sdk,
      abi,
      screenOutput,
      densityOutput,
      battery,
      appPath,
      focus,
    ] = await Promise.all([
      safeShell(['getprop', 'ro.product.manufacturer']),
      safeShell(['getprop', 'ro.product.model']),
      safeShell(['getprop', 'ro.build.version.release']),
      safeShell(['getprop', 'ro.build.version.sdk']),
      safeShell(['getprop', 'ro.product.cpu.abi']),
      safeShell(['wm', 'size']),
      safeShell(['wm', 'density']),
      safeShell(['dumpsys', 'battery']),
      safeShell(['pm', 'path', DOUYIN_PACKAGE]),
      safeShell(['dumpsys', 'window', 'windows']),
    ])

    const sizes = [...screenOutput.matchAll(/(\d+)x(\d+)/g)]
    const activeSize = sizes.at(-1)
    const densities = [...densityOutput.matchAll(/(\d+)/g)]
    const density = Number(densities.at(-1)?.[1]) || undefined
    const batteryLevel = Number(battery.match(/level:\s*(\d+)/)?.[1])
    const batteryStatus = Number(battery.match(/status:\s*(\d+)/)?.[1])
    const currentPackage = focus.match(/mCurrentFocus=.*?\s([\w.]+)\//)?.[1]

    return {
      ...device,
      manufacturer: manufacturer || undefined,
      model: model || device.model,
      androidVersion: androidVersion || undefined,
      sdk: Number(sdk) || undefined,
      abi: abi || undefined,
      screen: activeSize
        ? {
            width: Number(activeSize[1]),
            height: Number(activeSize[2]),
            density,
          }
        : undefined,
      battery: Number.isFinite(batteryLevel)
        ? { level: batteryLevel, charging: batteryStatus === 2 || batteryStatus === 5 }
        : undefined,
      douyinInstalled: appPath.startsWith('package:'),
      currentPackage,
    }
  }

  async listDevices(): Promise<AndroidDevice[]> {
    await this.execute(['start-server'])
    const { stdout } = await this.execute(['devices', '-l'])
    const devices = parseAdbDevices(stdout)
    return Promise.all(devices.map(device => this.getDeviceDetails(device)))
  }

  async screenshot(serial: string): Promise<string> {
    const adbPath = await this.findAdbPath()
    const image = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        adbPath,
        ['-s', this.validateSerial(serial), 'exec-out', 'screencap', '-p'],
        {
          encoding: 'buffer',
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.toString().trim() || error.message))
            return
          }
          resolve(stdout)
        },
      )
    })
    return `data:image/png;base64,${image.toString('base64')}`
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    const normalizedX = Number(this.coordinate(x))
    const normalizedY = Number(this.coordinate(y))
    await this.accessibilityCommand(serial, 'tap', {
      x: normalizedX,
      y: normalizedY,
    })
  }

  async swipe(
    serial: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs: number,
  ): Promise<void> {
    const duration = Math.min(5000, Math.max(50, Math.round(durationMs)))
    const coordinates = {
      fromX: Number(this.coordinate(fromX)),
      fromY: Number(this.coordinate(fromY)),
      toX: Number(this.coordinate(toX)),
      toY: Number(this.coordinate(toY)),
    }
    await this.accessibilityCommand(serial, 'swipe', {
      ...coordinates,
      durationMs: duration,
    })
  }

  async key(serial: string, key: AndroidDeviceKey): Promise<void> {
    const keyCodes: Record<AndroidDeviceKey, string> = {
      BACK: '4',
      HOME: '3',
      APP_SWITCH: '187',
    }
    if (!keyCodes[key]) throw new Error('不支持的按键')
    await this.accessibilityCommand(serial, 'global', { key })
  }

  async dumpUi(serial: string): Promise<AndroidUiSnapshot> {
    const hierarchy = await uiautomator2Manager
      .run<string>(serial, 'dump_hierarchy')
      .catch(() => androidAccessibilityManager.dumpUi(serial))
    const currentPackage = await this.currentPackage(serial).catch(() => undefined)
    return {
      capturedAt: Date.now(),
      currentPackage,
      nodes: parseAndroidUiHierarchy(hierarchy),
    }
  }

  async inputText(serial: string, text: string): Promise<void> {
    const value = text.trim()
    if (!value) throw new Error('输入内容不能为空')
    if (value.length > 2_000) throw new Error('输入内容不能超过 2000 个字符')

    await this.accessibilityCommand(serial, 'set_text', { text: value })
  }

  async prepareOutreach(
    serial: string,
    target: AndroidOutreachTarget,
  ): Promise<AndroidOutreachResult> {
    let stage: AndroidOutreachStage = 'opening_search'
    this.preparedOutreach.delete(serial)
    try {
      const identifier = target.douyinId.trim() || target.userId.trim()
      const draftMessage = TEST_OUTREACH_MESSAGE
      if (!target.taskId.trim()) throw new Error('私信任务 ID 不能为空')
      if (!identifier) throw new Error('该用户没有可用于搜索的抖音号或用户 ID')

      stage = 'searching_user'
      await this.ensureSearchInput(serial)
      await this.inputText(serial, identifier)
      const search = await this.waitForUiNode(
        serial,
        snapshot => this.findSearchButton(snapshot),
        '搜索按钮',
      )
      await this.tapUiNode(serial, search.snapshot, search.node)
      const userTab = await this.waitForUiNode(
        serial,
        snapshot => this.findUserTab(snapshot),
        '搜索结果中的用户标签',
      )
      await this.tapUiNode(serial, userTab.snapshot, userTab.node)
      await delay(900)

      stage = 'opening_profile'
      let profile:
        | { snapshot: AndroidUiSnapshot; node: AndroidUiNode }
        | undefined
      for (let index = 0; index < 8; index += 1) {
        const result = await this.waitForUiNode(
          serial,
          snapshot => this.findUserResult(snapshot, target, index),
          `第 ${index + 1} 个用户结果`,
          index === 0 ? 12_000 : 2_000,
        ).catch(() => undefined)
        if (!result) break
        await this.tapUiNode(serial, result.snapshot, result.node)
        let candidateSnapshot: AndroidUiSnapshot | undefined
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if ((await this.currentActivity(serial)).includes('UserProfileActivity')) {
            candidateSnapshot = await this.dumpUi(serial)
            break
          }
          await delay(400)
        }
        if (!candidateSnapshot) continue
        const texts = candidateSnapshot.nodes.flatMap(node => nodeTexts(node))
        if (isExpectedOutreachProfile(texts, target.douyinId)) {
          profile = await this.waitForUiNode(
            serial,
            snapshot => this.findPrivateMessageButton(snapshot),
            '用户主页上的私信按钮',
            8_000,
          ).catch(() => undefined)
          if (!profile) throw new Error('目标用户主页未开放私信入口')
          break
        }
        await this.key(serial, 'BACK')
        await delay(550)
      }
      if (!profile) {
        throw new Error(`搜索结果中未核对到抖音号 ${identifier}，已停止发送`)
      }
      await this.tapUiNode(serial, profile.snapshot, profile.node)

      stage = 'opening_chat'
      const chatInput = await this.waitForUiNode(
        serial,
        snapshot => this.findTextInput(snapshot, 'chat'),
        '私信输入框',
        15_000,
      )
      if (
        !(await this.currentActivity(serial)).includes('ChatRoomActivity') ||
        !isExpectedOutreachChatHeader(chatInput.snapshot.nodes, target.nickname)
      ) {
        throw new Error('私信会话与目标用户不一致，已停止发送')
      }
      await this.tapUiNode(serial, chatInput.snapshot, chatInput.node)

      stage = 'writing_draft'
      await this.clearFocusedInput(serial)
      await this.inputText(serial, draftMessage)
      const ready = await this.waitForUiNode(
        serial,
        snapshot => this.findSendButton(snapshot),
        '可用的发送按钮',
        8_000,
      )
      const currentInput = this.findTextInput(ready.snapshot, 'chat')
      if (currentInput?.text) {
        const actual = normalizeUiText(currentInput.text)
        const expected = normalizeUiText(draftMessage)
        if (!actual.includes(expected) && !expected.includes(actual)) {
          throw new Error('真机输入框内容与当前草稿不一致，已停止发送')
        }
      }

      this.preparedOutreach.set(serial, {
        taskId: target.taskId,
        douyinId: target.douyinId,
        nickname: target.nickname,
        draftMessage,
        preparedAt: Date.now(),
      })
      return {
        ok: true,
        stage: 'awaiting_confirmation',
        message: '已打开目标用户私信并填入草稿，等待人工确认发送',
        matchedText: target.nickname || identifier,
      }
    } catch (error) {
      this.preparedOutreach.delete(serial)
      return {
        ok: false,
        stage,
        message: error instanceof Error ? error.message : '真机准备私信失败',
      }
    }
  }

  async confirmOutreach(serial: string, taskId: string): Promise<AndroidOutreachResult> {
    const prepared = this.preparedOutreach.get(serial)
    if (!prepared || prepared.taskId !== taskId) {
      return {
        ok: false,
        stage: 'sending',
        message: '该设备没有与当前任务匹配的待确认草稿，请重新准备私信',
      }
    }
    if (Date.now() - prepared.preparedAt > PREPARED_OUTREACH_TTL_MS) {
      this.preparedOutreach.delete(serial)
      return {
        ok: false,
        stage: 'sending',
        message: '待确认草稿已超过 10 分钟，请重新准备后再发送',
      }
    }

    try {
      const currentPackage = await this.currentPackage(serial)
      if (currentPackage !== DOUYIN_PACKAGE) {
        throw new Error('真机当前不在抖音私信页面，请重新准备私信')
      }
      const snapshot = await this.dumpUi(serial)
      if (
        !(await this.currentActivity(serial)).includes('ChatRoomActivity') ||
        !isExpectedOutreachChatHeader(snapshot.nodes, prepared.nickname)
      ) {
        throw new Error(`当前私信会话与抖音号 ${prepared.douyinId} 不一致，已停止发送`)
      }
      const input = this.findTextInput(snapshot, 'chat')
      const sendButton = this.findSendButton(snapshot)
      if (!input || !sendButton) throw new Error('当前页面不是可发送的抖音私信会话')
      const messageCountBefore = snapshot.nodes.filter(
        node => node.className.endsWith('TextView') && node.text.trim() === prepared.draftMessage,
      ).length
      if (input.text) {
        const actual = normalizeUiText(input.text)
        const expected = normalizeUiText(prepared.draftMessage)
        if (!actual.includes(expected) && !expected.includes(actual)) {
          throw new Error('真机里的草稿已被修改，请重新准备并确认')
        }
      }

      await this.tapUiNode(serial, snapshot, sendButton)
      this.preparedOutreach.delete(serial)
      await delay(2_000)
      const outcome = await this.dumpUi(serial)
      const rejection = this.findDeliveryRejection(outcome)
      const sendFailed = outcome.nodes.some(node => nodeContains(node, ['发送失败']))
      const messageCountAfter = outcome.nodes.filter(
        node => node.className.endsWith('TextView') && node.text.trim() === prepared.draftMessage,
      ).length
      const inputStillContainsMessage = Boolean(
        this.findTextInput(outcome, 'chat')?.text.includes(prepared.draftMessage),
      )
      if (rejection) {
        await this.ensureSearchInput(serial).catch(error => {
          logger.warn(`私信被拒绝后返回搜索框失败（${serial}）`, error)
        })
        return { ok: false, stage: 'sending', message: rejection }
      }
      if (sendFailed) return { ok: false, stage: 'sending', message: '抖音显示发送失败' }
      if (messageCountAfter <= messageCountBefore || inputStillContainsMessage) {
        return { ok: false, stage: 'sending', message: '未确认私信已发送，已停止并等待人工核对' }
      }
      const returnedToSearch = await this.ensureSearchInput(serial)
        .then(() => true)
        .catch(error => {
          logger.warn(`私信发送后返回搜索框失败（${serial}）`, error)
          return false
        })
      return {
        ok: true,
        stage: 'sent',
        message: returnedToSearch
          ? '已点击发送，未见失败提示，已返回搜索框'
          : '已点击发送，未见失败提示；返回搜索框失败，请检查真机',
      }
    } catch (error) {
      return {
        ok: false,
        stage: 'sending',
        message: error instanceof Error ? error.message : '真机发送失败',
      }
    }
  }

  async launchDouyin(serial: string): Promise<void> {
    const packagePath = await this.shell(serial, ['pm', 'path', DOUYIN_PACKAGE])
    if (!packagePath.startsWith('package:')) throw new Error('当前设备未安装抖音')
    const resolved = await this.shell(serial, [
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      DOUYIN_PACKAGE,
    ])
    const component = resolved
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.startsWith(`${DOUYIN_PACKAGE}/`))
    if (!component) throw new Error('无法解析抖音启动页面')
    await this.shell(serial, ['am', 'force-stop', DOUYIN_PACKAGE], 15_000)
    await delay(800)
    await this.shell(serial, ['am', 'start', '-n', component], 15_000)
  }
}

export const androidDeviceManager = new AndroidDeviceManager()
