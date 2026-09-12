import assert from 'node:assert/strict'
import test from 'node:test'

import { activate, deactivate } from './index.mjs'

function createHarness(qishuiAuth = null) {
  const values = new Map()
  const provider = { current: null }
  const logs = []
  const context = {
    apiVersion: 1,
    storagePath: 'C:/plugin-data/qishui',
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
        async register() {},
        onCommand() {}
      },
      ...(qishuiAuth ? { qishuiAuth } : {})
    }
  }

  return { context, values, provider, logs }
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

test.afterEach(async () => {
  await deactivate()
})

test('persists a session returned in the upstream auth response', async () => {
  const harness = createHarness()
  const requests = []

  await withFetch(
    async (input, options) => {
      const url = new URL(String(input))
      requests.push({ path: url.pathname, url: url.toString(), options })

      if (url.pathname === '/passport/web/get_qrcode/') {
        return jsonResponse(
          {
            message: 'success',
            data: {
              error_code: 0,
              token: 'qr-token',
              qrcode: 'data:image/png;base64,AA==',
              qrcode_index_url: 'https://bff-pc.qishui.com/ucenter_web/app/sdk-next?token=qr-token',
              expire_time: 180
            }
          },
          200,
          { 'set-cookie': 'passport_csrf_token=csrf-value; Path=/' }
        )
      }

      if (url.pathname === '/passport/web/check_qrconnect/') {
        return jsonResponse({
          message: 'success',
          data: {
            error_code: 0,
            status: '3'
          },
          auth: {
            aid: '386088',
            sessionid: 'session-from-upstream'
          }
        })
      }

      if (url.pathname === '/luna/pc/me') {
        return jsonResponse({
          user: {
            id: 'user-1',
            nickname: '测试用户'
          }
        })
      }

      throw new Error('unexpected request: ' + url.pathname)
    },
    async () => {
      await activate(harness.context)

      const qr = await harness.provider.current.getQrLogin()
      assert.equal(qr.key, 'qr-token')
      const scanUrl = new URL(qr.qrContent)
      assert.equal(scanUrl.pathname, '/light/invoke/scan_login')
      assert.equal(scanUrl.searchParams.get('token'), 'qr-token')
      assert.equal(
        scanUrl.searchParams.get('computer_name'),
        process.env.COMPUTERNAME?.trim() || 'Windows-PC'
      )

      const result = await harness.provider.current.checkQrLogin(qr.key)
      assert.deepEqual(result, { code: 0, message: '登录成功' })
      assert.equal(
        harness.values.get('auth').cookie,
        'passport_csrf_token=csrf-value; sessionid=session-from-upstream'
      )
      assert.equal(harness.values.get('auth').profile.nickname, '测试用户')
      const createRequest = requests[0]
      const statusRequest = requests[1]
      const createUrl = new URL(createRequest.url)
      const statusUrl = new URL(statusRequest.url)
      assert.equal(createUrl.origin, 'https://api.qishui.com')
      assert.equal(createUrl.searchParams.get('version_code'), '3.6.0')
      assert.equal(createUrl.searchParams.get('device_platform'), 'PC')
      assert.equal(statusUrl.searchParams.get('iid'), createUrl.searchParams.get('iid'))
      assert.equal(statusRequest.options.headers['X-Tt-Passport-Csrf-Token'], 'csrf-value')
      assert.match(statusRequest.options.headers['X-Ss-Stub'], /^[A-F0-9]{32}$/)
      assert.ok(
        harness.logs.some(
          ([level, message]) =>
            level === 'debug' &&
            message.includes('status=3') &&
            message.includes('bodySession=true')
        )
      )

      const login = await harness.provider.current.checkLogin()
      assert.equal(login.loggedIn, true)
      assert.equal(login.profile.nickname, '测试用户')
      assert.deepEqual(
        requests.map(({ path }) => path),
        ['/passport/web/get_qrcode/', '/passport/web/check_qrconnect/', '/luna/pc/me']
      )
    }
  )
})

test('accepts a session cookie returned by the QR status endpoint', async () => {
  const harness = createHarness()
  let statusRequest = false

  await withFetch(
    async (input) => {
      const url = new URL(String(input))

      if (url.pathname === '/passport/web/get_qrcode/') {
        return jsonResponse({
          data: {
            token: 'cookie-token',
            qrcode: 'data:image/png;base64,AA==',
            expire_time: 180
          }
        })
      }

      if (url.pathname === '/passport/web/check_qrconnect/') {
        statusRequest = true
        return jsonResponse({ data: { error_code: 0, status: '3' } }, 200, {
          'set-cookie': 'sessionid_ss=session-from-cookie; Path=/; Secure'
        })
      }

      throw new Error('unexpected request: ' + url.pathname)
    },
    async () => {
      await activate(harness.context)
      const qr = await harness.provider.current.getQrLogin()
      const result = await harness.provider.current.checkQrLogin(qr.key)

      assert.equal(statusRequest, true)
      assert.equal(result.code, 0)
      assert.equal(harness.values.get('auth').cookie, 'sessionid_ss=session-from-cookie')
    }
  )
})

test('keeps the scanned state while the upstream returns a transient error code', async () => {
  const harness = createHarness()
  let checks = 0

  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/passport/web/get_qrcode/') {
        return jsonResponse({
          data: {
            token: 'transient-token',
            qrcode: 'data:image/png;base64,AA==',
            expire_time: 180
          }
        })
      }
      if (url.pathname === '/passport/web/check_qrconnect/') {
        checks += 1
        return checks === 1
          ? jsonResponse({ data: { error_code: 0, status: 'scanned' } })
          : jsonResponse({
              data: {
                error_code: 1049,
                description: 'temporary confirmation state'
              }
            })
      }
      throw new Error('unexpected request: ' + url.pathname)
    },
    async () => {
      await activate(harness.context)
      const qr = await harness.provider.current.getQrLogin()
      assert.equal((await harness.provider.current.checkQrLogin(qr.key)).code, 67)
      const result = await harness.provider.current.checkQrLogin(qr.key)
      assert.equal(result.code, 67)
      assert.match(result.message, /已扫码/)
    }
  )
})

test('uses the host security bridge when it is available', async () => {
  const bridgeCalls = []
  const harness = createHarness({
    async getQrLogin() {
      bridgeCalls.push('get')
      return {
        key: 'secure-token',
        qrContent: 'https://bff-pc.qishui.com/light/invoke/scan_login?token=secure-token',
        imageDataUrl: 'data:image/png;base64,SECURE',
        expiresInSeconds: 120
      }
    },
    async checkQrLogin(key) {
      bridgeCalls.push(`check:${key}`)
      return {
        json: { message: 'success', data: { error_code: 0, status: '3' } },
        cookie: 'sessionid=secure-session'
      }
    },
    async clear() {
      bridgeCalls.push('clear')
    }
  })

  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/luna/pc/me') {
        return jsonResponse({
          user: { id: 'secure-user', nickname: '安全用户' }
        })
      }
      throw new Error('unexpected request: ' + url.pathname)
    },
    async () => {
      await activate(harness.context)
      const qr = await harness.provider.current.getQrLogin()
      assert.equal(qr.key, 'secure-token')
      assert.equal(qr.imageDataUrl, 'data:image/png;base64,SECURE')
      assert.equal(await harness.provider.current.getQrImage(qr.key), qr.imageDataUrl)

      const result = await harness.provider.current.checkQrLogin(qr.key)
      assert.deepEqual(result, { code: 0, message: '登录成功' })
      assert.deepEqual(bridgeCalls.slice(0, 2), ['get', 'check:secure-token'])
      assert.equal(harness.values.get('auth').cookie, 'sessionid=secure-session')
      assert.deepEqual(
        harness.logs.filter(([level]) => level === 'debug').map(([, message]) => message),
        [
          'Qishui secure QR created: hasScanUrl=true hasImage=true',
          'Qishui QR poll: status=3 errorCode=none responseCookie=true cookieSession=true bodySession=false'
        ]
      )
    }
  )
})

test('searches current endpoints with the login cookie and fills pages without skipping songs', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  const cursors = []
  await withFetch(
    async (input, options) => {
      const url = new URL(input)
      assert.equal(url.origin, 'https://api.qishui.com')
      assert.match(url.searchParams.get('iid'), /^\d+$/)
      assert.equal(options.headers.Cookie, 'sessionid=test')
      const cursor = Number(url.searchParams.get('cursor'))
      if (url.pathname === '/luna/search/track') {
        cursors.push(cursor)
        return jsonResponse({
          result_groups: [
            {
              next_cursor: String(cursor + 20),
              has_more: true,
              data: Array.from({ length: 20 }, (_, i) => ({
                entity: {
                  track: {
                    id: String(cursor + i + 1),
                    name: '歌曲',
                    artists: [{ name: '歌手' }]
                  }
                }
              }))
            }
          ]
        })
      }
      assert.equal(url.pathname, '/luna/search/playlist')
      return jsonResponse({
        result_groups: [
          {
            has_more: false,
            data: [
              {
                entity: {
                  playlist: {
                    id: 'p1',
                    title: '歌单',
                    owner: { nickname: '作者' }
                  }
                }
              }
            ]
          }
        ]
      })
    },
    async () => {
      await activate(harness.context)
      const songs = await harness.provider.current.searchSongs('音乐', 30)
      assert.equal(songs.items.length, 30)
      assert.deepEqual(cursors, [0, 20])
      assert.equal(songs.items[29].id, 'qishui:30')
      assert.ok(songs.total > 30)
      const playlists = await harness.provider.current.searchPlaylists('音乐', 30)
      assert.equal(playlists.items[0].name, '歌单')
      assert.equal(playlists.items[0].creatorName, '作者')
    }
  )
})

test('loads account profile and library and carries authentication and playlist type through pagination', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  const cursors = []
  await withFetch(
    async (input, options) => {
      const url = new URL(input)
      assert.equal(options.headers.Cookie, 'sessionid=test')
      if (url.pathname === '/luna/pc/me')
        return jsonResponse({
          my_info: {
            id: 'u1',
            nickname: '用户',
            is_vip: true,
            medium_avatar_url: {
              urls: ['https://p3.douyinpic.com/avatar.jpeg?from=123'],
              uri: 'avatar'
            }
          }
        })
      if (url.pathname === '/luna/pc/me/playlist') {
        assert.match(url.searchParams.get('iid'), /^\d+$/)
        return jsonResponse({
          playlists: [{ id: 'p1', title: '收藏的歌曲', type: 4 }]
        })
      }
      assert.equal(url.origin, 'https://api.qishui.com')
      assert.equal(url.pathname, '/luna/playlist/detail')
      const body = JSON.parse(options.body)
      assert.equal(body.playlist_type, 4)
      cursors.push(body.cursor)
      return jsonResponse({
        has_more: body.cursor === '',
        next_cursor: 'next',
        media_resources: [{ entity: { track: { id: body.cursor ? '2' : '1', name: '歌曲' } } }]
      })
    },
    async () => {
      await activate(harness.context)
      const profile = (await harness.provider.current.checkLogin()).profile
      assert.equal(profile.nickname, '用户')
      assert.equal(profile.userId, 'u1')
      assert.equal(profile.avatarUrl, 'https://p3.douyinpic.com/avatar.jpeg?from=123')
      assert.equal((await harness.provider.current.fetchUserLibrary()).likedPlaylist.id, 'p1')
      const tracks = await harness.provider.current.fetchPlaylistTracks('p1')
      assert.deepEqual(
        tracks.map((t) => t.id),
        ['qishui:1', 'qishui:2']
      )
      assert.deepEqual(cursors, ['', 'next'])
      await harness.provider.current.fetchPlaylistTracks('p1')
      assert.equal(cursors.length, 2)
    }
  )
})

test('reports empty and failed upstream responses instead of showing an empty library or search', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  await activate(harness.context)
  await withFetch(
    async () => new Response(''),
    async () => {
      await assert.rejects(harness.provider.current.searchSongs('歌曲'), /空响应/)
    }
  )
  await withFetch(
    async () =>
      jsonResponse({
        status_code: 1000006,
        status_info: { status_msg: 'ERR_REQUEST_FORBIDDEN' }
      }),
    async () => {
      await assert.rejects(harness.provider.current.fetchUserLibrary(), /1000006/)
      assert.equal((await harness.provider.current.checkLogin()).loggedIn, false)
    }
  )
})

test('resolves player metadata to audio and never forwards the login cookie to the player info host', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  await withFetch(
    async (input, options) => {
      const url = new URL(input)
      if (url.pathname === '/luna/pc/track_v2') {
        assert.equal(JSON.parse(options.body).track_id, '1')
        return jsonResponse({
          cover_url: 'https://example.com/cover.jpg',
          track_player: {
            url_player_info: 'https://open.bytedanceapi.com/player'
          }
        })
      }
      assert.equal(url.hostname, 'open.bytedanceapi.com')
      assert.equal(options.headers?.Cookie, undefined)
      return jsonResponse({
        Result: {
          Data: {
            PlayInfoList: [{ MainPlayUrl: 'https://audio.example.com/song.m4a' }]
          }
        }
      })
    },
    async () => {
      await activate(harness.context)
      assert.equal(
        await harness.provider.current.getPlaybackUrl({ id: 'qishui:1' }),
        'https://audio.example.com/song.m4a'
      )
    }
  )
})

test('uses official share audio when the retired account endpoint is empty and reports previews', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  await withFetch(
    async (input, options) => {
      const url = new URL(input)
      if (url.pathname === '/luna/pc/track_v2') return new Response('')
      assert.equal(url.origin, 'https://music.douyin.com')
      assert.equal(options.headers?.Cookie, undefined)
      return new Response(
        `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { track_page: { audioWithLyricsOption: { track_id: '1', url: 'https://audio.example.com/preview.m4a', encrypt: false, duration: 200, offsetDuration: 30 } } } })};</script>`
      )
    },
    async () => {
      await activate(harness.context)
      assert.equal(
        await harness.provider.current.getPlaybackUrl({ id: 'qishui:1' }),
        'https://audio.example.com/preview.m4a'
      )
      assert.ok(harness.logs.some(([, message]) => message.includes('is a preview')))
    }
  )
})

test('rejects encrypted share audio and does not treat a cover URL as playback', async () => {
  const harness = createHarness()
  harness.values.set('auth', { cookie: 'sessionid=test' })
  await withFetch(
    async (input) => {
      if (new URL(input).pathname === '/luna/pc/track_v2')
        return jsonResponse({
          track_player: { cover: 'https://example.com/cover.jpg' }
        })
      return new Response(
        `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { track_page: { audioWithLyricsOption: { track_id: '1', url: 'https://audio.example.com/encrypted', encrypt: true } } } })};</script>`
      )
    },
    async () => {
      await activate(harness.context)
      await assert.rejects(
        harness.provider.current.getPlaybackUrl({ id: 'qishui:1' }),
        /未提供可直接播放/
      )
    }
  )
})
