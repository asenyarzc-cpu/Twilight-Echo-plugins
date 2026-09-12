import assert from 'node:assert/strict'
import test from 'node:test'
import { imageUrl } from './images.mjs'

test('completes the CDN prefix, resource URI and image transform for covers', () => {
  assert.equal(
    imageUrl({ uri: 'tos-cn-v-2774c002/cover', urls: ['https://p3-luna.douyinpic.com/img/'] }),
    'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/cover~c5_500x500.jpg'
  )
})

test('resource filenames with an extension still require a CDN transform', () => {
  assert.equal(
    imageUrl({ uri: 'ies-music/cover.jpeg', urls: ['https://p3-luna.douyinpic.com/img/'] }),
    'https://p3-luna.douyinpic.com/img/ies-music/cover.jpeg~c5_500x500.jpg'
  )
})

test('preserves complete signed avatar URLs without duplicating the URI or altering the query', () => {
  const url = 'https://p3.douyinpic.com/aweme/720x720/avatar.jpeg?from=123&signature=abc'
  assert.equal(imageUrl({ uri: 'avatar', urls: [url], need_complete_url: true }), url)
  assert.equal(imageUrl(url), url)
  assert.equal(imageUrl({ url }), url)
})

test('keeps an existing image transform and accepts the next valid CDN base', () => {
  assert.equal(
    imageUrl({ uri: 'cover~c5_300x300.jpg', urls: ['', 'https://p6-luna.douyinpic.com/img/'] }),
    'https://p6-luna.douyinpic.com/img/cover~c5_300x300.jpg'
  )
})

test('does not return a bare CDN directory as a usable cover', () => {
  assert.equal(imageUrl({ urls: ['https://p3-luna.douyinpic.com/img/'] }), '')
  assert.equal(imageUrl(null), '')
  assert.equal(imageUrl({ uri: 'cover' }), '')
})
