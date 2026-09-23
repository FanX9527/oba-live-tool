from __future__ import annotations

import importlib.metadata
import json
import sys
import threading
from typing import Any

import uiautomator2 as u2


OUTPUT_PREFIX = "__OBA_UIA2__"
_devices: dict[str, Any] = {}
_device_locks: dict[str, threading.Lock] = {}
_output_lock = threading.Lock()

# Electron writes JSON lines as UTF-8. Windows otherwise uses the active ANSI
# code page for redirected Python streams, which corrupts Chinese UI text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def write_response(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _output_lock:
        sys.stdout.write(f"{OUTPUT_PREFIX}{encoded}\n")
        sys.stdout.flush()


def require_serial(request: dict[str, Any]) -> str:
    serial = str(request.get("serial") or "").strip()
    if not serial:
        raise ValueError("设备序列号不能为空")
    return serial


def get_device(serial: str):
    device = _devices.get(serial)
    if device is None:
        device = u2.connect_usb(serial)
        device.info
        _devices[serial] = device
    return device


def execute(request: dict[str, Any]) -> Any:
    action = request.get("action")
    params = request.get("params") or {}

    if action == "ping":
        return {"version": importlib.metadata.version("uiautomator2")}

    serial = require_serial(request)
    lock = _device_locks.setdefault(serial, threading.Lock())
    with lock:
        if action == "disconnect":
            _devices.pop(serial, None)
            return True

        device = get_device(serial)
        if action == "connect":
            info = device.info
            return {
                "displayWidth": info.get("displayWidth"),
                "displayHeight": info.get("displayHeight"),
                "sdkInt": info.get("sdkInt"),
                "screenOn": info.get("screenOn"),
            }
        if action == "click":
            device.click(params["x"], params["y"])
            return True
        if action == "swipe":
            device.swipe(
                params["fromX"],
                params["fromY"],
                params["toX"],
                params["toY"],
                duration=params.get("duration", 0.2),
            )
            return True
        if action == "press":
            device.press(params["key"])
            return True
        if action == "dump_hierarchy":
            return device.dump_hierarchy(compressed=True, pretty=False)
        if action == "clear_text":
            device.clear_text()
            return True
        if action == "send_keys":
            device.send_keys(str(params.get("text") or ""), clear=bool(params.get("clear")))
            return True
        if action == "app_start":
            device.app_start(
                str(params["package"]),
                wait=bool(params.get("wait", True)),
                stop=bool(params.get("stop", False)),
            )
            return True
        if action == "app_current":
            return device.app_current()

    raise ValueError(f"不支持的自动化动作: {action}")


def handle_line(line: str) -> None:
    request_id: Any = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        result = execute(request)
        write_response({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        write_response(
            {
                "id": request_id,
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            }
        )


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if line:
            handle_line(line)


if __name__ == "__main__":
    main()
