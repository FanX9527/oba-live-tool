# Android automation runtime

The Electron main process starts `bridge.py` as a persistent JSON-lines worker. Business code talks to `Uiautomator2Manager`; it does not depend on Python APIs directly.

Runtime lookup order:

1. `OBA_PYTHON_PATH`
2. The application-managed virtual environment under Electron `userData`
3. A compatible system Python with `uiautomator2` installed

The Device Control page can create or repair the managed environment from `requirements.txt`. Keep the Python dependency pinned and update the bridge contract and TypeScript manager together.
