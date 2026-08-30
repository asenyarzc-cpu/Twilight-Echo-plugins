import assert from 'node:assert/strict'
import { test } from 'node:test'

const providerModule = await import('./index.mjs')
const { activate, deactivate } = providerModule

const CONSENT_VERSION = 'qqmusic-v1'
const SETTINGS_COMMAND = 'qqmusic.settings'

function createHarness(initialSettings = {}) {
  const values = new Map(Object.entries(initialSettings))
  const handlers = new Map()
  const contributions = []
  const logs = []
  const provider = { current: null }
  const context = {
    apiVersion: 1,
    storagePath: 'C:/plugin-data/qqmusic',
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

async function withWebSocket(WebSocketImplementation, callback) {
  const original = globalThis.WebSocket
  globalThis.WebSocket = WebSocketImplementation
  try {
    return await callback()
  } finally {
    globalThis.WebSocket = original
  }
}

function mqttVarInt(value) {
  const bytes = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function mqttText(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes])
}

function mqttPacket(type, body) {
  return Buffer.concat([Buffer.from([type]), mqttVarInt(body.length), body])
}

function mqttConnack(reasonCode = 0) {
  return mqttPacket(0x20, Buffer.from([0, reasonCode, 0]))
}

function mqttSuback(reasonCode = 0) {
  return mqttPacket(0x90, Buffer.from([0, 1, 0, reasonCode]))
}

function mqttQrEvent(qrcodeId, type, payload) {
  const properties = Buffer.concat([Buffer.from([0x26]), mqttText('type'), mqttText(type)])
  const body = Buffer.concat([
    mqttText(`management.qrcode_login/${qrcodeId}`),
    mqttVarInt(properties.length),
    properties,
    Buffer.from(JSON.stringify(payload), 'utf8')
  ])
  return mqttPacket(0x30, body)
}

class FakeMqttWebSocket {
  static plan = {}
  static instances = []

  constructor(url, protocol) {
    assert.equal(url, 'wss://mu.y.qq.com/ws/handshake')
    assert.equal(protocol, 'mqtt')
    this.listeners = new Map()
    this.closed = false
    this.sent = []
    FakeMqttWebSocket.instances.push(this)
    queueMicrotask(() => this.emit('open', {}))
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name) || []
    this.listeners.set(
      name,
      listeners.filter((item) => item !== listener)
    )
  }

  send(value) {
    const packet = Buffer.from(value)
    this.sent.push(packet)
    const type = packet[0] >> 4
    if (type === 1) {
      queueMicrotask(() => this.emit('message', { data: mqttConnack(FakeMqttWebSocket.plan.connackCode || 0) }))
      return
    }
    if (type === 8) {
      queueMicrotask(() => {
        this.emit('message', { data: mqttSuback(FakeMqttWebSocket.plan.subackCode || 0) })
        for (const event of FakeMqttWebSocket.plan.events || []) {
          this.emit('message', { data: event })
        }
      })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => this.emit('close', {}))
  }

  emit(name, value) {
    for (const listener of this.listeners.get(name) || []) listener(value)
  }
}

function resetFakeMqtt(plan = {}) {
  FakeMqttWebSocket.plan = plan
  FakeMqttWebSocket.instances = []
}

async function flushAsync() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function startPlugin(initialSettings = {}) {
  const harness = createHarness(initialSettings)
  await activate(harness.context)
  return harness
}

async function acceptDisclaimer(harness) {
  await harness.handlers.get(SETTINGS_COMMAND)({ disclaimer: CONSENT_VERSION })
}

function nativeDevice(overrides = {}) {
  return {
    version: 1,
    display: 'QMAPI.123456.001',
    product: 'iarim',
    device: 'sagit',
    board: 'eomam',
    model: 'MI 6',
    fingerprint: 'xiaomi/iarim/sagit:10/eomam.200122.001/1234567:user/release-keys',
    procVersion: 'Linux 5.4.0-test (android-build@google.com)',
    imei: '123456789012345',
    brand: 'Xiaomi',
    androidId: '0123456789abcdef',
    openUdid: '0123456789abcdef0123456789abcdef',
    osRelease: '10',
    sdk: 29,
    qimei: 'q16-test',
    qimei36: 'q36-test',
    qimeiSavedAt: Date.now(),
    sessionUid: 'session-uid',
    sessionSid: 'session-sid',
    sessionVkey: 'session-vkey',
    ...overrides
  }
}

function nativeAuth(overrides = {}) {
  return {
    version: 2,
    uin: '123456',
    credential: {
      musicid: '123456',
      str_musicid: '123456',
      musickey: 'private-key',
      loginType: 6,
      encryptUin: 'encrypted-uin'
    },
    profile: {
      userId: '123456',
      nickname: '测试用户',
      avatarUrl: 'https://q.qlogo.cn/headimg_dl?dst_uin=123456&spec=140'
    },
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides
  }
}

function musicuResponse(data) {
  return jsonResponse({ code: 0, req_0: { code: 0, data } })
}

function qimeiResponse() {
  return jsonResponse({
    code: 0,
    data: JSON.stringify({ code: 0, data: { q16: 'q16-test', q36: 'q36-test' } })
  })
}

function nativeQrFetch(qrcodeId, png) {
  return async (_input, options) => {
    const body = JSON.parse(options.body)
    if (body.req_0.method === 'GetSession') {
      return musicuResponse({ session: { uid: 'session-uid', sid: 'session-sid', vkey: 'session-vkey' } })
    }
    assert.equal(body.req_0.method, 'CreateQRCode')
    return musicuResponse({ qrcodeID: qrcodeId, qrcode: png.toString('base64'), expiresIn: 180 })
  }
}

test.afterEach(async () => {
  await deactivate()
})

test('registers the QQ provider and controlled settings contribution', async () => {
  const harness = await startPlugin()
  assert.equal(harness.provider.current.id, 'qq')
  assert.deepEqual(harness.provider.current.capabilities, [
    'search',
    'playbackUrl',
    'lyrics',
    'cover',
    'playlist',
    'library',
    'login'
  ])
  assert.deepEqual(harness.provider.current.ui.streamingSections, [
    {
      id: 'new-songs',
      title: '新歌推荐',
      icon: 'pi pi-sparkles',
      method: 'fetchRecommendSongs'
    }
  ])
  for (const method of [
    'fetchRecommendSongs',
    'fetchRecommendPlaylists',
    'fetchPlaylistCategories',
    'fetchDiscoveryPlaylists'
  ]) {
    assert.equal(typeof harness.provider.current[method], 'function')
  }
  assert.equal(harness.contributions[0].kind, 'settingsPanel')
  assert.equal(harness.contributions[0].command, SETTINGS_COMMAND)
  assert.equal(harness.handlers.has(SETTINGS_COMMAND), true)
})

test('blocks all upstream work until the disclaimer is accepted', async () => {
  const harness = await startPlugin()
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return jsonResponse({ code: 0, data: {} })
    },
    async () => {
      await assert.rejects(
        () => harness.provider.current.searchSongs('周杰伦'),
        /阅读并确认免责声明/
      )
      assert.equal(calls, 0)
      const form = await harness.handlers.get(SETTINGS_COMMAND)({
        source: 'settingsPanel',
        panelId: 'qqmusic-settings'
      })
      assert.equal(form.kind, 'settings-form')
      assert.equal(form.submitCommand, SETTINGS_COMMAND)
      assert.match(form.notice, /仅供个人学习与研究使用/)
      assert.match(form.notice, /github.com\/asenyarzc-cpu\/Twilight-Echo-plugins\/issues/)
    }
  )
})

test('saves versioned disclaimer consent without logging account data', async () => {
  const harness = await startPlugin()
  await assert.rejects(
    () => harness.handlers.get(SETTINGS_COMMAND)({ disclaimer: 'wrong' }),
    /同意免责声明/
  )
  const result = await harness.handlers.get(SETTINGS_COMMAND)({ disclaimer: CONSENT_VERSION })
  assert.equal(harness.values.get('disclaimer').disclaimerVersion, CONSENT_VERSION)
  assert.equal(typeof harness.values.get('disclaimer').acceptedAt, 'string')
  assert.match(result.message, /确认已保存/)
  assert.equal(result.form.fields[0].value, CONSENT_VERSION)
  assert.deepEqual(harness.logs, [['info', 'Registering QQ Music provider']])
})

test('redacts credential-shaped upstream errors from provider failures', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  await withFetch(
    async () =>
      jsonResponse({
        code: -1,
        msg: '{"qqmusic_key":"secret-key","uin":"123456"}'
      }),
    async () => {
      await assert.rejects(
        () => harness.provider.current.searchSongs('周杰伦'),
        (error) => {
          assert.equal(String(error).includes('secret-key'), false)
          assert.match(String(error), /credential-redacted/)
          return true
        }
      )
    }
  )
})

test('maps QQ song search results to provider-prefixed tracks', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  await withFetch(
    async (input) => {
      const url = new URL(String(input))
      assert.equal(url.pathname, '/soso/fcgi-bin/client_search_cp')
      assert.equal(url.searchParams.get('w'), '周杰伦')
      assert.equal(url.searchParams.get('p'), '2')
      return jsonResponse({
        code: 0,
        data: {
          song: {
            totalnum: 1,
            list: [
              {
                songmid: '003rJSwm3TechU',
                songid: 123,
                songname: '晴天',
                interval: 269,
                singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
                albumname: '叶惠美',
                albummid: '002J4UUk29y8BY'
              }
            ]
          }
        }
      })
    },
    async () => {
      const result = await harness.provider.current.searchSongs('周杰伦', 10, 10)
      assert.equal(result.total, 1)
      assert.deepEqual(result.items[0], {
        id: 'qq:003rJSwm3TechU',
        title: '晴天',
        artist: '周杰伦',
        artists: [{ id: '0025NhlN2yWrP4', name: '周杰伦' }],
        album: '叶惠美',
        filePath: 'qq:003rJSwm3TechU',
        fileName: '晴天.mp3',
        duration: 269,
        size: 0,
        cover:
          'https://y.gtimg.cn/music/photo_new/T002R300x300M000002J4UUk29y8BY.jpg',
        lyrics: null,
        translatedLyrics: null,
        source: 'qq',
        streamUrl: null,
        bpm: undefined,
        providerSongId: '123'
      })
    }
  )
})

test('maps playlist and artist search results through the shared QQ search endpoint', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  let call = 0
  await withFetch(
    async (input) => {
      call += 1
      const url = new URL(String(input))
      if (url.searchParams.get('remoteplace') === 'txt.yqq.playlist') {
        return jsonResponse({
          code: 0,
          data: { playlist: { totalnum: 1, list: [{ dissid: '42', dissname: '华语精选', songnum: 12 }] } }
        })
      }
      return jsonResponse({
        code: 0,
        data: { singer: { totalnum: 1, list: [{ singerMid: 's1', singerName: '歌手 A' }] } }
      })
    },
    async () => {
      const playlists = await harness.provider.current.searchPlaylists('华语')
      const artists = await harness.provider.current.searchArtists('歌手')
      assert.equal(call, 2)
      assert.deepEqual(playlists.items[0], {
        id: '42',
        name: '华语精选',
        cover: null,
        trackCount: 12,
        creatorName: undefined,
        owned: false,
        qqType: 0
      })
      assert.deepEqual(artists.items[0], { id: 's1', name: '歌手 A', cover: null })
    }
  )
})

test('loads Rain120 homepage songs and playlists through public Musicu requests', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  let calls = 0
  await withFetch(
    async (input, options) => {
      calls += 1
      const url = new URL(String(input))
      assert.equal(url.href.startsWith('https://u.y.qq.com/cgi-bin/musicu.fcg?'), true)
      assert.equal(options.headers.Referer, 'https://y.qq.com/portal/player.html')
      const data = JSON.parse(url.searchParams.get('data'))
      assert.deepEqual(data.comm, { ct: 24 })
      if (data.new_song) {
        assert.equal(data.new_song.method, 'get_new_song_info')
        return jsonResponse({
          code: 0,
          new_song: {
            code: 0,
            data: {
              songlist: [
                {
                  id: 11,
                  mid: 'new-mid',
                  title: '新歌',
                  interval: 180,
                  singer: [{ id: 12, mid: 'artist-mid', name: '新歌手' }],
                  album: { mid: 'album-mid', name: '新专辑' },
                  file: { media_mid: 'media-mid', size_128mp3: 2048 }
                }
              ]
            }
          }
        })
      }
      assert.equal(data.recomPlaylist.method, 'get_hot_recommend')
      assert.equal(data.playlist.method, 'get_playlist_by_category')
      return jsonResponse({
        code: 0,
        recomPlaylist: {
          code: 0,
          data: {
            v_hot: [
              {
                content_id: 42,
                title: '编辑推荐',
                cover: 'http://img.example/hot.jpg',
                username: '编辑'
              }
            ]
          }
        },
        playlist: {
          code: 0,
          data: {
            v_playlist: [
              { tid: 42, title: '重复歌单' },
              {
                tid: 43,
                title: '流行精选',
                cover_url_big: 'http://img.example/category.jpg',
                creator_info: { nick: '创建者' },
                song_ids: [1, 2]
              }
            ]
          }
        }
      })
    },
    async () => {
      const songs = await harness.provider.current.fetchRecommendSongs()
      const playlists = await harness.provider.current.fetchRecommendPlaylists()
      assert.equal(calls, 2)
      assert.equal(songs[0].id, 'qq:new-mid')
      assert.equal(songs[0].album, '新专辑')
      assert.equal(songs[0].size, 2048)
      assert.equal(songs[0].providerMediaId, 'media-mid')
      assert.deepEqual(
        playlists.map((playlist) => [playlist.id, playlist.name, playlist.creatorName]),
        [
          ['42', '编辑推荐', '编辑'],
          ['43', '流行精选', '创建者']
        ]
      )
      assert.equal(playlists[1].trackCount, 2)
    }
  )
})

test('loads Rain120 playlist categories and paged discovery playlists', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  let calls = 0
  await withFetch(
    async (input, options) => {
      calls += 1
      const url = new URL(String(input))
      assert.equal(options.headers.Referer, 'https://c.y.qq.com/')
      if (url.pathname.endsWith('/fcg_get_diss_tag_conf.fcg')) {
        return jsonResponse({
          code: 0,
          data: {
            categories: [
              {
                categoryGroupName: '热门',
                items: [{ categoryId: 10000000, categoryName: '全部' }]
              },
              {
                categoryGroupName: '流派',
                items: [{ categoryId: 6, categoryName: '流行' }]
              }
            ]
          }
        })
      }
      assert.equal(url.pathname.endsWith('/fcg_get_diss_by_tag.fcg'), true)
      assert.equal(url.searchParams.get('categoryId'), '6')
      assert.equal(url.searchParams.get('sortId'), '2')
      assert.equal(url.searchParams.get('sin'), '10')
      assert.equal(url.searchParams.get('ein'), '19')
      return jsonResponse({
        code: 0,
        data: {
          sum: 25,
          list: [
            {
              dissid: '77',
              dissname: '流行歌单',
              imgurl: 'http://img.example/discovery.jpg',
              song_count: 18,
              creator: { name: '发现用户' }
            }
          ]
        }
      })
    },
    async () => {
      const catalogue = await harness.provider.current.fetchPlaylistCategories()
      assert.deepEqual(catalogue.hotTags, ['全部'])
      assert.deepEqual(catalogue.groups[1], {
        id: 1,
        name: '流派',
        tags: [{ name: '流行', hot: false }]
      })
      const page = await harness.provider.current.fetchDiscoveryPlaylists('流行', 'new', 10, 10)
      assert.equal(calls, 2)
      assert.equal(page.total, 25)
      assert.equal(page.offset, 10)
      assert.equal(page.limit, 10)
      assert.equal(page.hasMore, true)
      assert.deepEqual(page.items[0], {
        id: '77',
        name: '流行歌单',
        cover: 'http://img.example/discovery.jpg',
        trackCount: 18,
        creatorName: '发现用户',
        owned: false,
        qqType: 0
      })
    }
  )
})

test('loads a public discovered playlist without requiring QQ login', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  let calls = 0
  await withFetch(
    async (input, options) => {
      calls += 1
      const url = new URL(String(input))
      if (url.pathname === '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg') {
        assert.equal(url.searchParams.get('disstid'), '7011264340')
        assert.equal(options.headers.Referer, 'https://y.qq.com/n/ryqq/playlist/7011264340')
        return jsonResponse({ code: 0, subcode: 4000, msg: 'check privacy error!' })
      }
      assert.equal(String(input), 'https://u.y.qq.com/cgi-bin/musicu.fcg')
      assert.equal(options.headers.Referer, 'https://y.qq.com/portal/player.html')
      const body = JSON.parse(options.body)
      assert.equal(body.req_0.method, 'CgiGetDiss')
      assert.equal(body.req_0.param.disstid, 7011264340)
      return jsonResponse({
        code: 0,
        req_0: {
          code: 0,
          data: {
            songlist: [
              {
                id: 21,
                mid: 'public-mid',
                title: '公开歌曲',
                singer: [{ mid: 'public-artist', name: '公开歌手' }],
                album: { mid: 'public-album', name: '公开专辑' },
                file: { media_mid: 'public-media' }
              }
            ]
          }
        }
      })
    },
    async () => {
      const tracks = await harness.provider.current.fetchPlaylistTracks('7011264340')
      assert.equal(calls, 2)
      assert.equal(tracks[0].id, 'qq:public-mid')
      assert.equal(tracks[0].providerMediaId, 'public-media')
    }
  )
})

test('performs QQ Music native QR login and persists only a private auth session', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let calls = 0
  resetFakeMqtt({
    events: [
      mqttQrEvent('native-qr', 'cookies', {
        cookies: {
          qqmusic_uin: { value: '123456' },
          qqmusic_key: { value: 'qr-secret' }
        }
      })
    ]
  })
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      async (input, options) => {
        calls += 1
        if (String(input) === 'https://api.tencentmusic.com/tme/trpc/proxy') {
          assert.equal(options.headers.appid, 'qimei_qq_android')
          const body = JSON.parse(options.body)
          assert.equal(typeof body.qimeiParams.key, 'string')
          assert.equal(typeof body.qimeiParams.params, 'string')
          return qimeiResponse()
        }
        assert.equal(String(input), 'https://u.y.qq.com/cgi-bin/musicu.fcg')
        assert.equal(options.headers['User-Agent'], 'QQMusic 14090008(android 10)')
        const body = JSON.parse(options.body)
        assert.equal(body.comm.QIMEI, 'q16-test')
        assert.equal(body.comm.QIMEI36, 'q36-test')
        if (body.req_0.method === 'GetSession') {
          assert.equal(body.req_0.module, 'music.getSession.session')
          return musicuResponse({
            session: { uid: 'session-uid', sid: 'session-sid', vkey: 'session-vkey' }
          })
        }
        if (body.req_0.method === 'CreateQRCode') {
          assert.equal(body.req_0.module, 'music.login.LoginServer')
          assert.deepEqual(body.req_0.param, { tmeAppID: 'qqmusic', ct: 11, cv: 14090008 })
          assert.equal(body.comm.ct, 23)
          assert.equal(body.comm.cv, 0)
          return musicuResponse({ qrcodeID: 'native-qr', qrcode: png.toString('base64'), expiresIn: 180 })
        }
        if (body.req_0.method === 'Login') {
          assert.equal(body.req_0.module, 'music.login.LoginServer')
          assert.deepEqual(body.req_0.param, {
            musicid: 123456,
            qrCodeID: 'native-qr',
            token: 'qr-secret'
          })
          assert.equal(body.comm.tmeLoginType, 6)
          return musicuResponse({
            musicid: '123456',
            musickey: 'music-key',
            encryptUin: 'encrypted-uin',
            loginType: 6
          })
        }
        assert.equal(body.req_0.method, 'GetLoginUserInfo')
        assert.equal(body.req_0.module, 'music.UserInfo.userInfoServer')
        assert.match(options.headers.Cookie, /qqmusic_key=music-key/)
        return musicuResponse({ info: { nick: '扫码用户' } })
      },
      async () => {
        const qr = await harness.provider.current.getQrLogin()
        assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
        assert.ok(qr.expiresInSeconds >= 179 && qr.expiresInSeconds <= 180)
        await flushAsync()
        assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
          code: 0,
          message: '登录成功'
        })
        assert.equal(calls, 5)
        const auth = harness.values.get('auth')
        assert.deepEqual(Object.keys(auth).sort(), ['credential', 'profile', 'uin', 'updatedAt', 'version'])
        assert.equal(auth.uin, '123456')
        assert.equal(auth.credential.musickey, 'music-key')
        assert.equal(harness.values.get('native-device').qimei, 'q16-test')
        assert.equal(JSON.stringify(harness.logs).includes('qr-secret'), false)
        assert.equal(JSON.stringify(harness.logs).includes('music-key'), false)
        assert.equal((await harness.provider.current.checkLogin()).loggedIn, true)
      }
    )
  })
})

test('reports invalid native QR credentials instead of waiting forever', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    'native-device': nativeDevice()
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  resetFakeMqtt({
    events: [
      mqttQrEvent('failed-qr', 'cookies', {
        cookies: { qqmusic_uin: { value: '123456' } }
      })
    ]
  })
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      nativeQrFetch('failed-qr', png),
      async () => {
        const qr = await harness.provider.current.getQrLogin()
        await flushAsync()
        assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
          code: 502,
          message: 'QQ 音乐已确认扫码，但登录会话未建立，请刷新二维码后重试'
        })
        assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
          code: 65,
          message: '二维码不存在或已过期'
        })
        assert.equal(harness.values.has('auth'), false)
        const logText = JSON.stringify(harness.logs)
        assert.equal(logText.includes('123456'), false)
        assert.equal(logText.includes('failed-qr'), false)
      }
    )
  })
})

test('reports native QR connection failures before a user scans', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    'native-device': nativeDevice()
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  resetFakeMqtt({ connackCode: 0x87 })
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      nativeQrFetch('rejected-qr', png),
      async () => {
        await assert.rejects(
          () => harness.provider.current.getQrLogin(),
          /二维码登录初始化失败/
        )
        assert.equal(JSON.stringify(harness.logs).includes('rejected-qr'), false)
      }
    )
  })
})

test('maps scanned and expired native QR states and releases the listener', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    'native-device': nativeDevice()
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  resetFakeMqtt({ events: [mqttQrEvent('expired-qr', 'scanned', {})] })
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      nativeQrFetch('expired-qr', png),
      async () => {
        const qr = await harness.provider.current.getQrLogin()
        await flushAsync()
        assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
          code: 67,
          message: '已扫描二维码'
        })
        const originalNow = Date.now
        Date.now = () => originalNow() + 4 * 60 * 1000
        try {
          assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
            code: 65,
            message: '二维码已过期'
          })
          assert.equal(FakeMqttWebSocket.instances[0].closed, true)
        } finally {
          Date.now = originalNow
        }
      }
    )
  })
})

test('clears uncompleted native QR sessions during deactivation', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    'native-device': nativeDevice()
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  resetFakeMqtt()
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      nativeQrFetch('deactivate-qr', png),
      async () => {
        const qr = await harness.provider.current.getQrLogin()
        await deactivate()
        assert.equal(FakeMqttWebSocket.instances[0].closed, true)
        const restarted = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
        assert.deepEqual(await restarted.provider.current.checkQrLogin(qr.key), {
          code: 65,
          message: '二维码不存在或已过期'
        })
      }
    )
  })
})

test('logout clears the private session and any uncompleted native QR state', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  resetFakeMqtt()
  await withWebSocket(FakeMqttWebSocket, async () => {
    await withFetch(
      nativeQrFetch('logout-qr', png),
      async () => {
        const qr = await harness.provider.current.getQrLogin()
        await harness.provider.current.logout()
        assert.equal(harness.values.has('auth'), false)
        assert.equal(harness.values.has('native-device'), false)
        assert.equal(FakeMqttWebSocket.instances[0].closed, true)
        assert.deepEqual(await harness.provider.current.checkQrLogin(qr.key), {
          code: 65,
          message: '二维码不存在或已过期'
        })
      }
    )
  })
})

test('requires a new QR login instead of reusing a partial legacy cookie session', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: { cookie: 'uin=o123456; qqmusic_key=legacy-private-key', uin: '123456' }
  })
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return jsonResponse({})
    },
    async () => {
      assert.equal((await harness.provider.current.checkLogin()).loggedIn, false)
      await assert.rejects(
        () => harness.provider.current.getPlaybackUrl({ id: 'qq:mid-1' }),
        /重新扫码登录/
      )
      assert.equal(calls, 0)
    }
  )
})

test('clears a rejected native session and gives an actionable re-login message', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  await withFetch(
    async (_input, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.req_0.method, 'UrlGetVkey')
      return jsonResponse({ code: 0, req_0: { code: 1000, data: {} } })
    },
    async () => {
      await assert.rejects(
        () => harness.provider.current.getPlaybackUrl({ id: 'qq:mid-1' }),
        /重新扫码登录/
      )
      assert.equal(harness.values.has('auth'), false)
      assert.equal(harness.values.has('native-device'), false)
    }
  )
})

test('honors cancellation before creating a native QR session', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  controller.abort(reason)
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return jsonResponse({})
    },
    async () => {
      await assert.rejects(
        () => harness.provider.current.getQrLogin({ signal: controller.signal }),
        /caller cancelled/
      )
      assert.equal(calls, 0)
    }
  )
})

test('loads user playlists and song details with private QQ session headers', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  const requests = []
  await withFetch(
    async (input, options) => {
      assert.equal(String(input), 'https://u.y.qq.com/cgi-bin/musicu.fcg')
      const body = JSON.parse(options.body)
      requests.push({ body, options })
      assert.match(options.headers.Cookie, /qqmusic_key=private-key/)
      assert.equal(body.comm.authst, 'private-key')
      if (body.req_0.method === 'GetPlaylistByUin') {
        return musicuResponse({
          v_playlist: [
            { dirid: '201', name: '我喜欢', type: 1, songnum: 1 },
            { dissid: '200', dissname: '通勤', type: 0, songnum: 1 }
          ]
        })
      }
      if (body.req_0.method === 'GetLoginUserInfo') return musicuResponse({ info: { nick: '测试用户' } })
      assert.equal(body.req_0.method, 'CgiGetDiss')
      if (body.req_0.param.dirid === 201) {
        assert.equal(body.req_0.param.enc_host_uin, 'encrypted-uin')
        return musicuResponse({
          songlist: [{ songmid: 'liked-1', songid: 2, songname: '喜欢的歌', singer: [{ name: '歌手' }] }]
        })
      }
      assert.equal(body.req_0.param.disstid, 200)
      return musicuResponse({
        songlist: [
          {
            songmid: 'mid-1',
            songid: 1,
            songname: '歌',
            interval: 200,
            singer: [{ name: '歌手' }],
            file: { media_mid: 'media-1' }
          }
        ]
      })
    },
    async () => {
      const library = await harness.provider.current.fetchUserLibrary()
      assert.equal(library.likedPlaylist.id, 'liked')
      assert.equal(library.playlists[1].name, '通勤')
      const tracks = await harness.provider.current.fetchPlaylistTracks('200', true)
      const likedTracks = await harness.provider.current.fetchPlaylistTracks('liked', true)
      assert.equal(tracks[0].id, 'qq:mid-1')
      assert.equal(tracks[0].providerMediaId, 'media-1')
      assert.equal(likedTracks[0].id, 'qq:liked-1')
      assert.equal(requests.length, 4)
      assert.equal((await harness.provider.current.getProfile()).nickname, '测试用户')
    }
  )
})

test('falls back from legacy lyric endpoint and requests plaintext LRC from Musicu', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  let calls = 0
  await withFetch(
    async (input, options) => {
      calls += 1
      if (String(input).includes('/lyric/fcgi-bin')) return jsonResponse({ code: -1, lyric: '' })
      const body = JSON.parse(options.body)
      assert.equal(body.req_0.module, 'music.musichallSong.PlayLyricInfo')
      assert.equal(body.req_0.method, 'GetPlayLyricInfo')
      assert.equal(body.req_0.param.crypt, 2)
      return jsonResponse({
        req_0: { data: { lyric: '[00:01.00]歌词', trans: '[00:01.00]translation' } }
      })
    },
    async () => {
      const result = await harness.provider.current.getLyrics({ id: 'qq:mid-1' })
      assert.equal(calls, 2)
      assert.deepEqual(result, {
        lyrics: '[00:01.00]歌词',
        translatedLyrics: '[00:01.00]translation',
        wordLyrics: null
      })
    }
  )
})

test('uses quality fallback and serves playback through the local Range proxy', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  const realFetch = globalThis.fetch
  const vkeyRequests = []
  let streamRequests = 0
  await withFetch(
    async (input, options) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:')) return realFetch(input, options)
      if (url === 'https://u.y.qq.com/cgi-bin/musicu.fcg') {
        const body = JSON.parse(options.body)
        assert.equal(body.req_0.module, 'music.vkey.GetVkey')
        assert.equal(body.req_0.method, 'UrlGetVkey')
        assert.equal(body.comm.authst, 'private-key')
        const qualityFile = body.req_0.param.filename[0]
        vkeyRequests.push(qualityFile)
        if (qualityFile.startsWith('F000')) {
          return musicuResponse({ sip: ['https://stream.example/'], midurlinfo: [{ songmid: 'mid-1', purl: '' }] })
        }
        return musicuResponse({
          sip: [],
          midurlinfo: [{ songmid: 'mid-1', purl: '/audio.mp3' }]
        })
      }
      if (url === 'http://dl.stream.qqmusic.qq.com/audio.mp3') {
        streamRequests += 1
        return new Response(Buffer.from('audio-data'), {
          status: 206,
          headers: {
            'content-type': 'audio/mpeg',
            'content-range': 'bytes 0-9/10',
            'content-length': '10',
            'accept-ranges': 'bytes'
          }
        })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    async () => {
      const url = await harness.provider.current.getPlaybackUrl(
        { id: 'qq:mid-1' },
        { quality: 'flac' }
      )
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/qqmusic\/stream\//)
      assert.deepEqual(vkeyRequests.map((value) => value.slice(0, 4)), ['F000', 'M800'])
      const response = await realFetch(url, { headers: { Range: 'bytes=0-9' } })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), 'bytes 0-9/10')
      assert.equal(await response.text(), 'audio-data')
      assert.equal(streamRequests, 1)
    }
  )
})

test('continues the quality ladder when an upstream vkey request fails', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  const realFetch = globalThis.fetch
  const qualityRequests = []
  await withFetch(
    async (input, options) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:')) return realFetch(input, options)
      if (url === 'https://u.y.qq.com/cgi-bin/musicu.fcg') {
        const body = JSON.parse(options.body)
        const fileName = body.req_0.param.filename[0]
        qualityRequests.push(fileName.slice(0, 4))
        if (fileName.startsWith('F000')) return jsonResponse({ message: 'temporary failure' }, 503)
        return musicuResponse({
          sip: ['https://stream.example/'],
          midurlinfo: [{ songmid: 'mid-error', purl: '/audio.mp3' }]
        })
      }
      if (url === 'https://stream.example/audio.mp3') {
        return new Response(Buffer.from('fallback-audio'), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' }
        })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    async () => {
      const url = await harness.provider.current.getPlaybackUrl(
        { id: 'qq:mid-error' },
        { quality: 'flac' }
      )
      assert.deepEqual(qualityRequests, ['F000', 'M800'])
      assert.equal(await (await realFetch(url)).text(), 'fallback-audio')
    }
  )
})

test('refreshes one expired upstream stream URL and rejects invalid proxy tokens', async () => {
  const harness = await startPlugin({
    disclaimer: { disclaimerVersion: CONSENT_VERSION },
    auth: nativeAuth(),
    'native-device': nativeDevice()
  })
  const realFetch = globalThis.fetch
  let vkeyCalls = 0
  let streamCalls = 0
  await withFetch(
    async (input, options) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:')) return realFetch(input, options)
      if (url === 'https://u.y.qq.com/cgi-bin/musicu.fcg') {
        vkeyCalls += 1
        return musicuResponse({
          sip: ['https://stream.example/'],
          midurlinfo: [{ songmid: 'mid-2', purl: `/audio-${vkeyCalls}.mp3` }]
        })
      }
      if (url.startsWith('https://stream.example/')) {
        streamCalls += 1
        if (streamCalls === 1) return new Response('', { status: 403 })
        return new Response(Buffer.from('fresh-audio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      }
      throw new Error(`unexpected request: ${url}`)
    },
    async () => {
      const url = await harness.provider.current.getPlaybackUrl({ id: 'qq:mid-2' })
      const response = await realFetch(url)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'fresh-audio')
      assert.equal(vkeyCalls, 2)
      assert.equal(streamCalls, 2)
      const invalid = await realFetch(`${url}invalid`)
      assert.equal(invalid.status, 404)
    }
  )
})

test('propagates cancellation and clears the proxy during deactivation', async () => {
  const harness = await startPlugin({ disclaimer: { disclaimerVersion: CONSENT_VERSION } })
  const controller = new AbortController()
  await withFetch(
    (_input, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }),
    async () => {
      const pending = harness.provider.current.searchSongs('cancel', 10, 0, { signal: controller.signal })
      controller.abort(new Error('caller cancelled'))
      await assert.rejects(pending, /caller cancelled/)
    }
  )
  await deactivate()
  await assert.rejects(() => harness.provider.current.searchSongs('after-stop'), /尚未激活/)
})
