export const TEST_OUTREACH_MESSAGE = '1'
export const TEST_COMMENT_MESSAGE = '1'
export const TEST_COMMENT_COUNT = 1

const REJECTION_PATTERNS = [
  /仅他关注的人可发消息/i,
  /仅关注的人可发消息/i,
  /暂无法给对方发送消息/i,
  /不在范围内.*(?:发消息|发送消息)/i,
  /暂不接受陌生人私信/i,
  /目标用户主页未开放私信入口/i,
]

export function isOutreachDeliveryRejected(message: string): boolean {
  return REJECTION_PATTERNS.some(pattern => pattern.test(message))
}

export function getOutreachFailureAction(message: string): 'remove' | 'fail' {
  return isOutreachDeliveryRejected(message) ? 'remove' : 'fail'
}

export function isExpectedOutreachProfile(visibleTexts: string[], douyinId: string): boolean {
  const identifier = douyinId.normalize('NFKC').trim().toLowerCase()
  if (!identifier) return false
  return visibleTexts.some(text => {
    const account = text.normalize('NFKC').match(/^\s*抖音号\s*[：:]\s*(.*?)\s*$/)?.[1]
    return account?.toLowerCase() === identifier
  })
}

export function isExpectedOutreachChatHeader(
  nodes: Array<{ text: string; className: string; bounds: { top: number } | null }>,
  nickname: string,
): boolean {
  const expected = nickname.normalize('NFKC').trim().toLowerCase()
  if (!expected) return false
  return nodes.some(
    node =>
      node.bounds !== null &&
      node.bounds.top < 250 &&
      node.className.endsWith('TextView') &&
      node.text.normalize('NFKC').trim().toLowerCase() === expected,
  )
}
