import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'

const PROVIDER_ID = 'bili'
const SETTINGS_AUTH_KEY = 'auth'
const BILI_REFERER = 'https://www.bilibili.com/'
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const QR_EXPIRES_SECONDS = 180
const STREAM_PROXY_TOKEN_TTL_MS = 8 * 60 * 1000
const IMAGE_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const MAX_FAVORITE_PAGES = 50
const PAGE_SIZE = 20
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

let pluginContext = null
let proxyServer = null
let proxyPort = 0
const proxyTokens = new Map()

export async function activate(context) {
  pluginContext = context
  context.logger.info('Registering Bilibili favorites provider')
  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'Bilibili',
    capabilities: ['login', 'playlist', 'library', 'playbackUrl', 'cover'],
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    checkQrLogin,
    fetchUserLibrary,
    fetchPlaylistTracks,
    getPlaybackUrl
  })
  await context.twilight.ui.register({
    id: 'bilibili-account',
    kind: 'settingsPanel',
    title: 'Bilibili 账号',
    description: '登录后可在流媒体页播放收藏夹视频的音频'
  })
}

export async function deactivate() {
  proxyTokens.clear()
  if (proxyServer) {
    await new Promise((resolve) => proxyServer.close(resolve))
    proxyServer = null
    proxyPort = 0
  }
  pluginContext = null
}

async function checkLogin() {
  const auth = await readAuth()
  if (!auth?.cookie) return { loggedIn: false, profile: null }
  try {
    const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', { cookie: auth.cookie })
    const data = nav.data
    if (!data?.isLogin) return { loggedIn: false, profile: null }
    return { loggedIn: true, profile: await mapProfile(data, auth.cookie) }
  } catch (error) {
    logWarn(`Bilibili login check failed: ${errorToMessage(error)}`)
    return { loggedIn: false, profile: null }
  }
}

async function getProfile() {
  const state = await checkLogin()
  return state.profile
}

async function logout() {
  await requireContext().settings.delete(SETTINGS_AUTH_KEY)
  proxyTokens.clear()
}

async function getQrLogin() {
  const response = await biliJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
  const data = response.data
  if (!data?.qrcode_key || !data?.url) {
    throw new Error('Bilibili 二维码生成失败')
  }
  return {
    key: String(data.qrcode_key),
    qrContent: String(data.url),
    expiresInSeconds: QR_EXPIRES_SECONDS
  }
}

async function checkQrLogin(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Bilibili 二维码 key 无效')
  const url = new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll')
  url.searchParams.set('qrcode_key', key.trim())
  const response = await fetch(url, { headers: defaultHeaders() })
  const json = await response.json()
  const code = Number(json?.data?.code ?? json?.code)
  if (code === 0) {
    const cookies = parseSetCookies(getSetCookieHeaders(response.headers))
    const cookie = mergeCookieString(cookies)
    if (!cookie.includes('SESSDATA=')) throw new Error('Bilibili 登录成功但没有返回 SESSDATA')
    await requireContext().settings.set(SETTINGS_AUTH_KEY, {
      cookie,
      refreshToken: typeof json?.data?.refresh_token === 'string' ? json.data.refresh_token : '',
      updatedAt: new Date().toISOString()
    })
    logInfo('Bilibili login succeeded')
  }
  return { code, message: typeof json?.data?.message === 'string' ? json.data.message : '' }
}

async function fetchUserLibrary() {
  const { cookie, profile } = await requireLoggedIn()
  const url = new URL('https://api.bilibili.com/x/v3/fav/folder/created/list-all')
  url.searchParams.set('up_mid', String(profile.userId))
  url.searchParams.set('type', '2')
  const response = await biliJson(url, { cookie })
  const list = Array.isArray(response.data?.list) ? response.data.list : []
  const playlists = await Promise.all(
    sortFavoriteFolders(list).map(async (folder) => ({
      id: String(folder.id),
      name: String(folder.title || 'Bilibili 收藏夹'),
      cover:
        typeof folder.cover === 'string' && folder.cover
          ? await createImageProxyUrl(folder.cover, cookie)
          : null,
      trackCount: Number(folder.media_count) || 0
    }))
  )
  return {
    likedPlaylist: playlists[0] ?? null,
    playlists
  }
}

async function fetchPlaylistTracks(playlistId) {
  const { cookie } = await requireLoggedIn()
  const tracks = []
  for (let page = 1; page <= MAX_FAVORITE_PAGES; page += 1) {
    const url = new URL('https://api.bilibili.com/x/v3/fav/resource/list')
    url.searchParams.set('media_id', String(playlistId))
    url.searchParams.set('ps', String(PAGE_SIZE))
    url.searchParams.set('pn', String(page))
    url.searchParams.set('type', '0')
    url.searchParams.set('platform', 'web')
    const response = await biliJson(url, { cookie })
    const medias = Array.isArray(response.data?.medias) ? response.data.medias : []
    const albumName = typeof response.data?.info?.title === 'string' ? response.data.info.title : 'Bilibili'
    for (const media of medias) {
      if (media?.type !== 2 || media?.attr !== 0) continue
      const track = await mapMediaToTrack(media, albumName, cookie)
      if (track) tracks.push(track)
    }
    if (!response.data?.has_more || medias.length === 0) break
  }
  return tracks
}

async function getPlaybackUrl(track) {
  const { cookie } = await requireLoggedIn()
  const ids = parseBiliTrackId(track?.id || track?.filePath)
  if (!ids) throw new Error('Bilibili track id 无效')
  const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', { cookie })
  const keys = extractWbiKeys(nav.data?.wbi_img)
  const query = encodeWbiWithKeys(
    {
      bvid: ids.bvid,
      cid: ids.cid,
      fnval: 4048,
      fnver: 0,
      fourk: 1
    },
    keys
  )
  const playUrl = `https://api.bilibili.com/x/player/wbi/playurl?${query}`
  const response = await biliJson(playUrl, { cookie })
  const audioUrl = selectDashAudioUrl(response.data)
  if (!audioUrl) throw new Error('Bilibili 未返回可播放音频流')
  await ensureProxyServer()
  const token = createProxyToken({ kind: 'stream', url: audioUrl, cookie }, STREAM_PROXY_TOKEN_TTL_MS)
  return `http://127.0.0.1:${proxyPort}/stream/${token}`
}

async function mapMediaToTrack(media, albumName, cookie) {
  const bvid = typeof media.bvid === 'string' ? media.bvid : typeof media.bv_id === 'string' ? media.bv_id : ''
  if (!bvid) return null
  const view = await getVideoView(bvid, cookie).catch((error) => {
    logWarn(`Skipping Bilibili media ${bvid}: ${errorToMessage(error)}`)
    return null
  })
  const page = Array.isArray(view?.pages) ? view.pages[0] : null
  const cid = Number(page?.cid ?? view?.cid)
  if (!Number.isFinite(cid)) return null
  const track = mapBiliMediaToTrack(media, {
    bvid,
    cid,
    title: typeof page?.part === 'string' && page.part.trim() ? `${media.title} - ${page.part}` : String(media.title),
    duration: Number(page?.duration ?? media.duration) || 0,
    albumName
  })
  if (track.cover) {
    track.cover = await createImageProxyUrl(track.cover, cookie)
  }
  return track
}

async function getVideoView(bvid, cookie) {
  const url = new URL('https://api.bilibili.com/x/web-interface/view')
  url.searchParams.set('bvid', bvid)
  const response = await biliJson(url, { cookie })
  return response.data
}

async function biliJson(input, options = {}) {
  const response = await fetch(input, {
    headers: defaultHeaders(options.cookie)
  })
  if (!response.ok) {
    throw new Error(`Bilibili 请求失败：HTTP ${response.status}`)
  }
  const json = await response.json()
  if (json?.code !== 0) {
    throw new Error(`Bilibili API 错误：${json?.message || json?.code}`)
  }
  return json
}

function defaultHeaders(cookie) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: BILI_REFERER,
    'User-Agent': BILI_UA
  }
  if (cookie) headers.Cookie = cookie
  return headers
}

async function requireLoggedIn() {
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('请先登录 Bilibili')
  const login = await checkLogin()
  if (!login.loggedIn || !login.profile) throw new Error('Bilibili 登录已失效，请重新登录')
  return { cookie: auth.cookie, profile: login.profile }
}

async function readAuth() {
  const value = await requireContext().settings.get(SETTINGS_AUTH_KEY)
  if (!value || typeof value !== 'object') return null
  const cookie = typeof value.cookie === 'string' ? value.cookie : ''
  if (!cookie) return null
  return {
    cookie,
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : ''
  }
}

async function ensureProxyServer() {
  if (proxyServer && proxyPort > 0) return
  proxyServer = createServer((request, response) => {
    void handleProxyRequest(request, response)
  })
  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject)
    proxyServer.listen(0, '127.0.0.1', () => {
      const address = proxyServer.address()
      proxyPort = typeof address === 'object' && address ? address.port : 0
      proxyServer.off('error', reject)
      resolve()
    })
  })
}

async function handleProxyRequest(request, response) {
  try {
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }
    const match = /^\/(stream|image)\/([a-f0-9]+)$/.exec(request.url || '')
    const kind = match?.[1]
    const entry = match ? proxyTokens.get(match[2]) : null
    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
      response.statusCode = 403
      response.end('Invalid or expired stream token')
      return
    }
    const upstreamHeaders = {
      Referer: BILI_REFERER,
      'User-Agent': BILI_UA
    }
    if (entry.cookie) upstreamHeaders.Cookie = entry.cookie
    const range = request.headers.range
    if (kind === 'stream' && typeof range === 'string') upstreamHeaders.Range = range
    const upstream = await fetch(entry.url, { headers: upstreamHeaders })
    response.statusCode = upstream.status
    for (const [name, value] of upstream.headers) {
      if (shouldProxyHeader(name)) response.setHeader(name, value)
    }
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (kind === 'image') {
      response.setHeader('Cache-Control', 'private, max-age=21600')
    }
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    if (!upstream.body) {
      response.end()
      return
    }
    for await (const chunk of upstream.body) {
      response.write(chunk)
    }
    response.end()
  } catch (error) {
    response.statusCode = 502
    response.end(`Bilibili proxy failed: ${errorToMessage(error)}`)
  }
}

function createProxyToken(entry, ttlMs) {
  const token = randomBytes(16).toString('hex')
  proxyTokens.set(token, {
    ...entry,
    expiresAt: Date.now() + ttlMs
  })
  for (const [key, value] of proxyTokens) {
    if (value.expiresAt <= Date.now()) proxyTokens.delete(key)
  }
  return token
}

async function createImageProxyUrl(url, cookie) {
  const normalized = normalizeImageUrl(url)
  if (!normalized) return null
  await ensureProxyServer()
  const token = createProxyToken(
    {
      kind: 'image',
      url: normalized,
      cookie
    },
    IMAGE_PROXY_TOKEN_TTL_MS
  )
  return `http://127.0.0.1:${proxyPort}/image/${token}`
}

function shouldProxyHeader(name) {
  return ![
    'connection',
    'content-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade'
  ].includes(name.toLowerCase())
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? splitSetCookie(raw) : []
}

export function parseSetCookies(setCookieHeaders) {
  const cookies = {}
  for (const header of setCookieHeaders) {
    const first = String(header).split(';')[0]
    const separatorIndex = first.indexOf('=')
    if (separatorIndex <= 0) continue
    const name = first.slice(0, separatorIndex).trim()
    const value = first.slice(separatorIndex + 1).trim()
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(name)) {
      cookies[name] = value
    }
  }
  return cookies
}

function splitSetCookie(raw) {
  return String(raw).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((item) => item.trim())
}

function mergeCookieString(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export function sortFavoriteFolders(list) {
  return [...list].sort((left, right) => {
    const leftDefault = isDefaultFavorite(left) ? 0 : 1
    const rightDefault = isDefaultFavorite(right) ? 0 : 1
    if (leftDefault !== rightDefault) return leftDefault - rightDefault
    return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN')
  })
}

function isDefaultFavorite(folder) {
  const attr = Number(folder?.attr)
  return Number.isFinite(attr) && (attr & 0b10) === 0
}

export function mapBiliMediaToTrack(media, options) {
  const title = String(options.title || media.title || 'Bilibili 视频')
  const artist = String(media.upper?.name || 'Bilibili')
  const id = `bili:${options.bvid}:${options.cid}`
  return {
    id,
    title,
    artist,
    album: String(options.albumName || 'Bilibili'),
    filePath: id,
    fileName: `${artist} - ${title}`,
    duration: Number(options.duration) || Number(media.duration) || 0,
    size: 0,
    cover: typeof media.cover === 'string' && media.cover ? normalizeImageUrl(media.cover) : null,
    lyrics: null,
    source: PROVIDER_ID
  }
}

async function mapProfile(data, cookie) {
  return {
    userId: data.mid,
    nickname: String(data.uname || 'Bilibili 用户'),
    avatarUrl: (await createImageProxyUrl(String(data.face || ''), cookie)) || '',
    signature: '',
    follows: 0,
    followeds: 0
  }
}

function normalizeImageUrl(url) {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
  return url
}

function parseBiliTrackId(value) {
  if (typeof value !== 'string') return null
  const match = /^bili:([^:]+):(\d+)$/.exec(value)
  if (!match) return null
  return { bvid: match[1], cid: match[2] }
}

function extractWbiKeys(wbiImg) {
  const imgKey = extractWbiKey(wbiImg?.img_url)
  const subKey = extractWbiKey(wbiImg?.sub_url)
  if (!imgKey || !subKey) throw new Error('Bilibili WBI key 不可用')
  return { imgKey, subKey }
}

function extractWbiKey(url) {
  if (typeof url !== 'string') return ''
  const name = url.split('/').pop() || ''
  return name.split('.')[0] || ''
}

export function encodeWbiWithKeys(params, keys, timestamp = Math.floor(Date.now() / 1000)) {
  const mixinKey = getMixinKey(keys.imgKey + keys.subKey)
  const signedParams = { ...params, wts: timestamp }
  const query = Object.keys(signedParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeWbiValue(signedParams[key])}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function getMixinKey(rawKey) {
  return WBI_MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join('').slice(0, 32)
}

function encodeWbiValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''))
}

export function selectDashAudioUrl(data) {
  const flac = data?.dash?.flac?.audio
  if (flac?.baseUrl || flac?.base_url) return flac.baseUrl || flac.base_url
  const audio = Array.isArray(data?.dash?.audio) ? data.dash.audio : []
  const candidates = audio
    .map((item) => ({
      url: item?.baseUrl || item?.base_url,
      bandwidth: Number(item?.bandwidth) || 0
    }))
    .filter((item) => typeof item.url === 'string' && item.url)
  candidates.sort((left, right) => right.bandwidth - left.bandwidth)
  return candidates[0]?.url ?? null
}

function requireContext() {
  if (!pluginContext) throw new Error('Bilibili plugin is not active')
  return pluginContext
}

function logInfo(message) {
  pluginContext?.logger.info(message)
}

function logWarn(message) {
  pluginContext?.logger.warn(message)
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
