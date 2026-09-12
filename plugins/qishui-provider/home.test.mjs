import assert from 'node:assert/strict'
import test from 'node:test'
import { createHome, homeSections } from './home.mjs'

function harness(appPost, overrides = {}) {
  return createHome({
    appPost,
    mapPlaylist: (p) => ({ id: p.id, name: p.title }),
    mapTrack: (p) => ({ id: p.id, title: p.name }),
    playlistTypes: new Map([['liked', 4]]),
    requireAuth: async () => ({ cookie: 'sessionid=private' }),
    fetchUserLibrary: async () => ({ likedPlaylist: { id: 'liked' } }),
    ...overrides
  })
}

test('home sections bind to implemented methods and gate private favorites', () => {
  const home = harness(async () => ({ json: {} }))
  for (const section of homeSections) assert.equal(typeof home[section.method], 'function')
  assert.equal(homeSections.find((s) => s.id === 'favorites').requiresLogin, true)
  assert.notEqual(homeSections.find((s) => s.id === 'discover').requiresLogin, true)
})

test('shares concurrent public discovery requests, limits rows and refreshes on the next load', async () => {
  const calls = []
  const home = harness(async (path, body, cookie) => {
    calls.push({ path, body, cookie })
    assert.equal(cookie, '')
    if (path === '/luna/discover/mix')
      return {
        json: {
          inner_block: [
            {
              resources: [
                { entity: { track: { id: 'ignore' } } },
                ...Array.from({ length: 14 }, (_, i) => ({
                  entity: { playlist: { id: String(i), title: '歌单' } }
                })),
                { entity: { playlist: { id: '0', title: '重复' } } }
              ]
            }
          ]
        }
      }
    assert.equal(body.count, 4)
    return {
      json: {
        media_resources: [
          { id: 'shared', name: '同一首歌' },
          { id: body.playlist_id, name: '歌曲' }
        ]
      }
    }
  })
  const [playlists, songs] = await Promise.all([
    home.fetchRecommendPlaylists(),
    home.fetchRecommendSongs('discover')
  ])
  assert.equal(playlists.length, 12)
  assert.ok(playlists.every((p) => p.owned === false))
  assert.equal(songs.length, 4)
  assert.equal(calls.filter((c) => c.path === '/luna/discover/mix').length, 1)
  assert.equal(calls.filter((c) => c.path === '/luna/playlist/detail').length, 3)
  await home.fetchRecommendPlaylists()
  assert.equal(calls.filter((c) => c.path === '/luna/discover/mix').length, 2)
})

test('favorites carry the login cookie and playlist type and request only one preview page', async () => {
  const home = harness(async (path, body, cookie) => {
    assert.equal(path, '/luna/playlist/detail')
    assert.equal(body.playlist_id, 'liked')
    assert.equal(body.playlist_type, 4)
    assert.equal(body.count, 12)
    assert.equal(cookie, 'sessionid=private')
    return {
      json: {
        media_resources: [{ id: 'favorite', name: '歌曲' }],
        has_more: true,
        next_cursor: '12'
      }
    }
  })
  assert.deepEqual(
    (await home.fetchRecommendSongs('favorites')).map((t) => t.id),
    ['favorite']
  )
})

test('favorites do not issue requests when logged out or no liked playlist exists', async () => {
  const request = async () => {
    throw new Error('unexpected request')
  }
  const loggedOut = harness(request, {
    requireAuth: async () => {
      throw new Error('请登录')
    }
  })
  await assert.rejects(loggedOut.fetchRecommendSongs('favorites'), /请登录/)
  const empty = harness(request, { fetchUserLibrary: async () => ({ likedPlaylist: null }) })
  assert.deepEqual(await empty.fetchRecommendSongs('favorites'), [])
})

test('one failed playlist preserves other songs but total failure stays retryable', async () => {
  let allFail = false
  const home = harness(async (path, body) => {
    if (path === '/luna/discover/mix')
      return {
        json: {
          inner_block: [{ resources: [{ playlist: { id: 'bad' } }, { playlist: { id: 'good' } }] }]
        }
      }
    if (allFail || body.playlist_id === 'bad') throw new Error('upstream failed')
    return { json: { tracks: [{ id: 'song', name: '歌曲' }] } }
  })
  assert.equal((await home.fetchRecommendSongs()).length, 1)
  allFail = true
  await assert.rejects(home.fetchRecommendSongs(), /upstream failed/)
  allFail = false
  assert.equal((await home.fetchRecommendSongs({ signal: new AbortController().signal })).length, 1)
})
