import assert from 'node:assert/strict'
import { signReplyABogus } from '../electron/main/platforms/douyin/replyABogus'

const query =
  'device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&version_code=290100&version_name=29.1.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=132.0.0.0&browser_online=true&platform=PC&item_id=7675505205047348543&comment_id=7675512076511904549&cursor=0&count=20&item_type=0&cut_version=1'
const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const randomValues = [1234, 5678, 9012]
let randomIndex = 0

const signature = signReplyABogus(query, userAgent, {
  nowMs: 1_725_000_123_456,
  randomInt: () => randomValues[randomIndex++],
})

assert.equal(
  signature,
  'E7mhBdugDifihdWk5V5LfY3q6lM3Ymi90trEMD2fmnf9SL39HMTD9exE0XGv/u8jN4/kIeYjy4hbT3ohrQ2y8qwf9W0L/25gsDSkKl12so0j53inCLf/E0iE5hsAtFH8svr4iKi8owICSYyhldAJ5kIlO62-zo0/=',
  'TypeScript reply signature must match the Python reference implementation',
)
assert.equal(randomIndex, 3)

console.log(JSON.stringify({ signatureLength: signature.length, passed: true }, null, 2))
