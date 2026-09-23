# OBA Live Tool 项目交接

更新时间：2026-09-24
项目目录：`oba-live-tool-main`
当前版本：`1.6.3`
项目类型：Electron + React + Vite + TypeScript 的抖音/多平台直播运营工具

这份文档把当前源码、已有 `docs/` 报告，以及此前项目线程中的结论合并在一起。后续接手先看本文件，再看对应源码；不要把旧线程里的“已完成”直接当成当前源码状态。

## 1. 项目目标

当前主线是“网页采集线索，AI 筛选，真机执行私信”：

```text
真实抖音页面登录
  -> 网页接口分页读取视频评论和回复
  -> 过滤无文字评论、按视频入库
  -> 关键词辅助筛选 + AI 语义筛选
  -> 按用户合并并进入私信队列
  -> Android 真机搜索用户、打开私信、填入测试文案
  -> 人工确认后发送，记录成功/失败/跳过
```

边界已经确定：

- 网页端负责评论采集、用户 ID/抖音号提取、线索筛选和队列管理。
- 真机端当前只做私信，不承担评论采集。
- 测试阶段私信固定发送 `1`，不调用 AI 生成私信文案。
- 明确拒绝陌生人私信的用户直接跳过并从待处理队列移除，不反复重试。
- 出站评论/自动回复测试数量固定为 `1`；视频评论采集仍然是“尽量读取全部”，不是只读 1 条。
- 发送前需要确认当前会话仍属于目标用户，不能把页面切换后的消息发给其他人。

## 2. 当前完成度

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| Electron/Vite 基础应用 | 已完成 | 主进程、预加载、React 渲染进程和多账号会话已经存在 |
| 多平台中控台 | 已完成 | 抖音小店、巨量百应、团购、小红书、视频号、快手、淘宝等平台入口保留 |
| 视频评论采集 | 已完成，可继续维护 | 真实登录态 + 页面签名 + 主评论串行分页 + 回复并发分页 |
| 评论过滤与线索库 | 已完成 | 只保留正常文字；纯表情、纯图片、纯视频、真正空评论不入库 |
| AI 筛选页 | 已完成 | 关键词辅助筛选和 AI 全量语义判断分开；按用户合并评论 |
| AI 私信队列 | 已完成 | 队列、审核、分配设备、准备私信、确认发送的状态链路存在 |
| Android 真机控制 | 基本完成，需继续稳定化 | ADB、scrcpy、Accessibility Companion、UI 层读取和私信流程已有实现 |
| 单机十用户实测 | 未形成可重复验收结果 | 之前多次被 MIUI 服务状态、CDP 端口、搜索页兼容性和设备网络打断 |
| 多机调度 | 未完成 | 当前是设备选择/分配链路，不是完整多机调度器 |
| SQLite 后端持久化 | 未完成 | 线索和队列目前仍主要由前端 Zustand + IndexedDB/localStorage 持久化 |

## 3. 代码结构与关键入口

### 前端

| 路径 | 作用 |
| --- | --- |
| `src/App.tsx` | 根组件和 IPC 事件监听 |
| `src/router/index.tsx` | 页面路由 |
| `src/pages/LeadCenter/index.tsx` | 视频评论采集、实时进度、按视频展示线索 |
| `src/pages/LeadScreening/index.tsx` | 关键词筛选、AI 语义判断、按用户分组、送入私信队列 |
| `src/pages/OutreachQueue/index.tsx` | 私信任务审核、设备分配、准备和确认发送 |
| `src/pages/DeviceControl/index.tsx` | Android 设备、Accessibility 状态、投屏/控制入口 |
| `src/pages/AIChat/index.tsx` | AI 助手文本对话 |
| `src/hooks/useLeadStore.ts` | 线索持久化、去重、导入和状态更新 |
| `src/hooks/useOutreachQueue.ts` | 私信队列持久化和状态机 |
| `src/hooks/useAIProvider.ts` | `chat` 与 `autoReply` 两套 AI 配置 |
| `src/hooks/useProviders.ts` | 从主进程读取动态 provider/model 列表 |

### Electron 主进程

| 路径 | 作用 |
| --- | --- |
| `electron/main/app.ts` | Electron 启动、Provider 初始化和全局事件 |
| `electron/main/services/ProviderService.ts` | 读取内置 provider、缓存和 CDN 最新列表 |
| `electron/main/services/AIChatServices.ts` | OpenAI 兼容接口、流式/非流式调用、Key 检查 |
| `electron/main/platforms/douyin/videoCommentCollector.ts` | 抖音视频评论采集器 |
| `electron/main/platforms/douyin/replyABogus.ts` | 回复接口本地 `a_bogus` 签名分支 |
| `electron/main/managers/AndroidDeviceManager.ts` | ADB、UI 解析、抖音搜索、准备私信、确认发送 |
| `electron/main/managers/AndroidAccessibilityManager.ts` | Companion 的安装、端口转发、健康检查和控制命令 |
| `electron/main/managers/Uiautomator2Manager.ts` | 当前源码仍保留的 UIAutomator2 管理器 |
| `electron/main/services/WebSocketService.ts` | 评论监听 WebSocket 广播 |
| `electron/main/ipc/aichat.ts` | AI 对话 IPC |
| `electron/main/ipc/commentListener.ts` | 自动回复监听和固定数量回复 |
| `electron/main/ipc/device.ts` | 真机控制 IPC |

### 共享类型与资源

| 路径 | 作用 |
| --- | --- |
| `shared/types.d.ts` | 线索、评论、设备、任务、AI provider 类型 |
| `shared/ipcChannels.ts` | 主进程与渲染进程 IPC 名称 |
| `shared/providers.ts` | 离线内置 provider/model 降级配置 |
| `shared/outreachPolicy.ts` | 测试私信/评论固定文本、拒绝识别、会话身份匹配辅助函数 |
| `shared/commentText.ts` | 正常评论文字判断 |
| `resources/android-accessibility/` | Android Accessibility Companion APK 源码和构建脚本 |
| `resources/scrcpy/scrcpy-win64-v4.1/` | 内置 Windows scrcpy/ADB |
| `resources/uiautomator2/` | 当前仍存在并被打包的 UIAutomator2 Python bridge |

## 4. 评论采集链路

采集要求用户先在真实抖音页面完成登录或验证，然后使用该页面的会话请求评论接口。采集器不依赖滚动评论区，也不使用 OCR。

实现要点：

- 主评论接口按游标串行分页，保证签名请求顺序稳定。
- 回复线程最高 6 路并发，限制后降到 `6 -> 3 -> 1`。
- 主评论使用页面实时签名；回复使用 `replyABogus.ts` 的本地 `a_bogus` 分支。
- 解析用户 ID、抖音号、昵称、评论内容、父评论关系、视频 ID 和来源 URL。
- `shared/commentText.ts` 过滤纯表情、纯图片、纯视频、纯符号和空内容；“图片/视频 + 正常文字”保留文字部分。
- 采集进度包含官方评论计数、实际返回数、未纳入数量、分页数、速度和状态。
- 当前 UI 入口在 `LeadCenter` 中把 `maxPages` 设为 `1000`、`maxComments` 设为 `100_000`，实际采集器也会做边界限制。

历史验证数据仅供判断链路，不代表下一次结果：

| 场景 | 结果 |
| --- | --- |
| 视频 `7675505205047348543` | 519 条主评论 + 136 条回复 = 655 条，曾完成全分页 |
| 另一轮文字过滤复测 | 642 条有效文字评论；无文字占位项为 0 |
| 视频《大学女生打麻将！》 | 接口返回 4,729 条，过滤后 2,743 条有效文字线索；官方计数 22,543 |

官方计数大于实际返回是正常现象，可能包含删除、审核折叠、权限不可见、未下发回复或动态变化的内容；不要把差额直接当成程序漏读。

正式记录：[`docs/2026-09-20_签名逆向-抖音评论接口-report.md`](docs/2026-09-20_签名逆向-抖音评论接口-report.md)。报告中不要补写 Cookie、真实 token、动态签名或敏感请求头。

## 5. AI 筛选与模型配置

### AI 业务行为

`LeadScreening` 使用 `useAIProvider('chat')`，每批最多 25 个用户，最多 3 路并发。输入按用户聚合，每个用户最多带 4 条评论，每条最多 240 字符。AI 必须返回 JSON 数组，字段为：

```json
[
  {
    "key": "0",
    "intent": "high_intent|considering|knowledgeable|engagement|irrelevant",
    "score": 0,
    "need": "用户需求",
    "keywords": ["依据词"],
    "reason": "30字内依据"
  }
]
```

分类含义：

- `high_intent`：明确询价、购买、求链接、求联系方式。
- `considering`：主动提问、了解产品、表达兴趣或想学习。
- `knowledgeable`：对产品/领域有具体经验、认知或观点，适合继续沟通。
- `engagement`：口令、表情、泛泛夸赞、玩笑等普通互动。
- `irrelevant`：与产品或目标无关。

关键词只是快速辅助，不会限制 AI 读取未命中关键词的用户。关键词命中后可以直接批量确认为高意向；AI 全量判断后，成功结果移出“待分析”，失败项保留。

### 项目运行时 provider/model

模型列表来自两层：

1. `shared/providers.ts`：内置离线降级列表，首次启动可用。
2. `providers.json`：启动后由 `ProviderService` 从本地缓存或 CDN 更新；当前工作区文件是最近一次列表快照。

当前 provider：

| Provider | Base URL | 当前快照中的模型 | 备注 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro` | 内置降级列表还包含 `deepseek-v4-flash`、`deepseek-chat`、`deepseek-reasoner`，两层列表存在版本差异，遇到模型不存在先刷新 provider 列表 |
| OpenRouter | `https://openrouter.ai/api/v1` | `~deepseek/deepseek-pro-latest`、`deepseek/deepseek-v4-pro-0813`、`deepseek/deepseek-v4-pro-0813:batch`、`~deepseek/deepseek-v4-flash-latest`、`deepseek/deepseek-v4-flash-0731`、`deepseek/deepseek-v4-flash-0731:batch`、`deepseek/deepseek-v4-flash-0731:free`、`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v3.2`、`deepseek/deepseek-v3.2-exp`、`deepseek/deepseek-v3.1-terminus`、`deepseek/deepseek-chat-v3.1`、`deepseek/deepseek-r1-0528`、`deepseek/deepseek-chat-v3-0324`、`deepseek/deepseek-r1-distill-llama-70b`、`deepseek/deepseek-r1`、`deepseek/deepseek-chat` | Key 检查走 `/credits`，适合统一切换模型和供应商 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V4-Flash`、`deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V3.2`、`Pro/deepseek-ai/DeepSeek-V3.2`、`deepseek-ai/DeepSeek-V3.1-Terminus`、`Pro/deepseek-ai/DeepSeek-V3.1-Terminus`、`deepseek-ai/DeepSeek-R1`、`Pro/deepseek-ai/DeepSeek-R1`、`deepseek-ai/DeepSeek-V3`、`Pro/deepseek-ai/DeepSeek-V3`、`deepseek-ai/DeepSeek-OCR`、`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` | 需要硅基流动 API Key |
| 火山引擎 | `https://ark.cn-beijing.volces.com/api/v3/` | 当前为空 | 需要先创建 Ark 接入点，把接入点 ID 当作模型名填写 |
| 自定义 | 用户填写 | 用户填写 | 只要兼容 OpenAI Chat Completions 接口即可 |

推荐选择：

- 大批量评论筛选优先用列表中的 V3.2/Flash 类快速模型，成本和吞吐更适合 25 条一批、3 路并发。
- 需要更复杂语义判断时用 Pro 或 R1 类模型，速度和费用会更高。
- `AI 助手` 和 `自动回复` 的配置分别保存，线索筛选使用 `chat` 配置；不要以为改了自动回复模型就会改变线索筛选。
- API Key 只放应用的本地 AI 配置，不写入源码、报告、日志或交接文件。

### 继续开发时的 Codex 模型分工

此前约定是“强模型负责规划和最终审查，轻量模型处理简单独立任务”：

- 架构设计、跨模块改动、真机链路、最终 code review：优先强模型，如 `gpt-6-astra` 或 `gpt-5.6-sol`。
- 文件盘点、单个 smoke、格式整理、简单文档：可用 `gpt-5.6-terra` 或 `gpt-5.6-luna`。
- 复杂问题一旦涉及签名、Android 系统、队列状态或真实设备，直接升级强模型，不要让轻量模型猜测。
- 旧线程曾通过 CC Switch 使用 `gpt-6-astra`，返回过 `403 insufficient balance`；如果继续出现同类错误，先换有余额的 provider/model，别把它误判成项目代码错误。

## 6. 真机控制与私信

### 已有实现

- 已接入 ADB 设备发现、截图、启动抖音、UI 层读取、点击、滑动、返回、Home、最近任务、文本输入。
- 内置 scrcpy 位于 `resources/scrcpy/scrcpy-win64-v4.1/`，可用于投屏和手动控制。
- Android Companion 包名：`com.obalivetool.accessibility`。
- 当前源码 Companion 版本：`0.2.0`；本地端口：`27191`；服务以前台通知运行。
- Companion 通过 `adb forward` 暴露本机控制接口，桌面端由 `AndroidAccessibilityManager` 管理。
- 当前已知真机：序列号 `5efba685`，Xiaomi MIX 2，Android 9 / SDK 28，分辨率 1080×2160。

### 私信流程

1. 线索筛选页按用户合并评论，生成队列任务。
2. 队列默认状态 `pending_review`，人工审核后分配设备。
3. `prepareOutreach` 回到抖音搜索框，输入抖音号/用户 ID，进入“用户”结果，核对主页抖音号，再打开私信页。
4. 真机输入固定测试文案 `1`，状态变为等待确认。
5. `confirmOutreach` 再检查抖音包、私信 Activity、顶部昵称、输入框和发送按钮，然后才点击发送。
6. 发送后检查拒绝提示、发送失败提示、消息数量变化和输入框是否仍有文案，再尝试回到搜索框。
7. 明确拒绝模式由 `shared/outreachPolicy.ts` 识别，队列应标记 `skipped` 并移除；普通网络/设备失败仍可保留 `failed` 供人工重试。

固定策略源码：

```ts
TEST_OUTREACH_MESSAGE = '1'
TEST_COMMENT_MESSAGE = '1'
TEST_COMMENT_COUNT = 1
```

### 设备系统限制

这台小米设备曾确认会拦截：

- `adb shell input`、Monkey、UIAutomator2 的跨应用触控注入。
- `settings put secure`、`pm grant`。
- 无人值守 APK 更新，常见错误是 `INSTALL_FAILED_USER_RESTRICTED`。
- MIUI 可能清掉无障碍服务；安装/重启/系统清理后要重新确认 OBA 服务是否开启。

普通 MTP 只能传文件，不能控制屏幕。无需 SIM 卡，也不依赖“小米 USB 调试（安全设置）”，但首次安装和开启无障碍服务可能必须在手机上人工确认。scrcpy UHID 可以投屏或作为手动输入兜底，但不要把它当成这台 Android 9 ROM 上可靠的自动点击接口。

### 当前源码的真实实现差异

之前线程里曾计划“移除 UIAutomator2，只保留 Accessibility”，但当前源码仍然：

- `AndroidDeviceManager.ts` 导入 `Uiautomator2Manager`。
- `dumpUi()` 先调用 UIAutomator2，失败后才调用 `AndroidAccessibilityManager.dumpUi()`。
- `resources/uiautomator2/` 仍存在，并在 `electron-builder.json` 中作为额外资源打包。

后续如果继续解决 Android 9 的服务解绑问题，应先统一读取链路，再验证 Companion 的长期稳定性；不要只改交接文字。

## 7. 已知问题与下一步

按优先级处理：

### P0：先恢复可重复的单机发送验收

- 用一台已授权设备，准备至少 10 个真实且允许私信的不同用户。
- 启动 Electron 时确认 CDP 端口，`scripts/outreach-ten-test.mjs` 当前连接 `127.0.0.1:9223`；旧线程里的 UI smoke 常用 `9222`，两者必须统一。
- 每个用户只发送 `1`，发送后回搜索框继续下一个。
- 记录每个用户的 `prepared/sent/rejected/failed`，拒绝用户不再重试。
- 任何没有明确新消息证据的结果都保留人工核对状态，不要直接记成 `sent`。

### P1：发送前后身份与去重

- `confirmOutreach` 当前用私信顶部昵称核对，仍应补充稳定的抖音号/用户 ID 核对，避免同名用户或确认窗口内切换会话。
- 跨视频选择用户时统一按稳定 `userId`/`douyinId` 去重，队列任务 ID 不能只依赖 `videoId + identity`。
- 删除或收紧搜索结果坐标回退；只有精确匹配目标抖音号才能打开主页。
- 发送成功判断不要只依赖旧的 `1` 气泡数量和固定 2 秒等待，最好记录发送前快照并核对新增消息或明确发送状态。

### P1：真机稳定性

- 统一 UI 读取引擎：UIAutomator2 和自定义 Accessibility 同时运行会在 Android 9/MIUI 上争抢 `UiAutomation`，曾导致 OBA 服务被解绑。
- 继续保留“服务被系统关闭”和“端口未连接”的不同状态提示。
- 新 APK 安装后确认手机实际版本；线程中曾出现源码已经是 `0.2.0`、手机仍运行旧 `0.1.0` 的情况。

### P2：工程化

- 给 `vitest` 补齐依赖或调整 `package.json` 测试脚本；当前 `pnpm test` 会在 Vite 构建后因找不到 `vitest` 失败。
- 清理现有 Biome 存量问题，再把 Biome 检查缩小到本次改动文件，避免全项目噪声掩盖真正错误。
- 多机并发前把线索/队列迁移到 SQLite 或主进程数据库，增加任务锁、用户级去重、设备冷却和失败回放。
- 真机评论读取目前没有实现；如果将来要做 Android 评论来源，应新增独立采集通道，不要把私信执行器和评论采集混在一起。

## 8. 常用命令

在项目根目录执行：

```powershell
pnpm install
pnpm dev
pnpm build
pnpm exec tsc --noEmit
pnpm exec tsx scripts/outreach-policy-smoke.ts
pnpm exec tsx scripts/video-comment-parser-smoke.ts
pnpm exec tsx scripts/reply-a-bogus-smoke.ts
```

UI smoke 的前提是 Electron 正在运行并开放对应 CDP 端口；只启动 Vite 不够。真机脚本还要求 ADB 设备状态为 `device`，并且 OBA Companion 已安装、无障碍服务已启用、端口转发可用。

## 9. 当前验证记录

2026-09-24 在当前工作区新跑的结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 通过 |
| `scripts/outreach-policy-smoke.ts` | 通过，固定文案为 `1` |
| `scripts/video-comment-parser-smoke.ts` | 通过，解析/去重/并发降速断言通过 |
| `scripts/reply-a-bogus-smoke.ts` | 通过，签名长度断言通过 |
| `pnpm build` | 通过，重新生成 Windows x64 安装包 |
| `pnpm exec biome check electron src shared scripts ...` | 未通过，存在多处既有格式、未使用变量、CSS Tailwind 解析配置问题；未自动修改 |
| `pnpm test` | 未通过，`pretest` 的 Vite 构建成功，但环境中没有可执行的 `vitest` |

此前线程还验证过生产构建、评论采集页面、真机控制页面和 Windows x64 安装包；接手后若改动主进程、Android 或私信逻辑，应重新跑 `pnpm build` 并做设备实测。

## 10. 重要资料与工作约定

- 不要把 API Key、Cookie、真实登录态、动态签名、设备私密数据写入文档或日志。
- 当前目录没有 `.git` 历史，不能依赖 `git status`/`git diff` 判断变更；以文件时间、源码和 smoke 输出为准。
- 旧线程中的主要需求顺序是：先网页评论采集，再独立 AI 筛选页，再真机私信；评论采集和真机执行是两条不同链路。
- 先修 P0/P1 的真实链路和身份校验，再扩展多机、自动生成话术或 Android 评论采集。

历史线程索引：

- `01a0b8ea-90b7-7632-be2f-68c259ff2faf`：评论采集、AI 筛选页、私信队列和真机控制的原始设计与实现过程。
- `01a0c98b-33bc-7f80-abee-221b2569c058`：接续项目、修复真机搜索/私信流程、固定发送 `1`、拒绝用户跳过和 MIUI 保活问题。
- `01a0ce03-6e58-70c0-a73e-3cd60172d518`：最近一次只读审查，指出身份校验、去重、搜索回退和发送成功判定需要继续收紧。
