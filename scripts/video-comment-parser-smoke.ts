import assert from 'node:assert/strict'
import {
  buildCommentPageUrl,
  getCommentRequestDelay,
  getReplyConcurrency,
  getUnavailableCommentCount,
  parseVideoCommentPayload,
  readOfficialCommentCount,
} from '../electron/main/platforms/douyin/videoCommentCollector'

const sourceUrl = 'https://www.douyin.com/video/7000000000000000001'
const videoId = '7000000000000000001'

const result = parseVideoCommentPayload(
  {
    status_code: 0,
    comments: [
      {
        cid: '7000000000000001001',
        text: 'That sunrise is unreal.',
        create_time: 1716201000,
        reply_id: '0',
        user: {
          uid: '1000000000000000010',
          short_id: '77770010',
          unique_id: 'synthetic_viewer_a',
          nickname: 'Synthetic Viewer A',
        },
        reply_comment: [
          {
            cid: '7000000000000001101',
            text: 'Same spot, two weeks earlier.',
            create_time: 1716202400,
            reply_id: '7000000000000001001',
            user: {
              uid: '1000000000000000011',
              short_id: '77770011',
              unique_id: 'synthetic_viewer_b',
              nickname: 'Synthetic Viewer B',
            },
          },
        ],
      },
    ],
    cursor: 20,
    has_more: 1,
  },
  sourceUrl,
  videoId,
)

assert.equal(result.length, 2)
assert.deepEqual(result[0], {
  commentId: '7000000000000001001',
  parentCommentId: '',
  isReply: false,
  userId: '1000000000000000010',
  douyinId: 'synthetic_viewer_a',
  nickname: 'Synthetic Viewer A',
  comment: 'That sunrise is unreal.',
  createdAt: 1716201000000,
  videoId,
  sourceUrl,
})
assert.deepEqual(
  {
    commentId: result[1].commentId,
    parentCommentId: result[1].parentCommentId,
    isReply: result[1].isReply,
    userId: result[1].userId,
    douyinId: result[1].douyinId,
    nickname: result[1].nickname,
  },
  {
    commentId: '7000000000000001101',
    parentCommentId: '7000000000000001001',
    isReply: true,
    userId: '1000000000000000011',
    douyinId: 'synthetic_viewer_b',
    nickname: 'Synthetic Viewer B',
  },
)

const duplicate = {
  cid: '7000000000000001002',
  text: 'Which lens was this?',
  create_time: 1716201600,
  reply_id: '0',
  user: { uid: '1000000000000000012', short_id: '77770012' },
}
const deduplicated = parseVideoCommentPayload(
  { comments: [duplicate], data: { highlighted_comments: [duplicate] } },
  sourceUrl,
  videoId,
)
assert.equal(deduplicated.length, 1)
assert.equal(deduplicated[0].douyinId, '77770012')

const mediaComments = parseVideoCommentPayload(
  {
    comments: [
      {
        cid: '7000000000000001201',
        text: '',
        reply_id: '0',
        sticker: { sticker_id: 'synthetic-sticker' },
        user: { uid: '1000000000000000020', nickname: 'Sticker Viewer' },
      },
      {
        cid: '7000000000000001202',
        text: '',
        reply_id: '0',
        image_list: [{ uri: 'synthetic-image' }],
        user: { uid: '1000000000000000021', nickname: 'Image Viewer' },
      },
      {
        cid: '7000000000000001203',
        text: '',
        reply_id: '0',
        video_list: [{ uri: 'synthetic-video' }],
        user: { uid: '1000000000000000022', nickname: 'Video Viewer' },
      },
      {
        cid: '7000000000000001204',
        text: '',
        reply_id: '0',
        user: { uid: '1000000000000000023', nickname: 'Empty Viewer' },
      },
      {
        cid: '7000000000000001205',
        text: '这张图拍得很好。',
        reply_id: '0',
        image_list: [{ uri: 'synthetic-image-with-text' }],
        user: { uid: '1000000000000000024', nickname: 'Image Text Viewer' },
      },
      {
        cid: '7000000000000001206',
        text: '[捂脸][666]',
        reply_id: '0',
        user: { uid: '1000000000000000025', nickname: 'Text Emoji Viewer' },
      },
      {
        cid: '7000000000000001207',
        text: '🔥😂',
        reply_id: '0',
        user: { uid: '1000000000000000026', nickname: 'Unicode Emoji Viewer' },
      },
      {
        cid: '7000000000000001208',
        text: '这条文字要保留[比心]🔥',
        reply_id: '0',
        user: { uid: '1000000000000000027', nickname: 'Mixed Text Viewer' },
      },
    ],
  },
  sourceUrl,
  videoId,
)
assert.deepEqual(
  mediaComments.map(comment => comment.comment),
  ['这张图拍得很好。', '这条文字要保留[比心]🔥'],
)

const rootPageUrl = buildCommentPageUrl(
  'https://www.douyin.com/aweme/v1/web/comment/list/?aid=6383&aweme_id=old&cursor=0&a_bogus=stale&msToken=session-token&verifyFp=stale&fp=stale&uifid=stale&timestamp=1&x-secsdk-web-signature=stale',
  {
    kind: 'root',
    cursor: '20',
    count: 20,
    videoId,
  },
)
const rootPage = new URL(rootPageUrl)
assert.equal(rootPage.pathname, '/aweme/v1/web/comment/list/')
assert.equal(rootPage.searchParams.get('aweme_id'), videoId)
assert.equal(rootPage.searchParams.get('cursor'), '20')
for (const key of ['a_bogus', 'msToken', 'verifyFp', 'fp', 'timestamp', 'x-secsdk-web-signature']) {
  assert.equal(rootPage.searchParams.has(key), false)
}
assert.equal(rootPage.searchParams.get('uifid'), 'stale')

const replyPage = new URL(
  buildCommentPageUrl(rootPageUrl, {
    kind: 'reply',
    cursor: '40',
    count: 20,
    videoId,
    commentId: '7000000000000001001',
  }),
)
assert.equal(replyPage.pathname, '/aweme/v1/web/comment/list/reply/')
assert.equal(replyPage.searchParams.get('item_id'), videoId)
assert.equal(replyPage.searchParams.get('comment_id'), '7000000000000001001')
assert.equal(replyPage.searchParams.get('cursor'), '40')
assert.equal(replyPage.searchParams.get('cut_version'), '1')
assert.equal(replyPage.searchParams.has('aweme_id'), false)

assert.equal(getCommentRequestDelay('root', 0, 0, 0), 0)
assert.equal(getCommentRequestDelay('root', 1, 0, 0), 120)
assert.equal(getCommentRequestDelay('root', 40, 0, 0), 1620)
assert.equal(getCommentRequestDelay('reply', 1, 0, 0), 180)
assert.equal(getCommentRequestDelay('reply', 48, 0, 0), 2180)
assert.equal(getCommentRequestDelay('reply', 1, 1, 0), 360)
assert.equal(getReplyConcurrency(0), 6)
assert.equal(getReplyConcurrency(1), 3)
assert.equal(getReplyConcurrency(2), 1)
assert.equal(readOfficialCommentCount({ total: 969 }), 969)
assert.equal(readOfficialCommentCount({ comment_count: '969' }), 969)
assert.equal(readOfficialCommentCount({ comments: [{ total: 969 }] }), null)
assert.equal(getUnavailableCommentCount(969, 668), 301)
assert.equal(getUnavailableCommentCount(null, 668), 0)

console.log(
  JSON.stringify(
    {
      parsed: result.length,
      deduplicated: deduplicated.length,
      rootCursor: rootPage.searchParams.get('cursor'),
      replyCursor: replyPage.searchParams.get('cursor'),
      replyConcurrency: getReplyConcurrency(0),
      throttledReplyConcurrency: getReplyConcurrency(2),
      passed: true,
    },
    null,
    2,
  ),
)
