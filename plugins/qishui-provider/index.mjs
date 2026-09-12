import { createHash, randomBytes } from 'node:crypto'
import { resolvePlaybackUrl } from './playback.mjs'
import { imageUrl } from './images.mjs'
import { createHome, homeSections } from './home.mjs'

const PROVIDER_ID = 'qishui'
const AUTH_KEY = 'auth'
const SETTINGS_COMMAND = 'qishui.settings'

const PC_HOST = 'https://api.qishui.com'
const LUNA_HOST = 'https://beta-luna.douyin.com'

const AID = '386088'
const VERSION_CODE = '30020100'
const PC_DEVICE_ID = randomDigits(16)
const PC_INSTALL_ID = randomDigits(15)
const COMPUTER_NAME =
  typeof process !== 'undefined' && typeof process.env?.COMPUTERNAME === 'string'
    ? process.env.COMPUTERNAME.trim() || 'Windows-PC'
    : 'Windows-PC'

const PASSPORT = {
  passport_jssdk_version: '2.4.13',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  aid: AID,
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_frontier: 'true',
  is_new_login: '1',
  language: 'zh',
  account_sdk_source: 'web',
  p_js_v: '2.4.13',
  p_js_t: 'pro',
  p_zt: '3.3.5',
  p_ver: '1.0.29',
  request_host: 'app://resources',
  p_bd: '1.0.0.41',
  is_from_iesaccountsaas: '1',
  device_platform: 'PC',
  region: 'cn',
  geo_region: 'cn',
  os_region: 'cn',
  sim_region: '',
  version_code: '3.6.0'
}

const PC_UA = 'LunaPC/3.3.0(359450208)'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) SodaMusic/3.1.2 Chrome/136.0.7103.59 ' +
  'Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 ' +
  'Safari/537.36'
const APP_UA = 'Luna/19.1.0 Android'
const REQUEST_TIMEOUT_MS = 15000
const QR_TTL_MS = 3 * 60 * 1000
const PLAYLIST_TTL_MS = 5 * 60 * 1000

let pluginContext = null
let loginCache = null
let qrCookie = ''
let qrSession = null
let qishuiAuthApi = null
const playlistCache = new Map()
const playlistTypes = new Map()

export async function activate(context) {
  pluginContext = context
  qishuiAuthApi = context.twilight?.qishuiAuth || null
  context.logger?.info('Registering Qishui Music provider')

  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: '汽水音乐',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-headphones',
      color: '#ff5b7f',
      description: '汽水音乐曲库',
      authType: 'qr',
      loginInstructions: '使用抖音 App 扫码并确认登录',
      qrStatusCodes: { waiting: 66, scanned: 67, expired: 65, success: 0 },
      streamingHome: {
        requiresLogin: false,
        subtitle: '汽水音乐 · 发现你喜欢的声音'
      },
      streamingSections: homeSections,
      streamingSearch: true,
      streamingLibraryTab: true,
      unifiedLibrary: true
    },
    searchSongs,
    ...createHome({ appPost, mapPlaylist, mapTrack, fetchUserLibrary, requireAuth, playlistTypes }),
    searchPlaylists,
    getPlaybackUrl,
    getLyrics,
    fetchPlaylistTracks,
    fetchUserLibrary,
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    getQrKey: () => getQrLogin().then((login) => login.key),
    getQrImage: async (key) => getQrImage(key),
    checkQrLogin
  })

  await context.twilight.ui.register({
    id: 'qishui-settings',
    kind: 'settingsPanel',
    title: '汽水音乐音源',
    description: '汽水音乐扫码登录与插件信息',
    command: SETTINGS_COMMAND
  })
  context.twilight.ui.onCommand(SETTINGS_COMMAND, () => createSettingsForm())
}

export async function deactivate() {
  if (qishuiAuthApi?.clear) await qishuiAuthApi.clear().catch(() => undefined)
  qrSession = null
  qrCookie = ''
  loginCache = null
  playlistCache.clear()
  playlistTypes.clear()
  qishuiAuthApi = null
  pluginContext = null
}

async function createSettingsForm() {
  const state = await checkLogin()
  return {
    kind: 'settings-form',
    submitCommand: SETTINGS_COMMAND,
    notice: [
      '本插件不需要单独运行 API、Python、Node 服务或 Docker。',
      '插件会直接访问汽水音乐官方相关接口。',
      '登录会话只保存于 Twilight Echo 插件私有设置中。',
      '账号播放接口不可用时使用官方分享页音频，付费歌曲可能仅提供试听片段。',
      '本插件不提供破解、DRM 绕过或下载功能。'
    ].join('\n'),
    fields: [
      {
        key: 'state',
        label: '登录状态',
        type: 'text',
        readonly: true,
        value: state.loggedIn ? `已登录：${state.profile?.nickname || '汽水用户'}` : '未登录'
      }
    ]
  }
}

async function checkLogin() {
  const auth = await readAuth()
  if (!auth?.cookie) return { loggedIn: false, profile: null }

  if (loginCache && loginCache.cookie === auth.cookie && Date.now() < loginCache.expiresAt) {
    return { loggedIn: true, profile: loginCache.profile }
  }

  try {
    const profile = await fetchProfile(auth.cookie)
    pluginContext?.logger?.info('Qishui login session accepted')
    loginCache = {
      cookie: auth.cookie,
      profile,
      expiresAt: Date.now() + 60_000
    }
    return { loggedIn: true, profile }
  } catch (error) {
    pluginContext?.logger?.warn(`Qishui login check failed: ${error?.message || String(error)}`)
    loginCache = null
    return { loggedIn: false, profile: auth.profile || null }
  }
}

async function getProfile() {
  return (await checkLogin()).profile
}

async function logout() {
  if (qishuiAuthApi?.clear) await qishuiAuthApi.clear().catch(() => undefined)
  qrSession = null
  qrCookie = ''
  loginCache = null
  playlistCache.clear()
  playlistTypes.clear()
  await requireContext().settings.delete(AUTH_KEY)
}

async function getQrLogin() {
  qrSession = null
  qrCookie = ''

  if (qishuiAuthApi?.getQrLogin) {
    const login = await qishuiAuthApi.getQrLogin()
    const token = String(login?.key || '').trim()
    const qrContent = String(login?.qrContent || '').trim()
    const imageDataUrl = String(login?.imageDataUrl || '').trim()
    if (!token || (!qrContent && !/^data:image\//i.test(imageDataUrl))) {
      throw new Error('汽水音乐没有返回有效二维码')
    }
    const expiresInSeconds = Math.max(
      1,
      Number(login?.expiresInSeconds) > 0 ? Math.floor(Number(login.expiresInSeconds)) : 180
    )
    qrSession = {
      token,
      qrContent,
      imageDataUrl,
      secure: true,
      lastStatus: 'new',
      expiresAt: Date.now() + expiresInSeconds * 1000
    }
    pluginContext?.logger?.debug(
      'Qishui secure QR created: hasScanUrl=' +
        Boolean(qrContent) +
        ' hasImage=' +
        Boolean(imageDataUrl)
    )
    return {
      key: token,
      ...(qrContent ? { qrContent } : {}),
      ...(imageDataUrl ? { imageDataUrl } : {}),
      expiresInSeconds
    }
  }

  const response = await passportGet('/passport/web/get_qrcode/', {
    ...PASSPORT,
    is_new_login: '1'
  })

  const data =
    response.json?.data && typeof response.json.data === 'object'
      ? response.json.data
      : response.json || {}

  const token = String(data.token || '').trim()
  const rawQr = String(data.qrcode || '').trim()
  const indexUrl = String(data.qrcode_index_url || '').trim()

  if (!token || !rawQr) throw new Error('汽水音乐没有返回有效二维码')

  qrCookie = mergeCookies('', response.cookie || '')
  qrSession = {
    token,
    qrContent: indexUrl ? officialScanUrl(indexUrl) : rawQr,
    lastStatus: 'new',
    expiresAt:
      Date.now() +
      Math.min(QR_TTL_MS, Math.max(10_000, Number(data.expire_time || 0) * 1000 || QR_TTL_MS))
  }

  pluginContext?.logger?.debug(
    'Qishui QR created: hasIndexUrl=' +
      Boolean(indexUrl) +
      ' hasBootstrapCookie=' +
      Boolean(qrCookie)
  )

  // Current Twilight Echo renders qrContent itself. Do not reinterpret
  // qishui's QR payload as PNG base64.
  return {
    key: token,
    qrContent: qrSession.qrContent,
    expiresInSeconds: Math.max(1, Math.floor((qrSession.expiresAt - Date.now()) / 1000))
  }
}

async function getQrImage(key) {
  const session = qrSession && qrSession.token === key ? qrSession : null
  return session?.imageDataUrl || session?.qrContent || null
}

async function checkQrLogin(key) {
  if (!qrSession || key !== qrSession.token) {
    return { code: 65, message: '二维码不存在或已过期' }
  }
  if (Date.now() >= qrSession.expiresAt) {
    qrSession = null
    qrCookie = ''
    return { code: 65, message: '二维码已过期' }
  }

  let response
  try {
    if (qrSession.secure && qishuiAuthApi?.checkQrLogin) {
      const secureResponse = await qishuiAuthApi.checkQrLogin(key)
      response = {
        json: secureResponse?.json || {},
        headers: {},
        cookie: typeof secureResponse?.cookie === 'string' ? secureResponse.cookie : ''
      }
    } else {
      response = await passportForm(
        '/passport/web/check_qrconnect/',
        { iid: PC_INSTALL_ID },
        {
          need_logo: PASSPORT.need_logo,
          need_short_url: PASSPORT.need_short_url,
          is_frontier: PASSPORT.is_frontier,
          token: key,
          is_new_login: PASSPORT.is_new_login,
          next: PASSPORT.next
        },
        qrCookie
      )
    }
  } catch (error) {
    pluginContext?.logger?.warn('Qishui QR poll failed: ' + (error?.message || String(error)))
    throw error
  }

  const data =
    response.json?.data && typeof response.json.data === 'object'
      ? response.json.data
      : response.json || {}

  const status = String(data.status ?? data.qr_status ?? response.json?.status ?? '').toLowerCase()
  if (status) qrSession.lastStatus = status
  const effectiveStatus = status || qrSession.lastStatus
  qrCookie = mergeCookies(qrCookie, response.cookie || '')
  const cookieSession = extractLoginCookie(qrCookie)
  const responseSession = extractSessionIdFromResponse(response.json, data)
  const errorCode = extractQrErrorCode(response.json, data)
  const errorDescription = extractQrErrorDescription(response.json, data)
  pluginContext?.logger?.debug(
    'Qishui QR poll: status=' +
      (effectiveStatus || 'empty') +
      ' errorCode=' +
      String(errorCode || 'none') +
      (errorDescription ? ' description=' + errorDescription : '') +
      ' responseCookie=' +
      Boolean(response.cookie) +
      ' cookieSession=' +
      Boolean(cookieSession) +
      ' bodySession=' +
      Boolean(responseSession)
  )
  const loginCookie = cookieSession || responseSession

  if (loginCookie) {
    const cookie = mergeCookies(qrCookie, loginCookie)
    let profile = null
    try {
      profile = await fetchProfile(cookie)
    } catch {}

    await requireContext().settings.set(AUTH_KEY, {
      cookie,
      profile,
      savedAt: Date.now()
    })
    loginCache = {
      cookie,
      profile,
      expiresAt: Date.now() + 60_000
    }
    qrSession = null
    qrCookie = ''
    return { code: 0, message: '登录成功' }
  }

  if (['1', 'scanned', 'scaned'].includes(effectiveStatus)) {
    return { code: 67, message: '已扫码，请在手机上确认登录' }
  }

  if (['3', 'confirmed', 'confirm', 'success', 'login'].includes(effectiveStatus)) {
    return { code: 67, message: '已确认，正在获取登录状态' }
  }

  if (['-1', 'expired', 'timeout'].includes(effectiveStatus) || errorCode === 10001) {
    qrSession = null
    qrCookie = ''
    return { code: 65, message: '二维码已过期' }
  }

  if (
    errorCode === 1049 &&
    ['1', 'scanned', 'scaned', '3', 'confirmed', 'confirm', 'success', 'login'].includes(
      qrSession.lastStatus
    )
  ) {
    return { code: 67, message: '已扫码，请在手机上确认登录' }
  }

  return { code: 66, message: '等待扫描二维码' }
}

async function fetchProfile(cookie) {
  const response = await pcGet('/luna/pc/me', { aid: AID }, cookie)
  const body = response.json || {}
  const u =
    body.my_info ||
    body.user ||
    body.user_info ||
    body.data?.user ||
    body.data?.user_info ||
    body.profile ||
    body.data?.profile ||
    {}
  return {
    userId: String(u.id || u.user_id || u.uid || '').trim(),
    nickname: String(u.nickname || u.name || u.nick_name || '汽水用户').trim(),
    avatarUrl: imageUrl(u.avatar_url || u.medium_avatar_url || u.avatar || u.avatar_thumb || ''),
    vip: Boolean(u.vip || u.is_vip || u.vip_info)
  }
}

async function fetchUserLibrary() {
  const auth = await requireAuth()
  const response = await pcGet(
    '/luna/pc/me/playlist',
    {
      aid: AID,
      iid: PC_INSTALL_ID,
      version_code: VERSION_CODE
    },
    auth.cookie
  )

  const body = response.json || {}
  const raw = Array.isArray(body.playlists)
    ? body.playlists
    : Array.isArray(body.data?.playlists)
      ? body.data.playlists
      : Array.isArray(body.items)
        ? body.items
        : []

  const playlists = raw.map(mapPlaylist).filter(Boolean)
  for (const item of raw) playlistTypes.set(extractId(item.id), Number(item.type) || 0)

  return {
    playlists,
    likedPlaylist:
      playlists.find((p) => /我喜欢|喜欢的|收藏的歌曲|liked|favorite/i.test(p.name)) || null
  }
}

async function searchSongs(keywords, limit = 30, offset = 0) {
  return searchItems('/luna/search/track', keywords, limit, offset, collectTracks)
}

async function searchPlaylists(keywords, limit = 30, offset = 0) {
  return searchItems('/luna/search/playlist', keywords, limit, offset, (payload) =>
    firstArray(
      payload.playlists,
      payload.data?.playlists,
      payload.result?.playlists,
      payload.items,
      payload.result_groups?.flatMap((group) => firstArray(group.data, group.items))
    )
      .map(mapPlaylist)
      .filter(Boolean)
  )
}

async function searchItems(path, keywords, limit, offset, mapItems) {
  const q = String(keywords || '').trim()
  if (!q) return { items: [], total: 0 }
  const auth = await readAuth()
  const items = []
  let cursor = Math.max(0, Number(offset) || 0)
  let total = 0
  while (items.length < limit) {
    const { json } = await pcGet(
      path,
      searchParams(q, cursor, limit - items.length),
      auth?.cookie || ''
    )
    const page = mapItems(json)
    items.push(...page.slice(0, limit - items.length))
    total = searchTotal(json, page.length, cursor)
    const next = Number(json.result_groups?.[0]?.next_cursor)
    if (
      !json.result_groups?.[0]?.has_more ||
      !page.length ||
      !Number.isFinite(next) ||
      next <= cursor
    )
      break
    cursor = next
  }
  return { items, total }
}

async function fetchPlaylistTracks(playlistId, force = false) {
  const id = extractId(playlistId)
  if (!id) return []

  const cached = playlistCache.get(id)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.items

  const auth = await readAuth()
  const tracks = []
  let cursor = ''
  do {
    const response = await appPost(
      '/luna/playlist/detail',
      {
        playlist_id: id,
        playlist_type: playlistTypes.get(id) || 0,
        count: 100,
        cursor
      },
      auth?.cookie || ''
    )

    const body = response.json || {}
    const raw = firstArray(
      body.media_resources,
      body.tracks,
      body.songs,
      body.items,
      body.data?.media_resources,
      body.data?.tracks,
      body.data?.songs
    )
    tracks.push(...raw.map(mapFeedTrack).filter(Boolean))
    const next = String(body.next_cursor || '')
    if (!body.has_more || !next || next === cursor) break
    cursor = next
  } while (cursor)

  playlistCache.set(id, {
    items: tracks,
    expiresAt: Date.now() + PLAYLIST_TTL_MS
  })
  return tracks
}

async function getPlaybackUrl(track) {
  const id = trackId(track)
  if (!id) return null

  const auth = await requireAuth()
  return resolvePlaybackUrl(id, pcHeaders(auth.cookie), requestJson, pluginContext?.logger)
}

async function getLyrics(track) {
  const id = trackId(track)
  if (!id) return { lyrics: null, translatedLyrics: null, wordLyrics: null }

  const response = await lunaGet(
    '/luna/h5/seo_track',
    {
      track_id: id,
      device_platform: 'web'
    },
    ''
  )

  const body = response.json || {}
  const content = String(
    body.lyric?.content || body.lyrics || body.data?.lyric?.content || ''
  ).trim()

  return {
    lyrics: content || null,
    translatedLyrics: null,
    wordLyrics: null
  }
}

function mapPlaylist(value) {
  if (!value || typeof value !== 'object') return null
  value = value.entity?.playlist || value.playlist || value
  const id = extractId(value.id || value.playlist_id || value.playlistId)
  if (!id) return null
  if (value.type !== undefined) playlistTypes.set(id, Number(value.type) || 0)

  return {
    id,
    name: String(value.name || value.title || value.playlist_name || '未命名歌单').trim(),
    cover: imageUrl(value.cover_url || value.cover || value.url_cover || value.cover_image),
    trackCount:
      Number(
        value.count_tracks ||
          value.track_count ||
          value.stats?.count_track ||
          value.resource_cnt?.track_count ||
          value.resource_cnt?.track_cnt ||
          value.song_count ||
          value.count ||
          0
      ) || 0,
    creatorName: String(
      value.creator_name ||
        value.owner?.nickname ||
        value.creator?.name ||
        value.creator?.nickname ||
        ''
    ).trim(),
    owned: true
  }
}

function collectTracks(body) {
  const arrays = [
    body.tracks,
    body.songs,
    body.items,
    body.data?.tracks,
    body.data?.songs,
    body.data?.items
  ]
  for (const arr of arrays) {
    if (Array.isArray(arr)) return arr.map(mapTrack).filter(Boolean)
  }

  const groups = firstArray(
    body.result_groups,
    body.groups,
    body.data?.result_groups,
    body.data?.groups
  )
  if (groups.length) {
    return groups.flatMap((g) =>
      firstArray(g.data, g.items, g.tracks).map(mapTrack).filter(Boolean)
    )
  }
  return []
}

function mapTrack(value) {
  if (!value || typeof value !== 'object') return null
  const t =
    value.track || value.entity?.track_wrapper?.track || value.entity?.track || value.song || value
  const id = extractId(t.id || t.track_id || t.media_id || value.id || value.track_id)
  if (!id) return null

  const artistsRaw = firstArray(t.artists, t.artist, t.authors, value.artists)
  const artists = artistsRaw
    .map((a) => ({
      id: String(a?.id || a?.user_id || a?.uid || '').trim(),
      name: String(a?.name || a?.nickname || a?.user_info?.nickname || '').trim()
    }))
    .filter((a) => a.name)

  const title = String(t.name || t.track_name || t.trackName || value.name || '未知歌曲').trim()
  const album = String(t.album?.name || t.album_name || value.album_name || '').trim()
  const cover = imageUrl(
    t.cover_url ||
      t.url_cover ||
      t.album?.cover_url ||
      t.album?.url_cover ||
      value.cover_url ||
      value.cover
  )

  return {
    id: `qishui:${id}`,
    title,
    artist: artists.map((a) => a.name).join(' / ') || '未知艺术家',
    artists,
    album,
    filePath: `qishui:${id}`,
    fileName: `${title}.mp3`,
    duration: normalizeDuration(t.duration || t.duration_ms || value.duration),
    size: 0,
    cover,
    lyrics: null,
    translatedLyrics: null,
    source: 'qishui',
    streamUrl: null,
    providerSongId: id,
    providerMediaId: id
  }
}

function mapFeedTrack(value) {
  const candidate =
    value?.track ||
    value?.entity?.track ||
    value?.entity?.track_wrapper?.track ||
    value?.song ||
    value
  return mapTrack(candidate)
}

function trackId(track) {
  return extractId(track?.providerSongId || track?.providerMediaId || track?.id || '').replace(
    /^qishui:/,
    ''
  )
}

function extractId(value) {
  return String(value || '')
    .replace(/^qishui:/, '')
    .replace(/[^0-9A-Za-z_-]/g, '')
    .trim()
}

function normalizeDuration(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 10000 ? Math.round(n / 1000) : Math.round(n)
}

function searchTotal(body, count, offset) {
  const total = Number(body?.total ?? body?.total_num)
  if (Number.isFinite(total)) return total
  const hasMore = body?.result_groups?.some((group) => group.has_more)
  return Math.max(0, Number(offset) || 0) + count + (hasMore ? 1 : 0)
}

function appParams() {
  return {
    aid: AID,
    app_name: 'luna',
    device_platform: 'android',
    os: 'android',
    version_code: '100198030',
    version_name: '19.8.0',
    device_id: PC_DEVICE_ID,
    iid: PC_INSTALL_ID
  }
}

function searchParams(q, offset, limit) {
  const cursor = Math.max(0, Number(offset) || 0)
  return {
    ...appParams(),
    q,
    cursor,
    count: limit,
    search_id: '',
    search_method: 'input',
    debug_params: '',
    from_search_id: '',
    search_scene: ''
  }
}

function randomDigits(length) {
  let value = String(1 + (randomBytes(1)[0] % 8))
  while (value.length < length) value += String(randomBytes(1)[0] % 10)
  return value
}

async function requireAuth() {
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('汽水音乐未登录，请先扫码登录')
  return auth
}

async function readAuth() {
  return await requireContext().settings.get(AUTH_KEY)
}

function requireContext() {
  if (!pluginContext) throw new Error('汽水音乐插件尚未激活')
  return pluginContext
}

async function pcGet(path, query, cookie) {
  return requestJson(buildUrl(PC_HOST, path, query), {
    method: 'GET',
    headers: pcHeaders(cookie)
  })
}

async function lunaGet(path, query, cookie) {
  return requestJson(buildUrl(LUNA_HOST, path, query), {
    method: 'GET',
    headers: webHeaders(cookie)
  })
}

async function appPost(path, body, cookie) {
  return requestJson(buildUrl(PC_HOST, path, appParams()), {
    method: 'POST',
    headers: appHeaders(cookie),
    body: JSON.stringify(body)
  })
}

async function passportGet(path, query) {
  const params = passportParams(query)
  return requestJson(buildUrl(PC_HOST, path, params), {
    method: 'GET',
    headers: passportHeaders('', params.biz_trace_id)
  })
}

async function passportForm(path, query, form, cookie) {
  const params = passportParams(query)
  const body = new URLSearchParams(form).toString()
  const headers = passportHeaders(cookie, params.biz_trace_id, body)
  try {
    return await requestJson(buildUrl(PC_HOST, path, params), {
      method: 'POST',
      headers,
      body
    })
  } catch (postError) {
    const getParams = { ...params, ...form }
    const response = await requestJson(buildUrl(PC_HOST, path, getParams), {
      method: 'GET',
      headers: passportHeaders(cookie, params.biz_trace_id)
    })
    response.postError = postError?.message || String(postError)
    return response
  }
}

function passportParams(extra = {}) {
  return {
    ...PASSPORT,
    biz_trace_id: randomBytes(4).toString('hex'),
    device_id: PC_DEVICE_ID,
    install_id: PC_INSTALL_ID,
    did: PC_DEVICE_ID,
    iid: PC_INSTALL_ID,
    ...extra
  }
}

function passportHeaders(cookie, bizTraceId, body = '') {
  const traceId = randomBytes(16).toString('hex')
  const headers = {
    ...webHeaders(cookie),
    Accept: 'application/json, text/javascript',
    Referer: 'app://resources/',
    'sec-ch-ua': '"Not.A/Brand";v="99", "Chromium";v="136"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'bd-ticket-guard-version': '2',
    'bd-ticket-guard-iteration-version': '2',
    'bd-ticket-guard-ree-public-key':
      'BAnIxKL96Jby5x+Um9i7HZ2c8O6lfZJRxm6yk73Mqcr06l2qIw2iqu2Mtm3U/6OI98usukA9dqxUlsctVWK9rKA=',
    'bd-ticket-guard-server-cert-sn': '0',
    'X-Tt-Passport-Trace-Id': bizTraceId,
    'X-Tt-Trace-Id': `00-${traceId}-${traceId.slice(0, 16)}-01`,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
  const csrf = passportCsrfToken(cookie)
  if (csrf) headers['X-Tt-Passport-Csrf-Token'] = csrf
  if (body) headers['X-Ss-Stub'] = createHash('md5').update(body).digest('hex').toUpperCase()
  return headers
}

function pcHeaders(cookie) {
  return {
    'User-Agent': PC_UA,
    'Content-Type': 'application/json; charset=utf-8',
    ...(cookie ? { Cookie: cookie } : {})
  }
}

function webHeaders(cookie) {
  return {
    'User-Agent': WEB_UA,
    ...(cookie ? { Cookie: cookie } : {})
  }
}

function passportCsrfToken(cookie) {
  const cookies = new Map()
  for (const piece of String(cookie || '').split(';')) {
    const index = piece.indexOf('=')
    if (index <= 0) continue
    cookies.set(piece.slice(0, index).trim().toLowerCase(), piece.slice(index + 1).trim())
  }
  return cookies.get('passport_csrf_token') || cookies.get('passport_csrf_token_default') || ''
}

function appHeaders(cookie) {
  return {
    'User-Agent': APP_UA,
    'Content-Type': 'application/json; charset=utf-8',
    ...(cookie ? { Cookie: cookie } : {})
  }
}

function buildUrl(origin, path, params = {}) {
  const url = new URL(path, origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function requestJson(input, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(input, {
      ...options,
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`汽水音乐上游 HTTP ${response.status}`)

    const headers = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    let text = await response.text()
    text = String(text || '')
      .replace(/^\uFEFF/, '')
      .trim()
    if (!text) throw new Error('汽水音乐上游返回空响应，请更新插件或稍后重试')

    let json
    try {
      json = JSON.parse(text)
    } catch {
      const match = text.match(/^[^(]+\((.*)\);?$/s)
      if (!match) throw new Error('汽水音乐返回了非 JSON 数据')
      json = JSON.parse(match[1])
    }
    if (!new URL(input).pathname.startsWith('/passport/') && Number(json.status_code)) {
      throw new Error(
        `汽水音乐上游错误 ${json.status_code}：${json.status_info?.status_msg || json.status_msg || '请求失败'}`
      )
    }

    return {
      json,
      headers,
      cookie: cookieHeaderFromHeaders(response.headers)
    }
  } finally {
    clearTimeout(timer)
  }
}

function cookieHeaderFromHeaders(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  if (Array.isArray(raw) && raw.length) {
    return raw
      .map((c) => String(c).split(';')[0].trim())
      .filter(Boolean)
      .join('; ')
  }
  const single = headers.get('set-cookie') || ''
  return single
    ? String(single)
        .split(',')
        .map((c) => String(c).split(';')[0].trim())
        .filter(Boolean)
        .join('; ')
    : ''
}

function mergeCookies(existing, incoming) {
  const map = new Map()
  for (const source of [existing, incoming]) {
    for (const piece of String(source || '').split(';')) {
      const item = piece.trim()
      const index = item.indexOf('=')
      if (index <= 0) continue
      map.set(item.slice(0, index).trim().toLowerCase(), item)
    }
  }
  return [...map.values()].join('; ')
}

function officialScanUrl(indexUrl) {
  try {
    const source = new URL(String(indexUrl || ''))
    const token = source.searchParams.get('token')
    if (!token) return indexUrl

    const target = new URL('https://bff-pc.qishui.com/light/invoke/scan_login')
    target.searchParams.set('token', token)
    target.searchParams.set('os', 'Windows')
    target.searchParams.set('computer_name', COMPUTER_NAME)
    return target.toString().replace(/\+/g, '%20')
  } catch {
    return indexUrl
  }
}

function extractSessionIdFromResponse(json, data) {
  const directValues = [
    ['sessionid', data?.sessionid],
    ['sessionid', data?.session_id],
    ['sessionid', data?.sessionId],
    ['sessionid_ss', data?.sessionid_ss],
    ['sessionid_ss', data?.sessionIdSs],
    ['sid_guard', data?.sid_guard],
    ['sid_tt', data?.sid_tt],
    ['uid_tt', data?.uid_tt],
    ['uid_tt_ss', data?.uid_tt_ss],
    ['sessionid', data?.auth?.sessionid],
    ['sessionid', data?.auth?.session_id],
    ['sessionid', data?.auth?.sessionId],
    ['sessionid_ss', data?.auth?.sessionid_ss],
    ['sid_guard', data?.auth?.sid_guard],
    ['sid_tt', data?.auth?.sid_tt],
    ['sessionid', json?.sessionid],
    ['sessionid', json?.session_id],
    ['sessionid', json?.sessionId],
    ['sessionid_ss', json?.sessionid_ss],
    ['sid_guard', json?.sid_guard],
    ['sid_tt', json?.sid_tt],
    ['uid_tt', json?.uid_tt],
    ['uid_tt_ss', json?.uid_tt_ss],
    ['sessionid', json?.auth?.sessionid],
    ['sessionid', json?.auth?.session_id],
    ['sessionid', json?.auth?.sessionId],
    ['sessionid_ss', json?.auth?.sessionid_ss],
    ['sid_guard', json?.auth?.sid_guard],
    ['sid_tt', json?.auth?.sid_tt]
  ]

  for (const [name, value] of directValues) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (!text) continue
    return extractLoginCookie(text) || `${name}=${text}`
  }

  const cookieValues = [
    data?.session_cookie,
    data?.sessionCookie,
    data?.cookie,
    data?.auth?.session_cookie,
    data?.auth?.sessionCookie,
    data?.auth?.cookie,
    data?.session?.session_cookie,
    data?.session?.sessionCookie,
    data?.session?.cookie,
    json?.session_cookie,
    json?.sessionCookie,
    json?.cookie,
    json?.auth?.session_cookie,
    json?.auth?.sessionCookie,
    json?.auth?.cookie,
    json?.session?.session_cookie,
    json?.session?.sessionCookie,
    json?.session?.cookie
  ]

  for (const value of cookieValues) {
    const cookie = extractSessionCookieValue(value)
    if (cookie) return cookie
  }

  return ''
}

function extractLoginCookie(value) {
  const text = String(value || '')
  const match = text.match(
    /(?:^|[;,\r\n]\s*)(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=([^;,\r\n]+)/i
  )
  return match ? `${match[1]}=${match[2].trim()}` : ''
}

function extractSessionCookieValue(value) {
  const cookie = extractLoginCookie(value)
  if (cookie) return cookie
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return /^[^\s;,\r\n]{8,}$/.test(text) ? `sessionid=${text}` : ''
}

function extractQrErrorDescription(json, data) {
  const value = data?.description ?? data?.status_msg ?? json?.description ?? json?.status_msg ?? ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 120)
}

function extractQrErrorCode(json, data) {
  const raw =
    data?.error_code ??
    data?.errorCode ??
    data?.err_code ??
    data?.errCode ??
    json?.error_code ??
    json?.errorCode ??
    json?.err_code ??
    json?.errCode ??
    0
  const code = Number(raw)
  return Number.isFinite(code) ? code : 0
}

function firstArray(...values) {
  for (const v of values) if (Array.isArray(v)) return v
  return []
}
