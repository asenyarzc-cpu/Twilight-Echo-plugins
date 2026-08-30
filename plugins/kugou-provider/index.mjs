import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const PROVIDER_ID = 'kugou'
const SETTINGS_COMMAND = 'kugou.settings'
const CONSENT_KEY = 'consent'
const CONFIG_KEY = 'apiConfig'
const DEVICE_KEY = 'device'
const AUTH_KEY = 'auth'
const CONSENT_VERSION = 'kugoumusic-v1'
const KUGOU_PLATFORM = 'lite'
const CONFIG_SCHEMA_VERSION = 2
const EMBEDDED_HOST = '127.0.0.1'
const LEGACY_DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000'
const REQUEST_TIMEOUT_MS = 12000
const STREAM_HEADER_TIMEOUT_MS = 15000
const QR_TTL_MS = 3 * 60 * 1000
const STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const MAX_STREAM_TOKENS = 512
const MAX_PAGE_SIZE = 50
const AUTH_VALIDATION_TTL_MS = 5 * 60 * 1000

let pluginContext = null
let proxyServer = null
let proxyPort = 0
let proxyServerStart = null
let authCacheEpoch = Date.now()
let freshRequestCounter = 0
let embeddedService = null
let validatedAuth = null

function bumpAuthCacheEpoch() {
  authCacheEpoch = Math.max(Date.now(), authCacheEpoch + 1)
  validatedAuth = null
  return authCacheEpoch
}
let embeddedServiceStart = null
let vendorLoader = loadVendorBundle

// 单测接缝：替换内嵌 bundle 的加载方式，避免单元测试真实拉起服务；传空恢复默认。
export function _setVendorLoaderForTests(loader) {
  vendorLoader = typeof loader === 'function' ? loader : loadVendorBundle
}

async function loadVendorBundle() {
  const mod = await import('./vendor/kugouApi.vendor.cjs')
  const api = mod.createKugouApiServer || mod.default?.createKugouApiServer
  if (typeof api !== 'function') throw new Error('酷狗内嵌服务 bundle 无效，请重新构建插件')
  return { createKugouApiServer: api }
}

async function ensureEmbeddedService() {
  if (embeddedService) return embeddedService
  if (embeddedServiceStart) return embeddedServiceStart
  embeddedServiceStart = (async () => {
    await applyDeviceIdentity()
    const { createKugouApiServer } = await vendorLoader()
    const app = await createKugouApiServer({ host: EMBEDDED_HOST, port: 0 })
    const address = app?.service?.address?.()
    const port = address && typeof address === 'object' ? Number(address.port) : 0
    if (!port) throw new Error('酷狗内嵌服务启动失败')
    embeddedService = { app, port }
    return embeddedService
  })()
  try {
    return await embeddedServiceStart
  } catch (error) {
    embeddedService = null
    embeddedServiceStart = null
    throw error
  }
}

async function stopEmbeddedService() {
  const service = embeddedService
  embeddedService = null
  embeddedServiceStart = null
  if (!service) return
  try {
    service.app?.service?.closeAllConnections?.()
  } catch {
    // 关闭连接失败不影响后续 close
  }
  await new Promise((resolve) => {
    try {
      service.app?.service?.close?.(() => resolve())
      if (!service.app?.service) resolve()
    } catch {
      resolve()
    }
  })
}

// 设备标识只生成一次并持久化，再注入上游要求的环境变量；
// 内嵌 bundle 的 dotenv 不会覆盖已设置的环境变量。
async function applyDeviceIdentity() {
  const device = await readDevice()
  const next = { ...device }
  if (!next.guid) next.guid = randomUUID()
  if (!next.dev) next.dev = randomBytes(5).toString('hex').slice(0, 10).padEnd(10, 'k')
  if (!next.mac) {
    next.mac = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0')
    ).join(':')
  }
  if (next.guid !== device.guid || next.dev !== device.dev || next.mac !== device.mac) {
    await requireContext().settings.set(DEVICE_KEY, next)
  }
  process.env.KUGOU_API_GUID = next.guid
  process.env.KUGOU_API_DEV = next.dev
  process.env.KUGOU_API_MAC = next.mac
  process.env.KUGOU_API_PLATFORM = KUGOU_PLATFORM
}

const qrSessions = new Map()
const streamTokens = new Map()

const CONSENT_ERROR =
  '首次使用酷狗音乐音源前，请在“设置 → 插件设置 → 酷狗音乐音源”阅读并确认免责声明。'

export async function activate(context) {
  pluginContext = context
  await migrateLegacyConfig()
  context.logger.info('Registering KuGou Music provider')

  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: '酷狗音乐',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-headphones',
      color: '#f29c1f',
      description: '内置 KuGouMusicApi 服务，随应用启动，开箱即用',
      authType: 'qr',
      loginInstructions: '请先确认免责声明；公开搜索无需登录，播放和访问个人歌单前请扫码',
      qrStatusCodes: { waiting: 1, scanned: 2, expired: 0, success: 4 },
      streamingLibraryTab: true,
      streamingSearch: true,
      unifiedLibrary: true
    },
    searchSongs,
    searchPlaylists,
    searchArtists,
    getPlaybackUrl,
    getLyrics,
    fetchPlaylistTracks,
    fetchUserLibrary,
    isTrackLiked,
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    checkQrLogin
  })

  await context.twilight.ui.register({
    id: 'kugou-settings',
    kind: 'settingsPanel',
    title: '酷狗音乐音源',
    description: '确认免责声明并配置本机 KuGouMusicApi 服务',
    command: SETTINGS_COMMAND
  })
  context.twilight.ui.onCommand(SETTINGS_COMMAND, settingsCommand)
}

export async function deactivate() {
  qrSessions.clear()
  streamTokens.clear()
  if (proxyServer) {
    proxyServer.closeAllConnections?.()
    await new Promise((resolve) => proxyServer.close(resolve))
    proxyServer = null
    proxyPort = 0
  }
  proxyServerStart = null
  await stopEmbeddedService()
  authCacheEpoch = Date.now()
  validatedAuth = null
  pluginContext = null
}

async function settingsCommand(value) {
  if (value && typeof value === 'object' && value.source === 'settingsPanel') {
    return createSettingsForm()
  }
  return saveSettings(value)
}

async function createSettingsForm() {
  const consent = await hasConsent()
  const config = await readConfig()
  return {
    kind: 'settings-form',
    submitCommand: SETTINGS_COMMAND,
    notice: [
      '免责声明：本插件仅供个人学习与研究使用，与酷狗音乐没有隶属关系。',
      '服务已内置于插件（仅监听本机回环地址，随应用启动/退出）；高级用户可改为连接本机已部署的 KuGouMusicApi 地址，禁止配置公共 API 或第三方代理。',
      '不会提供下载、VIP 绕过或访问限制绕过。用户必须自行遵守适用法律、酷狗音乐服务条款与版权要求。请勿在日志、截图或 Issue 中粘贴 token、userid、dfid、Cookie 或二维码 key。'
    ].join('\n'),
    fields: [
      {
        key: 'apiBaseUrl',
        label: '外部本机 API 地址（可选，高级）',
        type: 'url',
        required: false,
        placeholder: '留空使用插件内置服务',
        value: config.externalBaseUrl,
        options: []
      },
      {
        key: 'disclaimer',
        label: '使用确认',
        type: 'select',
        required: true,
        placeholder: '',
        value: consent ? CONSENT_VERSION : '',
        options: [
          { label: '请选择', value: '' },
          { label: '我已阅读并同意免责声明', value: CONSENT_VERSION }
        ]
      }
    ]
  }
}

async function saveSettings(values) {
  const accepted = values && typeof values === 'object' && values.disclaimer === CONSENT_VERSION
  if (!accepted) throw new Error('请先选择“我已阅读并同意免责声明”')
  const previous = await readConfig()
  const rawExternal = String(values.apiBaseUrl || '').trim()
  const externalBaseUrl = rawExternal ? normalizeAdapterBaseUrl(rawExternal) : ''
  const context = requireContext()
  await context.settings.set(CONSENT_KEY, {
    disclaimerVersion: CONSENT_VERSION,
    acceptedAt: new Date().toISOString()
  })
  await context.settings.set(CONFIG_KEY, {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    externalBaseUrl
  })
  if (previous.externalBaseUrl !== externalBaseUrl) {
    streamTokens.clear()
  }
  return {
    message: externalBaseUrl
      ? '设置已保存：将连接外部本机 KuGouMusicApi 服务。'
      : '设置已保存：使用插件内置服务，随应用自动启动。',
    form: await createSettingsForm()
  }
}

async function searchSongs(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const normalizedKeywords = String(keywords || '').trim()
  if (!normalizedKeywords) return { items: [], total: 0 }
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await publicSearchRequest(
    'song',
    normalizedKeywords,
    page,
    pageSize,
    requestSignal(requestContext)
  )
  const items = extractTrackItems(payload).map(mapKugouTrack).filter(Boolean)
  return { items, total: extractTotal(payload, items.length) }
}

async function searchPlaylists(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const normalizedKeywords = String(keywords || '').trim()
  if (!normalizedKeywords) return { items: [], total: 0 }
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await publicSearchRequest(
    'special',
    normalizedKeywords,
    page,
    pageSize,
    requestSignal(requestContext)
  )
  const items = extractPlaylistItems(payload).map(mapKugouPlaylist).filter(Boolean)
  return { items, total: extractTotal(payload, items.length) }
}

async function searchArtists(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const normalizedKeywords = String(keywords || '').trim()
  if (!normalizedKeywords) return { items: [], total: 0 }
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await publicSearchRequest(
    'singer',
    normalizedKeywords,
    page,
    pageSize,
    requestSignal(requestContext)
  )
  const items = extractArtistItems(payload).map(mapKugouArtist).filter(Boolean)
  return { items, total: extractTotal(payload, items.length) }
}

async function publicSearchRequest(type, keywords, page, pageSize, signal) {
  const songSearch = type === 'song'
  const url = songSearch
    ? new URL('https://songsearch.kugou.com/song_search_v2')
    : new URL('http://msearchcdn.kugou.com/api/v3/search/' + type)
  url.searchParams.set('keyword', keywords)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pagesize', String(pageSize))
  if (songSearch) {
    url.searchParams.set('userid', '0')
    url.searchParams.set('clientver', '20549')
    url.searchParams.set('platform', 'WebFilter')
    url.searchParams.set('tag', 'em')
    url.searchParams.set('filter', '10')
    url.searchParams.set('iscorrection', '1')
    url.searchParams.set('privilege_filter', '0')
  } else {
    url.searchParams.set('plat', '0')
    url.searchParams.set('version', '9108')
    url.searchParams.set('showtype', '0')
  }
  const response = await fetchJsonWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        Referer: 'https://www.kugou.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      signal
    },
    REQUEST_TIMEOUT_MS
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error('酷狗公开搜索接口暂时不可用')
  }
  const errorCode = numberOrNull(payload.error_code, payload.errcode, payload.errorCode)
  if (errorCode != null && errorCode !== 0) {
    throw new Error(safeErrorMessage(payload.error || payload.error_msg || '酷狗搜索失败'))
  }
  return payload
}

async function getPlaybackUrl(track, options = {}, requestContext) {
  await assertConsent()
  await requireAuth()
  await ensureDevice(requestContext)
  const hash = trackHash(track)
  if (!hash) return null
  for (const quality of qualityLadder(options?.quality)) {
    const directUrl = await resolvePlaybackUrl(track, hash, quality, requestContext)
    if (!directUrl) continue
    return createStreamToken({ hash, quality, directUrl })
  }
  return null
}

async function resolvePlaybackUrl(track, hash, quality, requestContext) {
  const payload = await adapterRequest(
    '/song/url',
    {
      hash,
      quality,
      album_id: trackProviderValue(track, 'providerAlbumId'),
      album_audio_id: trackProviderValue(track, 'providerAlbumAudioId')
    },
    { signal: requestSignal(requestContext) }
  )
  assertKugouPlaybackPayload(payload)
  return extractStreamUrl(payload)
}

async function getLyrics(track, requestContext) {
  await assertConsent()
  await ensureDevice(requestContext)
  const hash = trackHash(track)
  if (!hash) return emptyLyrics()
  const candidatePayload = await adapterRequest(
    '/search/lyric',
    {
      hash,
      duration: normalizeDuration(track?.duration),
      man: 'no'
    },
    { signal: requestSignal(requestContext) }
  )
  const candidate = findLyricCandidate(candidatePayload)
  if (!candidate) return emptyLyrics()
  const payload = await adapterRequest(
    '/lyric',
    {
      id: candidate.id,
      accesskey: candidate.accesskey,
      fmt: 'krc',
      decode: true
    },
    { signal: requestSignal(requestContext) }
  )
  const wordLyrics = extractLyricContent(payload)
  if (!wordLyrics) return emptyLyrics()
  return {
    lyrics: krcToLrc(wordLyrics) || wordLyrics,
    translatedLyrics: null,
    wordLyrics
  }
}

async function getQrLogin(requestContext) {
  await assertConsent()
  await ensureDevice(requestContext)
  const keyPayload = await adapterRequest(
    '/login/qr/key',
    {},
    { signal: requestSignal(requestContext), fresh: true }
  )
  const key = extractQrKey(keyPayload)
  if (!key) throw new Error('KuGouMusicApi 未返回二维码 key')
  const imagePayload = await adapterRequest(
    '/login/qr/create',
    { key, qrimg: true },
    { signal: requestSignal(requestContext) }
  )
  const imageDataUrl = extractQrImage(imagePayload)
  if (!imageDataUrl) throw new Error('KuGouMusicApi 未返回二维码图片')
  qrSessions.set(key, { expiresAt: Date.now() + QR_TTL_MS })
  return {
    key,
    qrContent: key,
    imageDataUrl,
    expiresInSeconds: QR_TTL_MS / 1000
  }
}

async function checkQrLogin(key, requestContext) {
  await assertConsent()
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) throw new Error('酷狗二维码 key 无效')
  const session = qrSessions.get(normalizedKey)
  if (!session || session.expiresAt <= Date.now()) {
    qrSessions.delete(normalizedKey)
    return { code: 0, message: '二维码不存在或已过期' }
  }
  const payload = await adapterRequest(
    '/login/qr/check',
    { key: normalizedKey },
    { signal: requestSignal(requestContext), fresh: true }
  )
  const result = extractQrStatus(payload)
  if (result.code === 4) {
    let token = firstString(payload?.data?.token, payload?.token, result.token)
    let userid = firstString(
      payload?.data?.userid,
      payload?.data?.user_id,
      payload?.userid,
      result.userid
    )
    if (!token || !userid) {
      // 上游也可能只通过 Set-Cookie 下发凭证；persistAdapterCookies 已把它们存入设置
      const persisted = await readAuth()
      token = token || persisted?.token || ''
      userid = userid || persisted?.userid || ''
    }
    if (!token || !userid) throw new Error('酷狗登录成功但未返回完整认证信息')
    await requireContext().settings.set(AUTH_KEY, {
      token,
      userid,
      platform: KUGOU_PLATFORM,
      updatedAt: new Date().toISOString()
    })
    let validatedCredentials
    let validatedProfile
    try {
      const profilePayload = await adapterRequest(
        '/user/detail',
        {},
        { signal: requestSignal(requestContext), fresh: true }
      )
      const auth = await requireAuth()
      validatedCredentials = auth
      validatedProfile = mapProfile(profilePayload, auth)
      if (!validatedProfile) throw new Error('酷狗账号接口未返回有效用户资料')
    } catch (error) {
      await requireContext().settings.delete(AUTH_KEY)
      bumpAuthCacheEpoch()
      throw new Error('酷狗登录认证未能通过，请重新扫码：' + safeErrorMessage(error))
    }
    qrSessions.delete(normalizedKey)
    bumpAuthCacheEpoch()
    validatedAuth = {
      token: validatedCredentials.token,
      userid: validatedCredentials.userid,
      profile: validatedProfile,
      expiresAt: Date.now() + AUTH_VALIDATION_TTL_MS
    }
    return { code: 4, message: '登录成功' }
  }
  if (result.code === 0) {
    qrSessions.delete(normalizedKey)
    return { code: 0, message: '二维码已过期' }
  }
  if (result.code === 2) return { code: 2, message: '已扫码，请在手机上确认登录' }
  return { code: 1, message: '等待扫描二维码' }
}

async function checkLogin() {
  if (!(await hasConsent())) return { loggedIn: false, profile: null }
  try {
    const result = await validateAuth()
    return {
      loggedIn: Boolean(result),
      profile: result?.profile || null
    }
  } catch (error) {
    if (isAuthRejection(error)) {
      await requireContext().settings.delete(AUTH_KEY)
      bumpAuthCacheEpoch()
    }
    logWarn('KuGou login validation failed: ' + safeErrorMessage(error))
    return { loggedIn: false, profile: null }
  }
}

async function getProfile(requestContext) {
  await assertConsent()
  const result = await validateAuth(requestContext)
  if (!result) throw new Error('酷狗音乐需要先扫码登录')
  return result.profile
}

async function logout() {
  const context = requireContext()
  await context.settings.delete(AUTH_KEY)
  qrSessions.clear()
  streamTokens.clear()
  bumpAuthCacheEpoch()
}

async function isTrackLiked() {
  return false
}

async function fetchUserLibrary(force = false, requestContext) {
  await assertConsent()
  await requireAuth()
  await ensureDevice(requestContext)
  const payload = await adapterRequest(
    '/user/playlist',
    {
      page: 1,
      pagesize: MAX_PAGE_SIZE,
      timestamp: force ? Date.now() : undefined
    },
    { method: 'POST', signal: requestSignal(requestContext) }
  )
  const playlists = extractPlaylistItems(payload).map(mapKugouPlaylist).filter(Boolean)
  return {
    likedPlaylist:
      playlists.find((playlist) => playlist.owned && /喜欢|收藏/.test(playlist.name)) || null,
    playlists
  }
}

async function fetchPlaylistTracks(playlistId, force = false, requestContext) {
  await assertConsent()
  await ensureDevice(requestContext)
  const id = normalizePlaylistId(playlistId)
  const payload = await adapterRequest(
    '/playlist/track/all',
    {
      id,
      page: 1,
      pagesize: MAX_PAGE_SIZE,
      timestamp: force ? Date.now() : undefined
    },
    { signal: requestSignal(requestContext) }
  )
  return extractTrackItems(payload).map(mapKugouTrack).filter(Boolean)
}

async function ensureDevice(requestContext) {
  const device = await readDevice()
  if (device.dfid) return device
  const payload = await adapterRequest(
    '/register/dev',
    {},
    { method: 'POST', signal: requestSignal(requestContext) }
  )
  const current = await readDevice()
  const dfid = firstString(current.dfid, payload?.data?.dfid, payload?.dfid)
  if (!dfid) throw new Error('KuGouMusicApi 未返回可用的 dfid，请检查本机服务配置')
  const next = { ...current, dfid }
  await requireContext().settings.set(DEVICE_KEY, next)
  return next
}

async function adapterRequest(pathname, params, options = {}) {
  const url = new URL(pathname, await resolveAdapterBaseUrl())
  const method = String(options.method || 'GET').toUpperCase()
  const entries = Object.entries(params || {}).filter(
    ([, value]) => value !== undefined && value !== null
  )
  if (options.fresh) {
    // 轮询类接口必须绕过本机服务的 2 分钟 URL 缓存，否则扫码状态永远停留在旧响应
    freshRequestCounter = (freshRequestCounter + 1) % 0xffffffff
    url.searchParams.set('timestamp', Date.now() + '-' + freshRequestCounter)
  } else if (authCacheEpoch && !('timestamp' in (params || {}))) {
    url.searchParams.set('timestamp', String(authCacheEpoch))
  }
  if (method === 'GET') {
    for (const [key, value] of entries) url.searchParams.set(key, String(value))
  }
  const credentials = await adapterCredentials()
  const headers = { Accept: 'application/json' }
  if (credentials) {
    headers.Authorization = credentials
    // 凭证必须三通道齐发：不同模块读取位置不同 ——
    //  - query 的 cookie 参数：search 等模块（官方文档方式）
    //  - 顶层 token/userid/dfid 参数：user_detail / user_playlist / usercenter、cloudlist 模块
    //  - Authorization 头：服务端通用兜底
    // 只走 Authorization 会在 usercenter 报 20018、cloudlist 报 20010
    url.searchParams.set('cookie', credentials)
    for (const [name, value] of splitCookiePairs(credentials)) {
      if (name === 'token' || name === 'userid' || name === 'dfid') {
        url.searchParams.set(name, value)
      }
    }
  }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetchJsonWithTimeout(
    url,
    {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(Object.fromEntries(entries)),
      signal: options.signal
    },
    REQUEST_TIMEOUT_MS
  )
  await persistAdapterCookies(response.headers)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    // 上游错误（如未登录搜索的 152）会以非 2xx 状态返回标准错误体，仍走统一翻译
    if (payload && typeof payload === 'object') assertAdapterSuccess(payload)
    throw new Error('本机 KuGouMusicApi HTTP ' + response.status)
  }
  if (!payload) {
    throw new Error('本机 KuGouMusicApi 返回了无效 JSON')
  }
  assertAdapterSuccess(payload)
  return payload
}

async function adapterCredentials() {
  const [device, auth] = await Promise.all([readDevice(), readAuth()])
  const values = {
    ...device.cookies,
    ...(device.dfid ? { dfid: device.dfid } : {}),
    ...(auth ? { token: auth.token, userid: auth.userid } : {})
  }
  return cookieHeader(values)
}

async function persistAdapterCookies(headers) {
  const cookies = parseSetCookieHeader(headers)
  if (Object.keys(cookies).length === 0) return
  const device = await readDevice()
  const auth = await readAuth()
  const deviceCookies = { ...device.cookies }
  let dfid = device.dfid
  let nextAuth = auth ? { ...auth } : null
  for (const [name, value] of Object.entries(cookies)) {
    if (/^KUGOU_API_/i.test(name)) deviceCookies[name] = value
    if (name.toLowerCase() === 'dfid') dfid = value
    if (name === 'token' || name === 'userid') {
      // token 与 userid 可能同帧到达，必须累积合并而不是互相覆盖
      nextAuth = {
        ...(nextAuth || {}),
        token: name === 'token' ? value : nextAuth?.token || '',
        userid: name === 'userid' ? value : nextAuth?.userid || '',
        updatedAt: new Date().toISOString()
      }
    }
  }
  if (dfid !== device.dfid || JSON.stringify(deviceCookies) !== JSON.stringify(device.cookies)) {
    await requireContext().settings.set(DEVICE_KEY, {
      ...device,
      dfid,
      cookies: deviceCookies
    })
  }
  if (nextAuth?.token && nextAuth?.userid) {
    await requireContext().settings.set(AUTH_KEY, {
      ...nextAuth,
      platform: KUGOU_PLATFORM
    })
  }
}

async function readConfig() {
  const raw = await requireContext().settings.get(CONFIG_KEY)
  const externalRaw = raw && typeof raw === 'object' ? raw.externalBaseUrl : ''
  const externalBaseUrl =
    typeof externalRaw === 'string' && externalRaw.trim()
      ? normalizeAdapterBaseUrl(externalRaw)
      : ''
  const schemaVersion = numberOrNull(raw?.schemaVersion) ?? 0
  if (schemaVersion < CONFIG_SCHEMA_VERSION && externalBaseUrl === LEGACY_DEFAULT_API_BASE_URL) {
    return { externalBaseUrl: '' }
  }
  return { externalBaseUrl }
}

async function migrateLegacyConfig() {
  const context = requireContext()
  const raw = await context.settings.get(CONFIG_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const schemaVersion = numberOrNull(raw.schemaVersion) ?? 0
  if (schemaVersion >= CONFIG_SCHEMA_VERSION) return
  const rawExternal = typeof raw.externalBaseUrl === 'string' ? raw.externalBaseUrl.trim() : ''
  if (!rawExternal) return
  let externalBaseUrl
  try {
    externalBaseUrl = normalizeAdapterBaseUrl(rawExternal)
  } catch {
    return
  }
  const migratedExternalBaseUrl =
    externalBaseUrl === LEGACY_DEFAULT_API_BASE_URL ? '' : externalBaseUrl
  await context.settings.set(CONFIG_KEY, {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    externalBaseUrl: migratedExternalBaseUrl
  })
  if (!migratedExternalBaseUrl) {
    context.logger.info('Migrated legacy KuGou API address to the embedded service')
  }
}

async function resolveAdapterBaseUrl() {
  const { externalBaseUrl } = await readConfig()
  if (externalBaseUrl) return externalBaseUrl
  const service = await ensureEmbeddedService()
  return 'http://127.0.0.1:' + service.port
}

async function readDevice() {
  const raw = await requireContext().settings.get(DEVICE_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      platform: KUGOU_PLATFORM,
      dfid: '',
      cookies: {},
      guid: '',
      dev: '',
      mac: ''
    }
  }
  const samePlatform = raw.platform === KUGOU_PLATFORM
  const cookies = {}
  if (
    samePlatform &&
    raw.cookies &&
    typeof raw.cookies === 'object' &&
    !Array.isArray(raw.cookies)
  ) {
    for (const [name, value] of Object.entries(raw.cookies)) {
      if (/^KUGOU_API_/i.test(name) && typeof value === 'string' && value.trim()) {
        cookies[name] = value.trim()
      }
    }
  }
  return {
    platform: KUGOU_PLATFORM,
    dfid: samePlatform && typeof raw.dfid === 'string' ? raw.dfid.trim().slice(0, 256) : '',
    cookies,
    guid: typeof raw.guid === 'string' ? raw.guid.trim().slice(0, 128) : '',
    dev: typeof raw.dev === 'string' ? raw.dev.trim().slice(0, 64) : '',
    mac: typeof raw.mac === 'string' ? raw.mac.trim().slice(0, 32) : ''
  }
}

async function readAuth() {
  const raw = await requireContext().settings.get(AUTH_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.platform !== KUGOU_PLATFORM) return null
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const userid = typeof raw.userid === 'string' ? raw.userid.trim() : ''
  if (!token || !userid || userid === '0') return null
  return {
    token: token.slice(0, 4096),
    userid: userid.slice(0, 128),
    platform: KUGOU_PLATFORM
  }
}

async function requireAuth() {
  const auth = await readAuth()
  if (!auth) throw new Error('酷狗音乐需要先扫码登录')
  return auth
}

async function validateAuth(requestContext) {
  const auth = await readAuth()
  if (!auth) return null
  if (
    validatedAuth &&
    validatedAuth.expiresAt > Date.now() &&
    validatedAuth.token === auth.token &&
    validatedAuth.userid === auth.userid
  ) {
    return { auth, profile: validatedAuth.profile }
  }
  const payload = await adapterRequest(
    '/user/detail',
    {},
    { signal: requestSignal(requestContext), fresh: true }
  )
  const profile = mapProfile(payload, auth)
  if (!profile) throw new Error('酷狗账号接口未返回有效用户资料')
  validatedAuth = {
    token: auth.token,
    userid: auth.userid,
    profile,
    expiresAt: Date.now() + AUTH_VALIDATION_TTL_MS
  }
  return { auth, profile }
}

function isAuthRejection(error) {
  return error?.kugouCode === 152 || error?.kugouCode === 20010 || error?.kugouCode === 20018
}

async function assertConsent() {
  if (!(await hasConsent())) throw new Error(CONSENT_ERROR)
}

async function hasConsent() {
  const value = await requireContext().settings.get(CONSENT_KEY)
  return Boolean(value && typeof value === 'object' && value.disclaimerVersion === CONSENT_VERSION)
}

function requireContext() {
  if (!pluginContext) throw new Error('酷狗音乐插件尚未激活')
  return pluginContext
}

function normalizeAdapterBaseUrl(value) {
  const raw = String(value || '').trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('本机 API 地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('本机 API 地址必须使用 HTTP 或 HTTPS')
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error('为保护登录态，本插件只允许连接 localhost、127.0.0.1 或 ::1')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''
  return url.href.replace(/\/$/, '')
}

export function isLoopbackHost(hostname) {
  const normalized = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function assertAdapterSuccess(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('本机 KuGouMusicApi 返回了无效数据')
  }
  const errorCode = numberOrNull(payload.error_code, payload.errcode, payload.errorCode)
  if (errorCode != null && errorCode !== 0) {
    if (errorCode === 152) {
      throw adapterError('酷狗接口要求登录认证（错误码 152），请先扫码登录酷狗账号', errorCode)
    }
    if (errorCode === 20028) {
      throw adapterError(
        '酷狗账号或当前设备需要完成安全验证（错误码 20028），请在官方客户端完成验证后重新扫码登录',
        errorCode
      )
    }
    throw adapterError(
      safeErrorMessage(payload.msg || payload.error || '酷狗接口错误 ' + errorCode),
      errorCode
    )
  }
  const code = numberOrNull(payload.code)
  if (code != null && code < 0) {
    throw new Error(safeErrorMessage(payload.msg || payload.message || '酷狗接口错误 ' + code))
  }
}

function adapterError(message, code) {
  const error = new Error(message)
  error.kugouCode = code
  return error
}

function extractTrackItems(payload) {
  return firstArray(
    payload?.data?.info,
    payload?.data?.lists,
    payload?.data?.songs,
    payload?.data?.songlist,
    payload?.info,
    payload?.songs,
    payload?.list
  )
}

function extractPlaylistItems(payload) {
  return firstArray(
    payload?.data?.info,
    payload?.data?.lists,
    payload?.data?.list,
    payload?.data?.playlist,
    payload?.info,
    payload?.list
  )
}

function extractArtistItems(payload) {
  return firstArray(
    payload?.data,
    payload?.data?.info,
    payload?.data?.lists,
    payload?.data?.authors,
    payload?.info,
    payload?.list
  )
}

function extractTotal(payload, fallback) {
  const total = numberOrNull(
    payload?.data?.total,
    payload?.data?.total_count,
    payload?.data?.count,
    payload?.total,
    payload?.total_count
  )
  return total != null && total >= 0 ? Math.floor(total) : fallback
}

export function mapKugouTrack(item) {
  if (!item || typeof item !== 'object') return null
  const hash = firstString(item.hash, item.FileHash, item.filehash, item.audio_hash).toUpperCase()
  if (!hash) return null
  const rawName = firstString(
    item.songname,
    item.song_name,
    item.filename,
    item.FileName,
    item.name
  )
  const title = stripSearchTags(
    firstString(
      item.songname,
      item.SongName,
      item.song_name,
      splitFileName(rawName).title,
      '未知歌曲'
    )
  )
  const artist =
    stripSearchTags(
      firstString(item.singername, item.SingerName, item.singer_name, item.author_name, item.author)
    ) ||
    singersFromSingerInfo(item.singerinfo) ||
    stripSearchTags(splitFileName(rawName).artist) ||
    '未知艺术家'
  const album = stripSearchTags(
    firstString(
      item.album_name,
      item.AlbumName,
      item.albumname,
      item.album,
      item.albuminfo?.name,
      item.remark
    )
  )
  const providerAlbumId = firstString(item.album_id, item.AlbumID, item.albumid)
  const providerAlbumAudioId = firstString(
    item.album_audio_id,
    item.MixSongID,
    item.mixsongid,
    item.audio_id
  )
  const id = PROVIDER_ID + ':' + hash
  return {
    id,
    title,
    artist,
    artists: splitArtists(artist),
    album,
    filePath: id,
    fileName: sanitizeFileName(title) + '.mp3',
    duration: normalizeDuration(
      item.duration,
      item.timelength,
      item.timelen,
      item.Duration,
      item.time_length
    ),
    size: normalizeCount(
      item.filesize,
      item.size,
      item.filesize_320,
      item.filesize_128,
      item.FileSize
    ),
    cover: normalizeCover(
      firstString(
        item.imgurl,
        item.cover,
        item.album_sizable_cover,
        item.image,
        item.Image,
        item.AlbumImage
      )
    ),
    lyrics: null,
    translatedLyrics: null,
    source: PROVIDER_ID,
    streamUrl: null,
    bpm: undefined,
    providerSongId: hash,
    ...(providerAlbumId ? { providerAlbumId } : {}),
    ...(providerAlbumAudioId ? { providerAlbumAudioId } : {})
  }
}

function singersFromSingerInfo(value) {
  if (!Array.isArray(value)) return ''
  const names = value
    .map((entry) => firstString(entry?.name, entry?.singername, entry?.author_name))
    .filter(Boolean)
  return names.join('/')
}

function mapKugouPlaylist(item) {
  if (!item || typeof item !== 'object') return null
  const id = firstString(
    item.global_collection_id,
    item.specialid,
    item.listid,
    item.id,
    item.list_id
  )
  if (!id) return null
  const name = stripSearchTags(
    firstString(item.specialname, item.listname, item.name, item.title, '酷狗歌单')
  )
  return {
    id,
    name,
    cover: normalizeCover(firstString(item.imgurl, item.cover, item.picurl, item.image)) || null,
    trackCount: normalizeCount(item.song_count, item.songnum, item.count, item.total),
    creatorName: firstString(item.nickname, item.username, item.creator_name) || undefined,
    owned: Number(item.is_owner ?? item.owned ?? item.type) === 1
  }
}

function mapKugouArtist(item) {
  if (!item || typeof item !== 'object') return null
  const id = firstString(item.singerid, item.author_id, item.id)
  const name = stripSearchTags(
    firstString(item.singername, item.author_name, item.name, item.title)
  )
  if (!id || !name) return null
  return {
    id,
    name,
    cover: normalizeCover(firstString(item.imgurl, item.avatar, item.cover, item.image)) || null
  }
}

function mapProfile(payload, auth) {
  const source = firstRecord(payload?.data, payload)
  if (!source) return null
  const nickname = firstString(source.nickname, source.username, source.name, source.user_name)
  if (!nickname) return null
  return {
    id: firstString(source.userid, source.user_id, source.id, auth.userid),
    nickname,
    avatar:
      normalizeCover(firstString(source.userpic, source.avatar, source.imgurl, source.headimg)) ||
      null
  }
}

function trackHash(track) {
  const id = typeof track?.id === 'string' ? track.id.trim() : ''
  if (id.startsWith(PROVIDER_ID + ':')) return id.slice(PROVIDER_ID.length + 1).trim()
  const providerSongId =
    typeof track?.providerSongId === 'string' ? track.providerSongId.trim() : ''
  return providerSongId
}

function trackProviderValue(track, key) {
  const value = track && typeof track === 'object' ? track[key] : ''
  return firstString(value) || '0'
}

function normalizePlaylistId(value) {
  const id = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('酷狗歌单 ID 无效')
  return id
}

function findLyricCandidate(payload) {
  const queue = [payload]
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    if (!Array.isArray(current)) {
      const id = firstString(current.id, current.lyric_id)
      const accesskey = firstString(current.accesskey, current.access_key)
      if (id && accesskey) return { id, accesskey }
      for (const value of Object.values(current)) queue.push(value)
      continue
    }
    for (const value of current) queue.push(value)
  }
  return null
}

function extractLyricContent(payload) {
  const value = firstString(
    payload?.decodeContent,
    payload?.data?.decodeContent,
    payload?.content,
    payload?.data?.content
  )
  if (!value) return ''
  if (value.includes('[') || value.includes('\n')) return value
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function emptyLyrics() {
  return { lyrics: null, translatedLyrics: null, wordLyrics: null }
}

export function krcToLrc(value) {
  const lines = String(value || '').split(/\r?\n/)
  const converted = []
  for (const line of lines) {
    const match = line.match(/^\[(\d+),(\d+)(?:,[^\]]*)?\](.*)$/)
    if (!match) continue
    const words = match[3].replace(/<\d+,\d+,[^>]*>/g, '')
    if (!words.trim()) continue
    converted.push('[' + formatLrcTime(Number(match[1])) + ']' + words)
  }
  return converted.join('\n')
}

function formatLrcTime(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds || 0))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const centiseconds = Math.floor((total % 1000) / 10)
  return (
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    '.' +
    String(centiseconds).padStart(2, '0')
  )
}

function extractQrKey(payload) {
  return firstString(
    payload?.data?.qrcode,
    payload?.data?.key,
    payload?.data?.qrcode_key,
    payload?.qrcode,
    payload?.key
  )
}

function extractQrImage(payload) {
  const image = firstString(
    payload?.data?.base64,
    payload?.data?.image,
    payload?.base64,
    payload?.image
  )
  if (!image) return ''
  return image.startsWith('data:image/') ? image : 'data:image/png;base64,' + image
}

function extractQrStatus(payload) {
  const data = firstRecord(payload?.data, payload) || {}
  const code = numberOrNull(data.status, data.code, payload?.status, payload?.code)
  return {
    code: code == null ? 1 : code,
    token: firstString(data.token, payload?.token),
    userid: firstString(data.userid, data.user_id, payload?.userid)
  }
}

export function qualityLadder(value) {
  const normalized = String(value || '').toLowerCase()
  if (
    normalized === 'flac' ||
    normalized === 'ape' ||
    normalized === 'lossless' ||
    normalized === 'hires' ||
    normalized === 'hi-res' ||
    normalized === 'hi_res' ||
    normalized === 'high'
  ) {
    return ['flac', '320', '128']
  }
  if (normalized === '320' || normalized === 'exhigh') return ['320', '128']
  return ['128']
}

function extractStreamUrl(payload) {
  const candidates = [
    payload?.data?.url,
    payload?.url,
    payload?.data?.play_url,
    payload?.play_url,
    payload?.data?.audio_url,
    payload?.audio_url,
    payload?.data?.data?.url,
    payload?.data?.data?.play_url,
    payload?.data?.data?.audio_url,
    payload?.data?.data?.urls,
    payload?.data?.backupUrl,
    payload?.backupUrl,
    payload?.data?.urls,
    payload?.urls
  ]
  for (const candidate of candidates) {
    const url = pickStreamUrl(candidate)
    if (url) return url
  }
  return ''
}

function assertKugouPlaybackPayload(payload) {
  if (numberOrNull(payload?.code) === 200 && Array.isArray(payload?.data)) {
    throw new Error(
      '配置的外部本机 API 不是 KuGouMusicApi。请在“设置 → 插件设置 → 酷狗音乐音源”清空外部 API 地址，改用内嵌服务'
    )
  }
}

function pickStreamUrl(candidate) {
  if (typeof candidate === 'string') return normalizeHttpUrl(candidate)
  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const url = pickStreamUrl(entry)
      if (url) return url
    }
    return ''
  }
  if (candidate && typeof candidate === 'object') {
    return normalizeHttpUrl(firstString(candidate.url, candidate.play_url, candidate.audio_url))
  }
  return ''
}

async function createStreamToken(entry) {
  await ensureProxyServer()
  purgeExpiredStreamTokens()
  while (streamTokens.size >= MAX_STREAM_TOKENS) {
    const oldest = streamTokens.keys().next().value
    if (!oldest) break
    streamTokens.delete(oldest)
  }
  const token = randomBytes(32).toString('base64url')
  streamTokens.set(token, {
    ...entry,
    expiresAt: Date.now() + STREAM_TOKEN_TTL_MS
  })
  return 'http://127.0.0.1:' + proxyPort + '/kugou/stream/' + token
}

async function ensureProxyServer() {
  if (proxyServer && proxyPort > 0) return
  if (proxyServerStart) return proxyServerStart
  proxyServerStart = new Promise((resolve, reject) => {
    proxyServer = createServer((request, response) => {
      void handleStreamRequest(request, response)
    })
    proxyServer.once('error', reject)
    proxyServer.listen(0, '127.0.0.1', () => {
      proxyServer.off('error', reject)
      const address = proxyServer.address()
      proxyPort = typeof address === 'object' && address ? address.port : 0
      if (!proxyPort) {
        reject(new Error('酷狗本机音频代理启动失败'))
        return
      }
      resolve()
    })
  }).finally(() => {
    proxyServerStart = null
  })
  return proxyServerStart
}

async function handleStreamRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const token = url.pathname.startsWith('/kugou/stream/')
    ? url.pathname.slice('/kugou/stream/'.length)
    : ''
  const entry = streamTokens.get(token)
  if (!entry || entry.expiresAt <= Date.now()) {
    streamTokens.delete(token)
    response.writeHead(404)
    response.end('酷狗播放令牌无效或已过期')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }
  const controller = new AbortController()
  let finished = false
  request.once('close', () => {
    if (!finished) controller.abort()
  })
  try {
    let upstream = await fetchStream(entry.directUrl, request, controller.signal)
    if (upstream && [401, 403, 404].includes(upstream.status)) {
      const refreshed = await resolvePlaybackUrl(entry.hash, entry.quality, {
        signal: controller.signal
      })
      if (refreshed) {
        entry.directUrl = refreshed
        upstream = await fetchStream(refreshed, request, controller.signal)
      }
    }
    if (!upstream) {
      response.writeHead(502)
      response.end('酷狗上游播放请求失败')
      return
    }
    if (!upstream.ok) {
      response.writeHead(upstream.status || 502)
      response.end('酷狗上游播放请求失败')
      return
    }
    response.writeHead(upstream.status, copyStreamHeaders(upstream.headers))
    if (request.method === 'HEAD' || !upstream.body) {
      response.end()
      return
    }
    for await (const chunk of upstream.body) {
      if (!response.write(chunk)) {
        await new Promise((resolve) => response.once('drain', resolve))
      }
    }
    finished = true
    response.end()
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(controller.signal.aborted ? 499 : 502)
      response.end('酷狗本机音频代理错误')
    } else {
      response.destroy()
    }
    logWarn('KuGou stream proxy failed: ' + safeErrorMessage(error))
  }
}

async function fetchStream(url, request, signal) {
  const headers = {}
  const range = request.headers.range
  if (typeof range === 'string' && range) headers.Range = range
  return fetchWithHeaderTimeout(url, { headers, signal }, STREAM_HEADER_TIMEOUT_MS)
}

function copyStreamHeaders(headers) {
  const copied = {}
  for (const name of [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified'
  ]) {
    const value = headers.get(name)
    if (value) copied[name] = value
  }
  return copied
}

function purgeExpiredStreamTokens() {
  const now = Date.now()
  for (const [token, entry] of streamTokens) {
    if (entry.expiresAt <= now) streamTokens.delete(token)
  }
}

async function fetchJsonWithTimeout(input, options, timeoutMs) {
  return fetchWithHeaderTimeout(input, options, timeoutMs)
}

async function fetchWithHeaderTimeout(input, options, timeoutMs) {
  const externalSignal = options.signal
  if (externalSignal?.aborted) throw externalSignal.reason || abortError()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(abortError()), timeoutMs)
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal
  try {
    return await fetch(input, { ...options, signal })
  } finally {
    clearTimeout(timer)
  }
}

function requestSignal(requestContext) {
  return requestContext && typeof requestContext.signal?.aborted === 'boolean'
    ? requestContext.signal
    : undefined
}

function abortError() {
  const error = new Error('酷狗请求已取消或超时')
  error.name = 'AbortError'
  return error
}

export function parseSetCookieHeader(headers) {
  const raw =
    typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers?.get?.('set-cookie') || '')
  const cookies = {}
  for (const line of raw.flatMap(splitSetCookieHeader)) {
    const first = String(line || '').split(';', 1)[0]
    const index = first.indexOf('=')
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (name && value) cookies[name] = value
  }
  return cookies
}

function splitSetCookieHeader(value) {
  if (!value) return []
  return String(value).split(/,(?=\s*[^;,\s]+=)/)
}

function cookieHeader(values) {
  return Object.entries(values)
    .filter(([name, value]) => name && typeof value === 'string' && value)
    .map(([name, value]) => name + '=' + value)
    .join(';')
}

function splitCookiePairs(header) {
  const pairs = []
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name && value) pairs.push([name, value])
  }
  return pairs
}

function firstArray(...values) {
  return values.find(Array.isArray) || []
}

function firstRecord(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function stripSearchTags(value) {
  return String(value || '')
    .replace(/<\/?em>/gi, '')
    .trim()
}

function normalizeDuration(...values) {
  const value = values.find(
    (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) > 0
  )
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.round(duration > 10000 ? duration / 1000 : duration)
}

function normalizeCount(...values) {
  const value = values.find(
    (candidate) => Number.isFinite(Number(candidate)) && Number(candidate) >= 0
  )
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

function normalizeLimit(value) {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(value) || 30)))
}

function numberOrNull(...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function splitFileName(value) {
  const name = String(value || '').trim()
  const index = name.indexOf(' - ')
  if (index <= 0) return { artist: '', title: name }
  return {
    artist: name.slice(0, index).trim(),
    title: name.slice(index + 3).trim()
  }
}

function splitArtists(value) {
  const artists = String(value || '')
    .split(/\s*(?:\/|、|&|,|，)\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
  return artists.length ? artists.map((name) => ({ name })) : undefined
}

function sanitizeFileName(value) {
  return String(value || 'KuGou Music')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 180)
}

function normalizeCover(value) {
  const url = String(value || '')
    .trim()
    .replace(/\{size\}/gi, '400')
    .replace(/\{width\}/gi, '400')
    .replace(/\{height\}/gi, '400')
  return normalizeHttpUrl(url)
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = value.trim().startsWith('//') ? 'https:' + value.trim() : value.trim()
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function safeErrorMessage(error) {
  return errorToMessage(error)
    .replace(
      /(?:^|[;\s])(?:token|userid|dfid|cookie|authorization|accesskey|qrcode|key)=[^;\s]*/gi,
      '$1[credential-redacted]'
    )
    .replace(
      /((?:["']?)(?:token|userid|dfid|cookie|authorization|accesskey|qrcode|key)(?:["']?\s*[:=]\s*))(?:(?:"[^"]*")|(?:'[^']*')|[^,;\s}]+)/gi,
      '$1[credential-redacted]'
    )
    .replace(/https?:\/\/[^\s]+/gi, '[upstream-url-redacted]')
    .slice(0, 240)
}

function logWarn(message) {
  pluginContext?.logger?.warn?.(message)
}
