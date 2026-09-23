import { IPC_CHANNELS } from 'shared/ipcChannels'
import { androidAccessibilityManager } from '#/managers/AndroidAccessibilityManager'
import { androidDeviceManager } from '#/managers/AndroidDeviceManager'
import { scrcpyManager } from '#/managers/ScrcpyManager'
import { typedIpcMainHandle } from '#/utils'

export function setupDeviceIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.device.list, () => androidDeviceManager.listDevices())
  typedIpcMainHandle(IPC_CHANNELS.device.screenshot, (_, serial) =>
    androidDeviceManager.screenshot(serial),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.tap, (_, serial, x, y) =>
    androidDeviceManager.tap(serial, x, y),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.swipe, (_, serial, fromX, fromY, toX, toY, durationMs) =>
    androidDeviceManager.swipe(serial, fromX, fromY, toX, toY, durationMs),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.key, (_, serial, key) =>
    androidDeviceManager.key(serial, key),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.launchDouyin, (_, serial) =>
    androidDeviceManager.launchDouyin(serial),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.dumpUi, (_, serial) => androidDeviceManager.dumpUi(serial))
  typedIpcMainHandle(IPC_CHANNELS.device.inputText, (_, serial, text) =>
    androidDeviceManager.inputText(serial, text),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.accessibilityStatus, (_, serial) =>
    androidAccessibilityManager.status(serial),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.installAccessibility, (_, serial) =>
    androidAccessibilityManager.install(serial),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.openAccessibilitySettings, (_, serial) =>
    androidAccessibilityManager.openSettings(serial),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.prepareOutreach, (_, serial, target) =>
    androidDeviceManager.prepareOutreach(serial, target),
  )
  typedIpcMainHandle(IPC_CHANNELS.device.confirmOutreach, (_, serial, taskId) =>
    androidDeviceManager.confirmOutreach(serial, taskId),
  )
  typedIpcMainHandle(IPC_CHANNELS.scrcpy.start, (_, serial) => scrcpyManager.start(serial))
  typedIpcMainHandle(IPC_CHANNELS.scrcpy.stop, (_, serial) => scrcpyManager.stop(serial))
  typedIpcMainHandle(IPC_CHANNELS.scrcpy.status, (_, serial) => scrcpyManager.status(serial))
}
