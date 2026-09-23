import {
  getOutreachFailureAction,
  isExpectedOutreachChatHeader,
  isExpectedOutreachProfile,
  isOutreachDeliveryRejected,
  TEST_COMMENT_COUNT,
  TEST_COMMENT_MESSAGE,
  TEST_OUTREACH_MESSAGE,
} from '../shared/outreachPolicy'

if (TEST_OUTREACH_MESSAGE !== '1') {
  throw new Error(`expected fixed test message 1, got ${TEST_OUTREACH_MESSAGE}`)
}
if (TEST_COMMENT_MESSAGE !== '1') {
  throw new Error(`expected fixed test comment 1, got ${TEST_COMMENT_MESSAGE}`)
}
if (TEST_COMMENT_COUNT !== 1) {
  throw new Error(`expected fixed test comment count 1, got ${TEST_COMMENT_COUNT}`)
}

const rejected = [
  '对方设置了仅他关注的人可发消息，由于你不在范围内，暂无法给对方发送消息',
  '暂无法给对方发送消息',
  '对方暂不接受陌生人私信',
  '目标用户主页未开放私信入口',
]

for (const message of rejected) {
  if (!isOutreachDeliveryRejected(message)) {
    throw new Error(`expected rejection detection: ${message}`)
  }
  if (getOutreachFailureAction(message) !== 'remove') {
    throw new Error(`expected rejected outreach to be removed: ${message}`)
  }
}

for (const message of ['网络错误，请重试', '真机控制服务未就绪']) {
  if (isOutreachDeliveryRejected(message)) {
    throw new Error(`unexpected rejection detection: ${message}`)
  }
  if (getOutreachFailureAction(message) !== 'fail') {
    throw new Error(`expected generic outreach failure to remain retryable: ${message}`)
  }
}

if (!isExpectedOutreachProfile(['竹宁', '抖音号：2023790694'], '2023790694')) {
  throw new Error('expected the matching Douyin profile to be accepted')
}
if (isExpectedOutreachProfile(['竹宁', '抖音号：20237906940'], '2023790694')) {
  throw new Error('expected a substring account ID match to be rejected')
}
if (isExpectedOutreachProfile(['其他用户', '抖音号：12345'], '2023790694')) {
  throw new Error('expected a different Douyin profile to be rejected')
}
const chatHeader = [
  { text: '竹宁', className: 'android.widget.TextView', bounds: { top: 107 } },
  { text: '竹宁', className: 'android.widget.TextView', bounds: { top: 700 } },
]
if (!isExpectedOutreachChatHeader(chatHeader, '竹宁')) {
  throw new Error('expected matching chat header')
}
if (isExpectedOutreachChatHeader(chatHeader, '其他用户')) {
  throw new Error('expected a different chat recipient to be rejected')
}
if (isExpectedOutreachChatHeader(chatHeader.slice(1), '竹宁')) {
  throw new Error('expected a message bubble to not count as the chat header')
}

console.log(JSON.stringify({ fixedMessage: TEST_OUTREACH_MESSAGE, passed: true }))
