import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeWbiWithKeys,
  extractCookieValue,
  extractMediaCid,
  isCacheEntryFresh,
  mapBiliMediaToTrack,
  mapPageToTrack,
  mergeRefreshedCookies,
  parseDurationToSeconds,
  parseSetCookies,
  selectDashAudioUrl,
  selectProgressivePlaybackUrl,
  sortFavoriteFolders,
  sortFavoriteFoldersWithPinned,
  stripHtml
} from './index.mjs'

test('signs Bilibili WBI parameters with stable w_rid', () => {
  const query = encodeWbiWithKeys(
    { foo: '114', bar: '514', zab: 1919810 },
    {
      imgKey: '7cd084941338484aae1ad9425b84077c',
      subKey: '4932caff0ff746eab6f01bf08b70ac45'
    },
    1702204169
  )

  assert.match(query, /(^|&)bar=514(&|$)/)
  assert.match(query, /(^|&)foo=114(&|$)/)
  assert.match(query, /(^|&)zab=1919810(&|$)/)
  assert.match(query, /(^|&)wts=1702204169(&|$)/)
  assert.match(query, /(^|&)w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4(&|$)/)
})

test('keeps only required Bilibili cookies from Set-Cookie headers', () => {
  assert.deepEqual(
    parseSetCookies([
      'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; Secure',
      'bili_jct=csrf-token; Path=/; Domain=.bilibili.com',
      'DedeUserID=12345; Path=/',
      'DedeUserID__ckMd5=abcdef; Path=/',
      'sid=sid-value; Path=/',
      'buvid3=ignored; Path=/'
    ]),
    {
      SESSDATA: 'abc%2Cdef',
      bili_jct: 'csrf-token',
      DedeUserID: '12345',
      DedeUserID__ckMd5: 'abcdef',
      sid: 'sid-value'
    }
  )
})

test('sorts default favorite folder first', () => {
  const sorted = sortFavoriteFolders([
    { id: 2, title: '稍后听', attr: 2 },
    { id: 1, title: '默认收藏夹', attr: 0 },
    { id: 3, title: '动画', attr: 2 }
  ])

  assert.equal(sorted[0].id, 1)
  assert.deepEqual(
    sorted.slice(1).map((folder) => folder.title),
    ['动画', '稍后听']
  )
})

test('maps Bilibili favorite media to stable provider-prefixed track', () => {
  const track = mapBiliMediaToTrack(
    {
      title: '原始标题',
      cover: '//i0.hdslb.com/bfs/archive/demo.jpg',
      duration: 120,
      upper: { name: 'UP 主' }
    },
    {
      bvid: 'BV1xx411c7mD',
      cid: 987654321,
      title: '视频标题 - P1',
      duration: 118,
      albumName: '默认收藏夹'
    }
  )

  assert.equal(track.id, 'bili:BV1xx411c7mD:987654321')
  assert.equal(track.filePath, track.id)
  assert.equal(track.source, 'bili')
  assert.equal(track.title, '视频标题 - P1')
  assert.equal(track.artist, 'UP 主')
  assert.equal(track.album, '默认收藏夹')
  assert.equal(track.cover, 'https://i0.hdslb.com/bfs/archive/demo.jpg')
  assert.equal(track.duration, 118)
})

test('extracts cid from Bilibili favorite media without video detail request', () => {
  assert.equal(extractMediaCid({ ugc: { first_cid: 38856691242 } }), 38856691242)
  assert.equal(extractMediaCid({ first_cid: 12345 }), 12345)
  assert.equal(extractMediaCid({ cid: 67890 }), 67890)
  assert.equal(extractMediaCid({ ugc: { first_cid: 0 } }), null)
})

test('selects highest bandwidth DASH audio and prefers flac audio', () => {
  assert.equal(
    selectDashAudioUrl({
      dash: {
        audio: [
          { baseUrl: 'https://audio-low.example', bandwidth: 64000 },
          { base_url: 'https://audio-high.example', bandwidth: 192000 }
        ]
      }
    }),
    'https://audio-high.example'
  )

  assert.equal(
    selectDashAudioUrl({
      dash: {
        flac: { audio: { baseUrl: 'https://audio-flac.example' } },
        audio: [{ baseUrl: 'https://audio-high.example', bandwidth: 192000 }]
      }
    }),
    'https://audio-flac.example'
  )
})

test('sorts pinned favorite folders before unpinned folders', () => {
  const sorted = sortFavoriteFoldersWithPinned(
    [
      { id: 2, title: '稍后听', attr: 2 },
      { id: 1, title: '默认收藏夹', attr: 0 },
      { id: 3, title: '动画', attr: 2 },
      { id: 4, title: '音乐', attr: 2 }
    ],
    ['3', '4']
  )

  assert.deepEqual(
    sorted.map((folder) => folder.id),
    [3, 4, 1, 2]
  )
})

test('keeps legacy single pinned favorite folder input compatible', () => {
  const sorted = sortFavoriteFolders(
    [
      { id: 2, title: '稍后听', attr: 2 },
      { id: 1, title: '默认收藏夹', attr: 0 }
    ],
    '2'
  )

  assert.deepEqual(
    sorted.map((folder) => folder.id),
    [2, 1]
  )
})

test('selects stable progressive playback url when available', () => {
  assert.equal(
    selectProgressivePlaybackUrl({
      durl: [
        { url: 'https://video-large.example', length: 1000, size: 9000 },
        { url: 'https://video-small.example', length: 1000, size: 5000 },
        { url: 'https://video-short.example', length: 500, size: 1000 }
      ]
    }),
    'https://video-small.example'
  )

  assert.equal(selectProgressivePlaybackUrl({ dash: { audio: [] } }), null)
})

test('extracts a cookie value from a Bilibili cookie string', () => {
  const cookie = 'SESSDATA=abc; bili_jct=csrf-token; DedeUserID=12345'
  assert.equal(extractCookieValue(cookie, 'bili_jct'), 'csrf-token')
  assert.equal(extractCookieValue(cookie, 'SESSDATA'), 'abc')
  assert.equal(extractCookieValue(cookie, 'missing'), '')
  assert.equal(extractCookieValue('', 'SESSDATA'), '')
})

test('merges refreshed cookies while keeping existing values', () => {
  const oldCookie = 'SESSDATA=old-sess; bili_jct=old-jct; DedeUserID=12345; sid=abc'
  const refreshed = {
    SESSDATA: 'new-sess',
    bili_jct: 'new-jct',
    DedeUserID__ckMd5: 'md5'
  }
  const merged = mergeRefreshedCookies(oldCookie, refreshed)
  assert.match(merged, /SESSDATA=new-sess/)
  assert.match(merged, /bili_jct=new-jct/)
  assert.match(merged, /DedeUserID=12345/)
  assert.match(merged, /DedeUserID__ckMd5=md5/)
  assert.doesNotMatch(merged, /SESSDATA=old-sess/)
})

test('treats cache entry as fresh only before expiry', () => {
  assert.equal(isCacheEntryFresh({ tracks: [], expiresAt: Date.now() + 1000 }), true)
  assert.equal(isCacheEntryFresh({ tracks: [], expiresAt: Date.now() - 1 }), false)
  assert.equal(isCacheEntryFresh({ tracks: [] }), false)
  assert.equal(isCacheEntryFresh(null), false)
})

test('parses Bilibili search duration strings to seconds', () => {
  assert.equal(parseDurationToSeconds('10:30'), 630)
  assert.equal(parseDurationToSeconds('1:02:03'), 3723)
  assert.equal(parseDurationToSeconds('45'), 45)
  assert.equal(parseDurationToSeconds(''), 0)
  assert.equal(parseDurationToSeconds(120), 120)
})

test('strips HTML highlight tags from Bilibili search titles', () => {
  assert.equal(stripHtml('<em>周杰伦</em> - <em>稻香</em>'), '周杰伦 - 稻香')
  assert.equal(stripHtml('plain text'), 'plain text')
  assert.equal(stripHtml(undefined), '')
})

test('maps a multi-page video page to a provider-prefixed track', () => {
  const track = mapPageToTrack(
    { title: '钢琴曲合集', cover: '//i0.hdslb.com/a.jpg', upper: { name: 'UP主' } },
    {
      bvid: 'BV1xx411c7mD',
      page: { cid: 111, part: '第一首', page: 1, duration: 200 },
      albumName: '默认收藏夹'
    }
  )
  assert.equal(track.id, 'bili:BV1xx411c7mD:111')
  assert.equal(track.title, '钢琴曲合集 - 第一首')
  assert.equal(track.duration, 200)
  assert.equal(track.album, '默认收藏夹')
  assert.equal(track.artist, 'UP主')
})

test('falls back to P-index label when page part is missing', () => {
  const track = mapPageToTrack(
    { title: '合集', upper: { name: 'UP主' } },
    {
      bvid: 'BV1xx',
      page: { cid: 222, page: 3, duration: 0 },
      albumName: '默认收藏夹'
    }
  )
  assert.equal(track.title, '合集 - P3')
})

test('returns null for multi-page entry without valid cid', () => {
  assert.equal(
    mapPageToTrack(
      { title: '合集' },
      { bvid: 'BV1xx', page: { part: '无 cid' }, albumName: '默认收藏夹' }
    ),
    null
  )
})
