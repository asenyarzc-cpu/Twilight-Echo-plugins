import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  _setVendorLoaderForTests,
  activate,
  deactivate,
  isLoopbackHost,
  krcToLrc,
  mapKugouTrack,
  qualityLadder,
  safeErrorMessage
} from './index.mjs'

const CONSENT_VERSION = 'kugoumusic-v1'
const SETTINGS_COMMAND = 'kugou.settings'

const EMBEDDED_PORT = 39170

function createFakeVendor() {
  const calls = {
    create: 0,
    closed: 0,
    connectionsClosed: 0,
    lastOptions: null
  }
  const service = {
    address: () => ({
      address: '127.0.0.1',
      family: 'IPv4',
      port: EMBEDDED_PORT
    }),
    closeAllConnections: () => {
      calls.connectionsClosed += 1
    },
    close: (callback) => {
      calls.closed += 1
      callback?.()
    }
  }
  const loader = async () => ({
    createKugouApiServer: async (options) => {
      calls.create += 1
      calls.lastOptions = options
      return { service }
    }
  })
  return { loader, calls }
}

test.afterEach(async () => {
  _setVendorLoaderForTests(null)
  await deactivate()
})

test('declares a scoped provider manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.id, 'com.twilightecho.provider.kugou')
  assert.ok(manifest.type.includes('provider'))
  assert.ok(manifest.permissions.includes('network'))
  assert.ok(manifest.permissions.includes('settings'))
  assert.ok(manifest.permissions.includes('ui:inject'))
  assert.ok(manifest.permissions.includes('library:read'))
  assert.equal(manifest.permissions.includes('filesystem:read'), false)
})

test('registers the KuGou provider and blocks all upstream work before consent', async () => {
  const harness = await startPlugin()
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return jsonResponse({})
    },
    async () => {
      assert.equal(harness.provider.current.id, 'kugou')
      assert.deepEqual(harness.provider.current.capabilities, [
        'search',
        'playbackUrl',
        'lyrics',
        'cover',
        'playlist',
        'library',
        'login'
      ])
      assert.equal(await harness.provider.current.isTrackLiked('kugou:any'), false)
      await assert.rejects(
        () => harness.provider.current.searchSongs('周杰伦'),
        /阅读并确认免责声明/
      )
      assert.equal(calls, 0)
      const form = await harness.handlers.get(SETTINGS_COMMAND)({
        source: 'settingsPanel',
        panelId: 'kugou-settings'
      })
      assert.equal(form.kind, 'settings-form')
      assert.equal(form.fields[0].key, 'apiBaseUrl')
      assert.equal(form.fields[0].value, '')
      assert.equal(form.fields[0].required, false)
      assert.match(form.notice, /内置/)
      assert.match(form.notice, /禁止配置公共 API/)
    }
  )
})

test('only accepts loopback external addresses and keeps the embedded service as default', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: {
      platform: 'lite',
      dfid: 'old-dfid',
      cookies: { KUGOU_API_GUID: 'old-guid' }
    }
  })
  await assert.rejects(
    () =>
      harness.handlers.get(SETTINGS_COMMAND)({
        disclaimer: CONSENT_VERSION,
        apiBaseUrl: 'https://api.example.test'
      }),
    /只允许连接/
  )
  await harness.handlers.get(SETTINGS_COMMAND)({
    disclaimer: CONSENT_VERSION,
    apiBaseUrl: 'http://localhost:3100/'
  })
  assert.deepEqual(harness.values.get('apiConfig'), {
    schemaVersion: 2,
    externalBaseUrl: 'http://localhost:3100'
  })
  assert.equal(harness.values.get('device').dfid, 'old-dfid')
  await harness.handlers.get(SETTINGS_COMMAND)({
    disclaimer: CONSENT_VERSION,
    apiBaseUrl: ''
  })
  assert.deepEqual(harness.values.get('apiConfig'), {
    schemaVersion: 2,
    externalBaseUrl: ''
  })
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('api.example.test'), false)
})

test('migrates the legacy port-3000 default while public search stays independent', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    apiConfig: { externalBaseUrl: 'http://127.0.0.1:3000' }
  })
  assert.deepEqual(harness.values.get('apiConfig'), {
    schemaVersion: 2,
    externalBaseUrl: ''
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://songsearch.kugou.com')
      assert.equal(url.pathname, '/song_search_v2')
      return jsonResponse({
        status: 1,
        error_code: 0,
        data: { lists: [], total: 0 }
      })
    },
    async () => {
      await harness.provider.current.searchSongs('迁移后搜索')
      assert.equal(harness.vendor.calls.create, 0)
    }
  )
})

test('maps public song search results without sending private credentials', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION }
  })
  const requests = []
  await withFetch(
    async (input, options) => {
      const url = new URL(String(input))
      requests.push({ url, options })
      assert.equal(url.origin, 'https://songsearch.kugou.com')
      assert.equal(url.pathname, '/song_search_v2')
      assert.equal(url.searchParams.get('keyword'), '周杰伦')
      assert.equal(url.searchParams.get('page'), '2')
      assert.equal(options.headers.Authorization, undefined)
      assert.equal(url.searchParams.has('token'), false)
      assert.equal(url.searchParams.has('userid'), true)
      assert.equal(url.searchParams.get('userid'), '0')
      return jsonResponse({
        status: 1,
        data: {
          total: 1,
          lists: [
            {
              FileHash: 'abcd1234',
              SongName: '<em>晴天</em>',
              SingerName: '周杰伦',
              AlbumName: '叶惠美',
              AlbumID: '321',
              MixSongID: '654',
              Duration: 269,
              FileSize: 123456,
              Image: 'https://img.example/{size}.jpg'
            }
          ]
        }
      })
    },
    async () => {
      const result = await harness.provider.current.searchSongs('周杰伦', 10, 10)
      assert.equal(requests.length, 1)
      assert.equal(result.total, 1)
      assert.deepEqual(result.items[0], {
        id: 'kugou:ABCD1234',
        title: '晴天',
        artist: '周杰伦',
        artists: [{ name: '周杰伦' }],
        album: '叶惠美',
        filePath: 'kugou:ABCD1234',
        fileName: '晴天.mp3',
        duration: 269,
        size: 123456,
        cover: 'https://img.example/400.jpg',
        lyrics: null,
        translatedLyrics: null,
        source: 'kugou',
        streamUrl: null,
        bpm: undefined,
        providerSongId: 'ABCD1234',
        providerAlbumId: '321',
        providerAlbumAudioId: '654'
      })
      assert.equal(harness.values.has('device'), false)
    }
  )
})

test('searches public playlists and artists without starting the authenticated service', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION }
  })
  await withFetch(
    async (input, options) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'http://msearchcdn.kugou.com')
      assert.equal(url.searchParams.get('keyword'), '华语')
      assert.equal(options.headers.Authorization, undefined)
      assert.equal(url.searchParams.has('token'), false)
      if (url.pathname === '/api/v3/search/special') {
        return jsonResponse({
          status: 1,
          data: {
            total: 1,
            info: [
              {
                specialid: 123,
                specialname: '<em>华语</em>精选',
                imgurl: 'https://img.example/{size}.jpg',
                song_count: 30,
                nickname: '酷狗编辑'
              }
            ]
          }
        })
      }
      assert.equal(url.pathname, '/api/v3/search/singer')
      return jsonResponse({
        status: 1,
        data: {
          total: 1,
          info: [
            {
              singerid: 456,
              singername: '<em>华语</em>歌手',
              imgurl: 'https://img.example/{size}.jpg'
            }
          ]
        }
      })
    },
    async () => {
      const playlists = await harness.provider.current.searchPlaylists('华语', 12, 0)
      assert.deepEqual(playlists, {
        items: [
          {
            id: '123',
            name: '华语精选',
            cover: 'https://img.example/400.jpg',
            trackCount: 30,
            creatorName: '酷狗编辑',
            owned: false
          }
        ],
        total: 1
      })
      const artists = await harness.provider.current.searchArtists('华语', 12, 0)
      assert.deepEqual(artists, {
        items: [
          {
            id: '456',
            name: '华语歌手',
            cover: 'https://img.example/400.jpg'
          }
        ],
        total: 1
      })
      assert.equal(harness.vendor.calls.create, 0)
      assert.equal(harness.values.has('device'), false)
    }
  )
})

test('finds KRC lyrics and exposes a normal-LRC fallback plus word lyrics', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} }
  })
  const krc = '[0,1000]<0,500,0>你<500,500,0>好'
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/search/lyric') {
        assert.equal(url.searchParams.get('hash'), 'ABCD')
        return jsonResponse({
          error_code: 0,
          candidates: [{ id: 'lyric-id', accesskey: 'access-key' }]
        })
      }
      assert.equal(url.pathname, '/lyric')
      assert.equal(url.searchParams.get('id'), 'lyric-id')
      assert.equal(url.searchParams.get('accesskey'), 'access-key')
      assert.equal(url.searchParams.get('fmt'), 'krc')
      return jsonResponse({ error_code: 0, decodeContent: krc })
    },
    async () => {
      const result = await harness.provider.current.getLyrics({
        id: 'kugou:ABCD',
        duration: 1
      })
      assert.equal(result.lyrics, '[00:00.00]你好')
      assert.equal(result.wordLyrics, krc)
      assert.equal(result.translatedLyrics, null)
      assert.equal(krcToLrc('[id:1]\n[60500,500]<0,500,0>词'), '[01:00.50]词')
    }
  )
})

test('performs QR login and stores credentials only in private settings', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/login/qr/key') {
        return jsonResponse({ error_code: 0, data: { qrcode: 'qr-key' } })
      }
      if (url.pathname === '/login/qr/create') {
        assert.equal(url.searchParams.get('key'), 'qr-key')
        return jsonResponse({ error_code: 0, data: { base64: 'cG5n' } })
      }
      if (url.pathname === '/login/qr/check') {
        return jsonResponse({
          error_code: 0,
          data: { status: 4, token: 'top-secret-token', userid: '10001' }
        })
      }
      if (url.pathname === '/user/detail') {
        assert.match(url.searchParams.get('cookie'), /token=top-secret-token/)
        return jsonResponse({
          status: 1,
          error_code: 0,
          data: { userid: '10001', nickname: '测试用户' }
        })
      }
      throw new Error('Unexpected request ' + url.pathname)
    },
    async () => {
      const qr = await harness.provider.current.getQrLogin()
      assert.equal(qr.key, 'qr-key')
      assert.equal(qr.imageDataUrl, 'data:image/png;base64,cG5n')
      assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
        code: 4,
        message: '登录成功'
      })
      assert.deepEqual(harness.values.get('auth'), {
        token: 'top-secret-token',
        userid: '10001',
        platform: 'lite',
        updatedAt: harness.values.get('auth').updatedAt
      })
      assert.equal(JSON.stringify(harness.logs).includes('top-secret-token'), false)
      assert.deepEqual(await harness.provider.current.checkLogin(), {
        loggedIn: true,
        profile: { id: '10001', nickname: '测试用户', avatar: null }
      })
      await harness.provider.current.logout()
      assert.deepEqual(await harness.provider.current.checkLogin(), {
        loggedIn: false,
        profile: null
      })
    }
  )
})

test('uses a quality ladder and serves a Range response through the loopback audio proxy', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    auth: { platform: 'lite', token: 'private-token', userid: '10001' }
  })
  const realFetch = globalThis.fetch
  const requests = []
  await withFetch(
    async (input, options = {}) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.pathname.startsWith('/kugou/stream/')) return realFetch(input, options)
      requests.push({ parsed, options })
      if (parsed.pathname === '/song/url') {
        const quality = parsed.searchParams.get('quality')
        assert.equal(parsed.searchParams.get('album_id'), '321')
        assert.equal(parsed.searchParams.get('album_audio_id'), '654')
        assert.equal(parsed.searchParams.has('free_part'), false)
        assert.equal(
          parsed.searchParams.get('cookie'),
          'dfid=device;token=private-token;userid=10001'
        )
        assert.equal(options.headers.Authorization, 'dfid=device;token=private-token;userid=10001')
        assert.doesNotMatch(options.headers.Authorization, /;\s/)
        if (quality === 'flac') {
          return jsonResponse({
            error_code: 0,
            status: 0,
            error: 'vip limited',
            data: {}
          })
        }
        return jsonResponse({
          error_code: 0,
          status: 1,
          extName: 'mp3',
          is_full_audio: 1,
          url: ['https://audio.example/song.mp3', 'https://audio-backup.example/song.mp3'],
          backupUrl: ['https://audio-backup.example/song.mp3'],
          data: {}
        })
      }
      if (url === 'https://audio.example/song.mp3') {
        assert.equal(options.headers.Range, 'bytes=0-9')
        return new Response('audio-data', {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': '10',
            'content-range': 'bytes 0-9/10',
            'content-type': 'audio/mpeg'
          }
        })
      }
      throw new Error('Unexpected request ' + url)
    },
    async () => {
      const playbackUrl = await harness.provider.current.getPlaybackUrl(
        {
          id: 'kugou:ABCD',
          providerAlbumId: '321',
          providerAlbumAudioId: '654'
        },
        { quality: 'flac' }
      )
      assert.match(playbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/kugou\/stream\//)
      assert.deepEqual(
        requests
          .filter((request) => request.parsed.pathname === '/song/url')
          .map((request) => request.parsed.searchParams.get('quality')),
        ['flac', '320']
      )
      const response = await realFetch(playbackUrl, {
        headers: { Range: 'bytes=0-9' }
      })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), 'bytes 0-9/10')
      assert.equal(await response.text(), 'audio-data')
      const invalid = await realFetch(playbackUrl + 'invalid')
      assert.equal(invalid.status, 404)
      assert.deepEqual(qualityLadder('lossless'), ['flac', '320', '128'])
      assert.deepEqual(qualityLadder('320'), ['320', '128'])
    }
  )
})

test('starts the embedded service lazily, memoizes it and closes it on deactivation', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/register/dev') {
        return jsonResponse({ error_code: 0, data: { dfid: 'dfid-embedded' } }, 200, {
          'set-cookie': 'dfid=dfid-embedded; Path=/'
        })
      }
      if (url.pathname === '/search/lyric') {
        return jsonResponse({
          error_code: 0,
          candidates: [{ id: 'lyric', accesskey: 'key' }]
        })
      }
      assert.equal(url.pathname, '/lyric')
      return jsonResponse({
        error_code: 0,
        decodeContent: '[0,1000]<0,1000,0>词'
      })
    },
    async () => {
      await harness.provider.current.getLyrics({ id: 'kugou:ABCD' })
      assert.equal(harness.vendor.calls.create, 1)
      assert.deepEqual(harness.vendor.calls.lastOptions, {
        host: '127.0.0.1',
        port: 0
      })
      await harness.provider.current.getLyrics({ id: 'kugou:EFGH' })
      assert.equal(harness.vendor.calls.create, 1, 'embedded service must be memoized')
      const device = harness.values.get('device')
      assert.equal(device.dfid, 'dfid-embedded')
      assert.match(device.guid ?? '', /^[0-9a-f-]{36}$/)
      assert.ok(process.env.KUGOU_API_GUID)
      assert.ok(process.env.KUGOU_API_DEV)
      assert.ok(process.env.KUGOU_API_MAC)
      assert.equal(process.env.KUGOU_API_PLATFORM, 'lite')
    }
  )
  await deactivate()
  assert.equal(harness.vendor.calls.connectionsClosed, 1)
  assert.equal(harness.vendor.calls.closed, 1)
})

test('talks to the configured external loopback service without starting the embedded one', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    apiConfig: { externalBaseUrl: 'http://127.0.0.1:4599' }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'http://127.0.0.1:4599')
      if (url.pathname === '/search/lyric') {
        return jsonResponse({
          error_code: 0,
          candidates: [{ id: 'lyric', accesskey: 'key' }]
        })
      }
      assert.equal(url.pathname, '/lyric')
      return jsonResponse({
        error_code: 0,
        decodeContent: '[0,1000]<0,1000,0>词'
      })
    },
    async () => {
      await harness.provider.current.getLyrics({ id: 'kugou:ABCD' })
      assert.equal(harness.vendor.calls.create, 0)
      assert.equal(harness.vendor.calls.closed, 0)
    }
  )
})

test('polls qr check with unique per-request cache-busting timestamps', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} }
  })
  const checkTimestamps = []
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/login/qr/key') {
        return jsonResponse({ error_code: 0, data: { qrcode: 'poll-key' } })
      }
      if (url.pathname === '/login/qr/create') {
        return jsonResponse({ error_code: 0, data: { base64: 'cG5n' } })
      }
      if (url.pathname === '/login/qr/check') {
        checkTimestamps.push(url.searchParams.get('timestamp'))
        return jsonResponse({ error_code: 0, data: { status: 1 } })
      }
      throw new Error('Unexpected request ' + url.pathname)
    },
    async () => {
      const qr = await harness.provider.current.getQrLogin()
      await harness.provider.current.checkQrLogin(qr.key)
      await harness.provider.current.checkQrLogin(qr.key)
      await harness.provider.current.checkQrLogin(qr.key)
      assert.equal(checkTimestamps.length, 3)
      assert.equal(new Set(checkTimestamps).size, 3, 'each poll must bust the 2-minute URL cache')
      assert.equal(
        checkTimestamps.every((value) => value.includes('-')),
        true
      )
    }
  )
})

test('accepts qr success when credentials arrive only via Set-Cookie', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/login/qr/key') {
        return jsonResponse({ error_code: 0, data: { qrcode: 'cookie-key' } })
      }
      if (url.pathname === '/login/qr/create') {
        return jsonResponse({ error_code: 0, data: { base64: 'cG5n' } })
      }
      if (url.pathname === '/login/qr/check') {
        return new Response(JSON.stringify({ error_code: 0, data: { status: 4 } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'token=cookie-token; Path=/, userid=10086; Path=/'
          }
        })
      }
      assert.equal(url.pathname, '/user/detail')
      return jsonResponse({
        status: 1,
        error_code: 0,
        data: { userid: '10086', nickname: 'Cookie 用户' }
      })
    },
    async () => {
      const qr = await harness.provider.current.getQrLogin()
      assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
        code: 4,
        message: '登录成功'
      })
      assert.equal(harness.values.get('auth').token, 'cookie-token')
      assert.equal(harness.values.get('auth').userid, '10086')
      assert.equal(harness.values.get('auth').platform, 'lite')
    }
  )
})

test('does not report qr success when the returned credentials fail account validation', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/login/qr/key') {
        return jsonResponse({ error_code: 0, data: { qrcode: 'ex-key' } })
      }
      if (url.pathname === '/login/qr/create') {
        return jsonResponse({ error_code: 0, data: { base64: 'cG5n' } })
      }
      if (url.pathname === '/login/qr/check') {
        return jsonResponse({
          error_code: 0,
          data: { status: 4, token: 'inactive-token', userid: '10001' }
        })
      }
      assert.equal(url.pathname, '/user/detail')
      assert.match(url.searchParams.get('cookie'), /token=inactive-token/)
      return new Response(JSON.stringify({ error_code: 20018, error: 'invalid token' }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      })
    },
    async () => {
      const qr = await harness.provider.current.getQrLogin()
      await assert.rejects(() => harness.provider.current.checkQrLogin(qr.key), /登录认证未能通过/)
      assert.equal(harness.values.has('auth'), false)
      assert.equal((await harness.provider.current.checkLogin()).loggedIn, false)
    }
  )
})

test('loads user playlists with the private auth header and never exposes it in mapped items', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    auth: { platform: 'lite', token: 'private-token', userid: '10001' }
  })
  await withFetch(
    async (input, options = {}) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/user/playlist')
      assert.equal(options.method, 'POST')
      assert.match(options.headers.Authorization, /token=private-token/)
      assert.match(options.headers.Authorization, /userid=10001/)
      return jsonResponse({
        error_code: 0,
        data: {
          info: [
            {
              global_collection_id: '1',
              specialname: '我喜欢',
              song_count: 1,
              is_owner: 1,
              imgurl: 'https://cover.example/a.jpg'
            }
          ]
        }
      })
    },
    async () => {
      const library = await harness.provider.current.fetchUserLibrary()
      assert.equal(library.likedPlaylist.id, '1')
      assert.equal(library.playlists[0].name, '我喜欢')
      assert.equal(JSON.stringify(library).includes('private-token'), false)
    }
  )
})

test('redacts credential-shaped errors and propagates provider cancellation', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION }
  })
  const controller = new AbortController()
  await withFetch(
    async (_input, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true
        })
      }),
    async () => {
      const pending = harness.provider.current.searchSongs('取消', 10, 0, {
        signal: controller.signal
      })
      controller.abort(new Error('caller cancelled'))
      await assert.rejects(pending, /caller cancelled/)
      const redacted = safeErrorMessage(
        new Error('token=secret; userid=10001; https://api.example.test/path')
      )
      assert.equal(redacted.includes('secret'), false)
      assert.match(redacted, /credential-redacted/)
      assert.match(redacted, /upstream-url-redacted/)
    }
  )
})

test('maps filename-only search results without depending on an upstream schema variant', () => {
  assert.deepEqual(mapKugouTrack({ hash: 'abc', filename: '歌手 - 歌曲', timelength: 120000 }), {
    id: 'kugou:ABC',
    title: '歌曲',
    artist: '歌手',
    artists: [{ name: '歌手' }],
    album: '',
    filePath: 'kugou:ABC',
    fileName: '歌曲.mp3',
    duration: 120,
    size: 0,
    cover: '',
    lyrics: null,
    translatedLyrics: null,
    source: 'kugou',
    streamUrl: null,
    bpm: undefined,
    providerSongId: 'ABC'
  })
})

test('maps playlist/track/all rows that carry singerinfo, timelen and albuminfo fields', () => {
  assert.deepEqual(
    mapKugouTrack({
      hash: '3f47a55d28d26e9d39434e14efe77338',
      name: '华语群星 - 少女手册',
      singerinfo: [{ name: '华语群星', id: 283307 }, { name: '客座歌手' }],
      albuminfo: { name: '菲梦少女', id: 47162019 },
      timelen: 65135,
      size: 1042987,
      cover: 'http://imge.kugou.com/stdmusic/{size}/20210628/20210628100532720706.jpg'
    }),
    {
      id: 'kugou:3F47A55D28D26E9D39434E14EFE77338',
      title: '少女手册',
      artist: '华语群星/客座歌手',
      artists: [{ name: '华语群星' }, { name: '客座歌手' }],
      album: '菲梦少女',
      filePath: 'kugou:3F47A55D28D26E9D39434E14EFE77338',
      fileName: '少女手册.mp3',
      duration: 65,
      size: 1042987,
      cover: 'http://imge.kugou.com/stdmusic/400/20210628/20210628100532720706.jpg',
      lyrics: null,
      translatedLyrics: null,
      source: 'kugou',
      streamUrl: null,
      bpm: undefined,
      providerSongId: '3F47A55D28D26E9D39434E14EFE77338'
    }
  )
})

test('clears a stored login only after the account endpoint rejects its credentials', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    auth: { platform: 'lite', token: 'stale-private-token', userid: '10001' }
  })
  await withFetch(
    async (input, options) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/user/detail')
      assert.match(options.headers.Authorization, /token=stale-private-token/)
      return new Response(JSON.stringify({ status: 0, error_code: 20018 }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      })
    },
    async () => {
      assert.deepEqual(await harness.provider.current.checkLogin(), {
        loggedIn: false,
        profile: null
      })
      assert.equal(harness.values.has('auth'), false)
      assert.equal(JSON.stringify(harness.logs).includes('stale-private-token'), false)
    }
  )
})

test('surfaces actionable playback errors instead of returning an empty stream URL', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    auth: { platform: 'lite', token: 'private-token', userid: '10001' }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/song/url')
      return new Response(
        JSON.stringify({
          error_code: 152,
          message: 'login required',
          data: {}
        }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      )
    },
    async () => {
      await assert.rejects(
        () => harness.provider.current.getPlaybackUrl({ id: 'kugou:ABCD' }),
        /请先扫码登录酷狗账号/
      )
    }
  )
})

test('identifies a non-KuGou external service before accepting a stream response', async () => {
  const harness = await startPlugin({
    consent: { disclaimerVersion: CONSENT_VERSION },
    device: { platform: 'lite', dfid: 'device', cookies: {} },
    auth: { platform: 'lite', token: 'private-token', userid: '10001' },
    apiConfig: { schemaVersion: 2, externalBaseUrl: 'http://127.0.0.1:4599' }
  })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'http://127.0.0.1:4599')
      assert.equal(url.pathname, '/song/url')
      return jsonResponse({
        code: 200,
        data: [{ url: 'https://wrong-source.example/stream.mp3' }]
      })
    },
    async () => {
      await assert.rejects(
        () => harness.provider.current.getPlaybackUrl({ id: 'kugou:ABCD' }),
        /不是 KuGouMusicApi/
      )
    }
  )
})

function createHarness(initialSettings = {}) {
  const values = new Map(Object.entries(initialSettings))
  const handlers = new Map()
  const contributions = []
  const logs = []
  const provider = { current: null }
  const context = {
    apiVersion: 1,
    storagePath: 'C:/plugin-data/kugou',
    settings: {
      async get(key) {
        return key === undefined ? Object.fromEntries(values) : values.get(key)
      },
      async set(key, value) {
        values.set(key, value)
      },
      async delete(key) {
        values.delete(key)
      }
    },
    logger: {
      debug(message) {
        logs.push(['debug', message])
      },
      info(message) {
        logs.push(['info', message])
      },
      warn(message) {
        logs.push(['warn', message])
      },
      error(message) {
        logs.push(['error', message])
      }
    },
    twilight: {
      providers: {
        async register(value) {
          provider.current = value
        }
      },
      ui: {
        async register(value) {
          contributions.push(value)
        },
        onCommand(command, handler) {
          handlers.set(command, handler)
        }
      }
    }
  }
  return { context, values, handlers, contributions, logs, provider }
}

async function startPlugin(initialSettings = {}) {
  const harness = createHarness(initialSettings)
  const vendor = createFakeVendor()
  _setVendorLoaderForTests(vendor.loader)
  await activate(harness.context)
  return { ...harness, vendor }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

async function withFetch(fetchImplementation, callback) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImplementation
  try {
    return await callback()
  } finally {
    globalThis.fetch = original
  }
}
