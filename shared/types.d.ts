declare type Account = {
  readonly id: string
  name: string
}

declare interface ProviderInfo {
  name: string
  baseURL: string
  apiUrl: string
  models: string[]
}

declare type LiveControlPlatform =
  | 'douyin'
  | 'buyin'
  | 'eos'
  | 'xiaohongshu'
  | 'pgy'
  | 'wxchannel'
  | 'kuaishou'
  | 'taobao'
  | 'dev'

declare type AndroidDeviceState = 'device' | 'unauthorized' | 'offline' | 'unknown'

declare type AndroidDeviceKey = 'BACK' | 'HOME' | 'APP_SWITCH'

declare interface AndroidAccessibilityStatus {
  engine: 'accessibility'
  packageName: string
  installed: boolean
  enabled: boolean
  connected: boolean
  ready: boolean
  installationPending?: boolean
  version?: string
  message: string
}

declare interface AndroidAutomationStatus {
  engine: 'uiautomator2'
  available: boolean
  running: boolean
  ready: boolean
  inputAvailable?: boolean
  inputMessage?: string
  canInstall: boolean
  version?: string
  managedRuntime: boolean
  message: string
}

declare interface AndroidDevice {
  serial: string
  state: AndroidDeviceState
  model?: string
  product?: string
  device?: string
  manufacturer?: string
  androidVersion?: string
  sdk?: number
  abi?: string
  screen?: {
    width: number
    height: number
    density?: number
  }
  battery?: {
    level: number
    charging: boolean
  }
  douyinInstalled?: boolean
  currentPackage?: string
}

declare interface AndroidUiBounds {
  left: number
  top: number
  right: number
  bottom: number
  centerX: number
  centerY: number
}

declare interface AndroidUiNode {
  index: number
  parentIndex: number | null
  text: string
  resourceId: string
  className: string
  packageName: string
  contentDescription: string
  clickable: boolean
  enabled: boolean
  focused: boolean
  scrollable: boolean
  selected: boolean
  bounds: AndroidUiBounds | null
}

declare interface AndroidUiSnapshot {
  capturedAt: number
  currentPackage?: string
  nodes: AndroidUiNode[]
}

declare interface AndroidOutreachTarget {
  taskId: string
  userId: string
  douyinId: string
  nickname: string
  draftMessage: string
}

declare type AndroidOutreachStage =
  | 'opening_search'
  | 'searching_user'
  | 'opening_profile'
  | 'opening_chat'
  | 'writing_draft'
  | 'awaiting_confirmation'
  | 'sending'
  | 'sent'

declare interface AndroidOutreachResult {
  ok: boolean
  stage: AndroidOutreachStage
  message: string
  matchedText?: string
}

declare type GoodsItem = {
  id: number
  /** 单品循环弹窗次数，默认 1 */
  repeatCount?: number
  /** 单品弹窗间隔 [min, max] 毫秒，不设则用全局间隔 */
  itemInterval?: [number, number]
}

declare type AutoPopupConfig = {
  scheduler: {
    interval: [number, number]
  }
  goodsIds: number[]
  goodsItems?: GoodsItem[]
  random?: boolean
}

declare type AutoPopupTask = {
  type: 'auto-popup'
  config: AutoPopupConfig
}

declare type AutoCommentConfig = {
  scheduler: {
    interval: [number, number]
  }
  messages: {
    content: string
    pinTop: boolean
  }[]
  random?: boolean
  extraSpaces?: boolean
  unlimitedLength?: boolean
}

declare type AutoCommentTask = {
  type: 'auto-comment'
  config: AutoCommentConfig
}

declare type SendBatchMessagesConfig = {
  messages: string[]
  count: number
  noSpace?: boolean
}

declare type SendBatchMessagesTask = {
  type: 'send-batch-messages'
  config: SendBatchMessagesConfig
}

declare interface CommentListenerConfig {
  source: 'compass' | 'control' | 'wechat-channel' | 'xiaohongshu' | 'taobao' | 'kuaishou'
  ws?: {
    port: number
  }
}

declare interface VideoCommentCollectOptions {
  videoUrl: string
  /** 用于把实时进度只投递给本次采集。 */
  requestId?: string
  maxPages?: number
  maxComments?: number
  /** 可见浏览器遇到登录或安全验证时，等待人工完成的最长时间。 */
  interactiveAuthWaitMs?: number
}

declare interface VideoCommentRecord {
  commentId: string
  parentCommentId: string
  isReply: boolean
  userId: string
  douyinId: string
  nickname: string
  comment: string
  createdAt: number
  videoId: string
  sourceUrl: string
}

declare interface VideoCommentCollectionProgress {
  requestId: string
  videoId: string
  videoTitle: string
  sourceUrl: string
  phase: 'opening' | 'root' | 'replies' | 'verification' | 'complete'
  comments: VideoCommentRecord[]
  totalComments: number
  rootComments: number
  replies: number
  /** 视频详情/评论接口声明的评论总数，尚未读取到时为 null。 */
  officialCommentCount: number | null
  /** 官方计数中未被网页评论接口实际返回的数量。 */
  unavailableCommentCount: number
  pagesObserved: number
  elapsedMs: number
  commentsPerSecond: number
  message: string
}

declare interface VideoCommentCollectionResult {
  videoId: string
  videoTitle: string
  sourceUrl: string
  finalUrl: string
  comments: VideoCommentRecord[]
  officialCommentCount: number | null
  unavailableCommentCount: number
  pagesObserved: number
  hasMore: boolean | null
  status: 'complete' | 'partial' | 'empty' | 'login_required' | 'verification_required'
  sessionMode: 'account' | 'standalone'
  message: string
}

declare type CommentListenerTask = {
  type: 'comment-listener'
  config: CommentListenerConfig
}

declare type PinCommentTask = {
  type: 'pin-comment'
  config: {
    comment: string
  }
}

declare type LiveControlTask =
  | AutoPopupTask
  | AutoCommentTask
  | SendBatchMessagesTask
  | CommentListenerTask
  | PinCommentTask

declare type DouyinLiveMessage = {
  time: number
} & (
  | CommentMessage
  | RoomEnterMessage
  | RoomLikeMessage
  | LiveOrderMessage
  | SubscribeMerchantBrandVipMessage
  | RoomFollowMessage
  | EcomFansclubParticipateMessage
)

interface CommentMessage {
  msg_type: 'comment'
  msg_id: string
  nick_name: string
  content: string
  /** Public identifiers may be absent from some comment payloads. */
  user_id?: string
  douyin_id?: string
}

interface RoomEnterMessage {
  msg_type: 'room_enter'
  msg_id: string
  nick_name: string
  user_id: string
}

interface RoomLikeMessage {
  msg_type: 'room_like'
  msg_id: string
  nick_name: string
  user_id: string
}

interface SubscribeMerchantBrandVipMessage {
  msg_type: 'subscribe_merchant_brand_vip'
  msg_id: string
  nick_name: string
  user_id: string
  content: string
}

interface RoomFollowMessage {
  msg_type: 'room_follow'
  msg_id: string
  nick_name: string
  user_id: string
}

interface EcomFansclubParticipateMessage {
  msg_type: 'ecom_fansclub_participate'
  msg_id: string
  nick_name: string
  user_id: string
  content: string
}

interface LiveOrderMessage {
  msg_type: 'live_order'
  nick_name: string
  msg_id: string
  order_status: '已下单' | '已付款' | '未知状态'
  order_ts: number
  product_id: string
  product_title: string
}

declare type WechatChannelLiveMessage = {
  msg_type: 'wechat_channel_live_msg'
  msg_id: string
  nick_name: string
  user_id: string
  content: string
  time: number
}

declare type XiaohongshuCommentLiveMessage = {
  msg_type: 'xiaohongshu_comment'
  msg_id: string
  nick_name: string
  user_id: string
  content: string
  time: number
}

declare type TaobaoCommentLiveMessage = {
  msg_type: 'taobao_comment'
  msg_id: string
  nick_name: string
  user_id: string
  content: string
  time: number
}

declare type LiveMessage =
  | WechatChannelLiveMessage
  | DouyinLiveMessage
  | XiaohongshuCommentLiveMessage
  | TaobaoCommentLiveMessage
