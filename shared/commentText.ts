const NON_TEXT_COMMENT_PLACEHOLDERS = new Set(['[表情评论]', '[图片评论]', '[视频评论]'])
const BRACKET_EMOJI_TOKEN = /\[[^[\]\r\n]{1,24}\]/gu
const UNICODE_EMOJI_TOKEN = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u200d|\ufe0f)/gu
const NORMAL_TEXT_CHARACTER = /[\p{L}\p{N}]/u

export function hasNormalCommentText(value: unknown): boolean {
  const comment = String(value ?? '').trim()
  if (!comment || NON_TEXT_COMMENT_PLACEHOLDERS.has(comment)) return false

  const withoutEmoji = comment
    .replace(BRACKET_EMOJI_TOKEN, ' ')
    .replace(UNICODE_EMOJI_TOKEN, ' ')
    .trim()
  return NORMAL_TEXT_CHARACTER.test(withoutEmoji)
}
