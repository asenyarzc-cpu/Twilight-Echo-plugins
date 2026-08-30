import { createServer } from 'node:http'
import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes
} from 'node:crypto'

const PROVIDER_ID = 'qq'
const AUTH_KEY = 'auth'
const DEVICE_KEY = 'native-device'
const CONSENT_KEY = 'disclaimer'
const CONSENT_VERSION = 'qqmusic-v1'
const SETTINGS_COMMAND = 'qqmusic.settings'
const ISSUES_URL = 'https://github.com/asenyarzc-cpu/Twilight-Echo-plugins/issues/new'

const QQ_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 10000
const STREAM_HEADER_TIMEOUT_MS = 15000
const QR_TTL_MS = 3 * 60 * 1000
const LOGIN_CACHE_TTL_MS = 60 * 1000
const PLAYLIST_CACHE_TTL_MS = 5 * 60 * 1000
const STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const MAX_STREAM_TOKENS = 512
const CREDENTIAL_REJECTION_CODES = new Set([1000, 104400, 104401])
const NATIVE_QR_CLIENT_VERSION = 14090008
const NATIVE_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const NATIVE_QR_MQTT_URL = 'wss://mu.y.qq.com/ws/handshake'
const NATIVE_QR_MQTT_TIMEOUT_MS = 20 * 1000
const NATIVE_QR_MQTT_KEEPALIVE_MS = 30 * 1000
const NATIVE_ANDROID_CHANNEL_ID = '10003505'
const NATIVE_QIMEI_TTL_MS = 24 * 60 * 60 * 1000
const QQ_PUBLIC_REFERER = 'https://c.y.qq.com/'
const QQ_MUSICU_REFERER = 'https://y.qq.com/portal/player.html'
const DEFAULT_PLAYABLE_DOMAIN = 'http://dl.stream.qqmusic.qq.com/'
const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy'
const QIMEI_APP_ID = 'qimei_qq_android'
const QIMEI_APP_KEY = '0AND0HD6FE4HY80F'
const QIMEI_SECRET = 'ZdJqM15EeO2zWc08'
const QIMEI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEIxgwoutfwoJxcGQeedgP7FG9qaIuS0qzfR8gWkrkTZKM2iWHn2ajQpBR
ZjMSoSf6+KJGvar2ORhBfpDXyVtZCKpqLQ+FLkpncClKVIrBwv6PHyUvuCb0rIarmgDnzkfQAqVufEtR64iazGDKatvJ9y6B
9NMbHddGSAUmRTCrHQIDAQAB
-----END PUBLIC KEY-----`

const QUALITY_DEFINITIONS = {
  flac: { prefix: 'F000', suffix: '.flac' },
  320: { prefix: 'M800', suffix: '.mp3' },
  128: { prefix: 'M500', suffix: '.mp3' }
}

let pluginContext = null
let proxyServer = null
let proxyServerStart = null
let proxyPort = 0
let loginCache = null
let nativeDevicePreparation = null

const qrSessions = new Map()
const streamTokens = new Map()
const playlistCache = new Map()
const playlistCategoryIds = new Map([['全部', 10000000]])

const CONSENT_ERROR =
  '首次使用 QQ 音乐音源前，请在设置中阅读并确认免责声明。打开“设置 → 插件设置 → QQ 音乐音源”完成确认。'

export async function activate(context) {
  pluginContext = context
  context.logger.info('Registering QQ Music provider')

  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'QQ 音乐',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-music',
      color: '#31c27c',
      description: 'QQ 音乐曲库',
      authType: 'qr',
      loginInstructions: '请先在设置中确认免责声明，再使用 QQ 音乐二维码登录',
      qrStatusCodes: { waiting: 66, scanned: 67, expired: 65, success: 0 },
      streamingSections: [
        {
          id: 'new-songs',
          title: '新歌推荐',
          icon: 'pi pi-sparkles',
          method: 'fetchRecommendSongs'
        }
      ],
      streamingLibraryTab: true,
      streamingSearch: true,
      unifiedLibrary: true
    },
    searchSongs,
    searchPlaylists,
    searchArtists,
    fetchRecommendSongs,
    fetchRecommendPlaylists,
    fetchPlaylistCategories,
    fetchDiscoveryPlaylists,
    getPlaybackUrl,
    getLyrics,
    fetchPlaylistTracks,
    fetchUserLibrary,
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    checkQrLogin
  })

  await context.twilight.ui.register({
    id: 'qqmusic-settings',
    kind: 'settingsPanel',
    title: 'QQ 音乐音源',
    description: '确认免责声明并管理 QQ 音乐扫码登录',
    command: SETTINGS_COMMAND
  })
  context.twilight.ui.onCommand(SETTINGS_COMMAND, settingsCommand)
}

export async function deactivate() {
  clearQrSessions()
  streamTokens.clear()
  playlistCache.clear()
  resetPlaylistCategoryIds()
  loginCache = null
  nativeDevicePreparation = null
  if (proxyServer) {
    proxyServer.closeAllConnections?.()
    await new Promise((resolve) => proxyServer.close(resolve))
    proxyServer = null
    proxyPort = 0
  }
  proxyServerStart = null
  pluginContext = null
}

async function settingsCommand(value) {
  if (value && typeof value === 'object' && value.source === 'settingsPanel') {
    return createSettingsForm()
  }
  return saveSettings(value)
}

async function saveSettings(values) {
  const accepted = values && typeof values === 'object' && values.disclaimer === CONSENT_VERSION
  if (!accepted) {
    throw new Error('请先选择“我已阅读并同意免责声明”')
  }
  await requireContext().settings.set(CONSENT_KEY, {
    disclaimerVersion: CONSENT_VERSION,
    acceptedAt: new Date().toISOString()
  })
  return {
    message: '免责声明确认已保存。现在可以返回 QQ 音乐登录页扫码登录。',
    form: await createSettingsForm()
  }
}

async function createSettingsForm() {
  const accepted = await hasConsent()
  return {
    kind: 'settings-form',
    submitCommand: SETTINGS_COMMAND,
    notice: [
      '免责声明：本插件仅供个人学习与研究使用，与腾讯或 QQ 音乐无隶属关系。',
      '用户必须自行遵守适用法律、QQ 音乐服务条款与版权要求；插件不提供下载、破解或绕过访问限制的功能。',
      '插件不会收集遥测数据。问题反馈：',
      ISSUES_URL
    ].join('\n'),
    fields: [
      {
        key: 'disclaimer',
        label: '使用确认',
        type: 'select',
        required: true,
        placeholder: '',
        value: accepted ? CONSENT_VERSION : '',
        options: [
          { label: '请选择', value: '' },
          { label: '我已阅读并同意免责声明', value: CONSENT_VERSION }
        ]
      }
    ]
  }
}

async function checkLogin() {
  if (!(await hasConsent())) return { loggedIn: false, profile: null }
  const auth = await readAuth()
  if (!auth) {
    loginCache = null
    return { loggedIn: false, profile: null }
  }
  if (loginCache && loginCache.cookie === auth.cookie && Date.now() < loginCache.expiresAt) {
    return { loggedIn: true, profile: loginCache.profile }
  }
  const profile = auth.profile || buildProfile(auth.uin)
  loginCache = { cookie: auth.cookie, profile, expiresAt: Date.now() + LOGIN_CACHE_TTL_MS }
  return { loggedIn: true, profile }
}

async function getProfile() {
  const state = await checkLogin()
  return state.profile
}

async function logout() {
  const context = requireContext()
  clearQrSessions()
  await context.settings.delete(AUTH_KEY)
  await context.settings.delete(DEVICE_KEY)
  loginCache = null
  nativeDevicePreparation = null
  streamTokens.clear()
  playlistCache.clear()
}

async function getQrLogin(requestContext) {
  await assertConsent()
  clearQrSessions()
  const qr = await createNativeQr(requestContext)
  const key = randomBytes(24).toString('hex')
  const session = {
    key,
    qrcodeId: qr.qrcodeId,
    device: qr.device,
    expiresAt: Date.now() + Math.min(QR_TTL_MS, qr.expiresInSeconds * 1000),
    state: 'connecting',
    listener: null,
    exchangePromise: null,
    errorMessage: ''
  }
  qrSessions.set(key, session)
  try {
    session.listener = startNativeQrListener(
      qr.qrcodeId,
      (event) => handleNativeQrEvent(key, event),
      Math.max(1, session.expiresAt - Date.now()),
      requestSignal(requestContext)
    )
    void session.listener.done.catch((error) => handleNativeQrListenerFailure(key, error))
    await session.listener.ready
    if (qrSessions.get(key) !== session) throw new Error('QQ 音乐二维码会话已关闭')
    if (session.state === 'connecting') session.state = 'waiting'
    return {
      key,
      qrContent: key,
      imageDataUrl: qr.imageDataUrl,
      expiresInSeconds: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))
    }
  } catch (error) {
    closeQrSession(key)
    if (requestSignal(requestContext)?.aborted || error?.name === 'AbortError') throw error
    logWarn(`QQ native QR initialization failed: ${safeErrorMessage(error)}`)
    throw new Error('QQ 音乐二维码登录初始化失败，请稍后重试')
  }
}

async function checkQrLogin(key, requestContext) {
  await assertConsent()
  if (typeof key !== 'string' || !key.trim()) throw new Error('QQ 二维码 key 无效')
  const session = qrSessions.get(key.trim())
  if (!session) return { code: 65, message: '二维码不存在或已过期' }
  if (Date.now() >= session.expiresAt) {
    closeQrSession(key.trim())
    return { code: 65, message: '二维码已过期' }
  }
  if (session.state === 'success') {
    closeQrSession(key.trim())
    return { code: 0, message: '登录成功' }
  }
  if (session.state === 'failed') {
    const message = session.errorMessage || 'QQ 音乐扫码登录失败，请刷新二维码后重试'
    closeQrSession(key.trim())
    return { code: 502, message }
  }
  if (session.state === 'expired') {
    closeQrSession(key.trim())
    return { code: 65, message: '二维码已过期' }
  }
  if (session.state === 'scanned' || session.state === 'exchanging') {
    return { code: 67, message: session.state === 'scanned' ? '已扫描二维码' : '正在建立登录会话' }
  }
  return { code: 66, message: '等待扫描二维码' }
}

async function createNativeQr(requestContext) {
  const device = await prepareNativeDevice(requestContext)
  const data = await callNativeMusicu(
    'music.login.LoginServer',
    'CreateQRCode',
    {
      tmeAppID: 'qqmusic',
      ct: 11,
      cv: NATIVE_QR_CLIENT_VERSION
    },
    {
      device,
      requestContext,
      commOverrides: { ct: 23, cv: 0 }
    }
  )
  const qrcodeId = String(data?.qrcodeID || data?.qrcodeId || '').trim()
  const rawImage = String(data?.qrcode || data?.qrCode || '').trim()
  const encodedImage = rawImage.includes(',') ? rawImage.slice(rawImage.indexOf(',') + 1) : rawImage
  const image = Buffer.from(encodedImage.replace(/\s/g, ''), 'base64')
  if (!qrcodeId || !isPng(image)) throw new Error('QQ 音乐二维码数据无效')
  const requestedTtl = Number(data?.expiresIn || data?.expire || data?.expires || QR_TTL_MS / 1000)
  const expiresInSeconds = Math.min(
    QR_TTL_MS / 1000,
    Math.max(1, Math.floor(Number.isFinite(requestedTtl) ? requestedTtl : QR_TTL_MS / 1000))
  )
  return {
    qrcodeId,
    imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
    expiresInSeconds,
    device
  }
}

async function prepareNativeDevice(requestContext) {
  if (nativeDevicePreparation) return nativeDevicePreparation
  nativeDevicePreparation = (async () => {
    let device = await readNativeDevice()
    if (!device) device = createNativeDevice()
    if (!nativeQimeiIsFresh(device)) {
      const qimei = await requestNativeQimei(device, requestContext)
      device = { ...device, ...qimei, qimeiSavedAt: Date.now() }
    }
    const data = await callNativeMusicu(
      'music.getSession.session',
      'GetSession',
      { uid: device.sessionUid || '', vkey: 0, caller: 0 },
      { device, requestContext }
    )
    const session = data?.session && typeof data.session === 'object' ? data.session : data
    const sessionUid = String(session?.uid || session?.sessionUid || '').trim()
    const sessionSid = String(session?.sid || session?.sessionSid || '').trim()
    if (!sessionUid || !sessionSid) throw new Error('QQ 音乐设备会话初始化失败')
    device = {
      ...device,
      sessionUid,
      sessionSid,
      sessionVkey: String(session?.vkey || session?.sessionVkey || '').trim()
    }
    await saveNativeDevice(device)
    return device
  })().finally(() => {
    nativeDevicePreparation = null
  })
  return nativeDevicePreparation
}

async function callNativeMusicu(module, method, param, options = {}) {
  const device = options.device || (await readNativeDevice())
  if (!device) throw new Error('QQ 音乐设备会话不存在，请重新扫码登录')
  const credential = normalizeNativeCredential(options.credential)
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': nativeUserAgent(device),
    Referer: 'https://y.qq.com/',
    Origin: 'https://y.qq.com'
  }
  if (credential) headers.Cookie = buildNativeAuthCookie(credential.musicid, credential.musickey)
  const response = await fetchWithTimeout(
    NATIVE_MUSICU_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        comm: buildNativeComm(device, credential, options.commOverrides),
        req_0: {
          module,
          method,
          param
        }
      }),
      signal: requestSignal(options.requestContext)
    },
    REQUEST_TIMEOUT_MS
  )
  if (!response.ok) throw new Error(`QQ 音乐请求失败（HTTP ${response.status}）`)
  const payload = parseJsonp(await response.text())
  const item = payload?.req_0
  const requestCode = item?.code == null ? 0 : Number(item.code)
  const responseCode = payload?.code == null ? 0 : Number(payload.code)
  if (
    !item ||
    !Number.isFinite(requestCode) ||
    requestCode !== 0 ||
    !Number.isFinite(responseCode) ||
    responseCode !== 0
  ) {
    const code = Number.isFinite(requestCode) && requestCode !== 0 ? requestCode : responseCode
    if (credential && CREDENTIAL_REJECTION_CODES.has(code)) {
      await clearRejectedNativeAuth(credential)
      throw expiredAuthError()
    }
    throw new Error(`QQ 音乐业务错误 ${Number.isFinite(code) ? code : '未知'}`)
  }
  return item.data && typeof item.data === 'object' ? item.data : {}
}

function buildNativeComm(device, credential, overrides = {}) {
  const result = {
    ct: 11,
    cv: NATIVE_QR_CLIENT_VERSION,
    v: NATIVE_QR_CLIENT_VERSION,
    tmeAppID: 'qqmusic',
    chid: NATIVE_ANDROID_CHANNEL_ID,
    QIMEI: device.qimei,
    QIMEI36: device.qimei36,
    OpenUDID: device.openUdid,
    OpenUDID2: device.openUdid,
    udid: device.openUdid,
    aid: device.androidId,
    os_ver: device.osRelease,
    phonetype: device.model,
    devicelevel: String(device.sdk),
    newdevicelevel: String(device.sdk),
    rom: device.fingerprint,
    ...(device.sessionUid ? { uid: device.sessionUid } : {}),
    ...(device.sessionSid ? { sid: device.sessionSid } : {}),
    ...(credential
      ? {
          qq: credential.musicid,
          authst: credential.musickey,
          tmeLoginType: credential.loginType
        }
      : {}),
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  }
  return result
}

function nativeUserAgent(device) {
  return `QQMusic ${NATIVE_QR_CLIENT_VERSION}(android ${device?.osRelease || '10'})`
}

function nativeQimeiIsFresh(device) {
  const savedAt = Number(device?.qimeiSavedAt)
  return Boolean(
    device?.qimei &&
      device?.qimei36 &&
      Number.isFinite(savedAt) &&
      savedAt > 0 &&
      Date.now() - savedAt >= 0 &&
      Date.now() - savedAt < NATIVE_QIMEI_TTL_MS
  )
}

async function requestNativeQimei(device, requestContext) {
  const timestamp = Math.floor(Date.now() / 1000)
  const cryptKey = randomHex(16)
  const nonce = randomHex(16)
  const extra = JSON.stringify({ appKey: QIMEI_APP_KEY })
  const params = encryptNativeQimeiPayload(createNativeQimeiPayload(device), cryptKey)
  const key = publicEncrypt(
    { key: QIMEI_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(cryptKey, 'utf8')
  ).toString('base64')
  const body = {
    app: 0,
    os: 1,
    qimeiParams: {
      key,
      params,
      time: String(timestamp),
      nonce,
      sign: md5(key, params, String(timestamp * 1000), nonce, QIMEI_SECRET, extra),
      extra
    }
  }
  const response = await fetchWithTimeout(
    QIMEI_URL,
    {
      method: 'POST',
      headers: {
        Host: 'api.tencentmusic.com',
        method: 'GetQimei',
        service: 'trpc.tme_datasvr.qimeiproxy.QimeiProxy',
        appid: QIMEI_APP_ID,
        sign: md5(`${QIMEI_APP_ID}pzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH`, String(timestamp)),
        'User-Agent': 'QQMusic',
        timestamp: String(timestamp),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: requestSignal(requestContext)
    },
    REQUEST_TIMEOUT_MS
  )
  if (!response.ok) throw new Error(`QQ 音乐设备认证失败（HTTP ${response.status}）`)
  const outer = parseJsonp(await response.text())
  const nested = typeof outer?.data === 'string' ? parseJsonp(outer.data) : outer?.data || outer
  const data = nested?.data && typeof nested.data === 'object' ? nested.data : nested
  const qimei = String(data?.q16 || data?.qimei || '').trim()
  const qimei36 = String(data?.q36 || data?.qimei36 || '').trim()
  if (!qimei || !qimei36) throw new Error('QQ 音乐设备认证未返回有效标识')
  return { qimei, qimei36 }
}

function createNativeQimeiPayload(device) {
  const uptime = new Date(Date.now() - randomInt(14401) * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)
  return {
    androidId: device.androidId,
    platformId: 1,
    appKey: QIMEI_APP_KEY,
    appVersion: '14.9.0.8',
    beaconIdSrc: createNativeBeaconId(),
    brand: device.brand,
    channelId: NATIVE_ANDROID_CHANNEL_ID,
    cid: '',
    imei: device.imei,
    imsi: '',
    mac: '',
    model: device.model,
    networkType: 'unknown',
    oaid: '',
    osVersion: `Android ${device.osRelease},level ${device.sdk}`,
    qimei: '',
    qimei36: '',
    sdkVersion: '1.2.13.6',
    targetSdkVersion: '33',
    audit: '',
    userId: '{}',
    packageId: 'com.tencent.qqmusic',
    deviceType: 'Phone',
    sdkName: '',
    reserved: JSON.stringify({
      harmony: '0',
      clone: '0',
      containe: '',
      oz: 'UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=',
      oo: 'Xecjt+9S1+f8Pz2VLSxgpw==',
      kelong: '0',
      uptimes: uptime,
      multiUser: '0',
      bod: device.brand,
      dv: device.device,
      firstLevel: '',
      manufact: device.brand,
      name: device.model,
      host: 'se.infra',
      kernel: device.procVersion
    })
  }
}

function encryptNativeQimeiPayload(payload, cryptKey) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(cryptKey, 'utf8'), Buffer.from(cryptKey, 'utf8'))
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64')
}

function createNativeBeaconId() {
  const date = new Date().toISOString().slice(0, 7) + '-01'
  const timestampKeys = new Set([1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38])
  const first = randomDigits(6)
  const second = randomDigits(9)
  const fields = []
  for (let index = 1; index <= 40; index += 1) {
    if (index === 3) {
      fields.push(`k${index}:0000000000000000`)
    } else if (index === 4) {
      fields.push(`k${index}:${randomHex(16).replaceAll('0', '1')}`)
    } else if (timestampKeys.has(index)) {
      fields.push(`k${index}:${date}${first}.${second}`)
    } else {
      fields.push(`k${index}:${randomInt(10000)}`)
    }
  }
  return `${fields.join(';')};`
}

function createNativeDevice() {
  const buildNumber = randomDigits(7)
  return {
    version: 1,
    display: `QMAPI.${randomDigits(6)}.001`,
    product: 'iarim',
    device: 'sagit',
    board: 'eomam',
    model: 'MI 6',
    fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${buildNumber}:user/release-keys`,
    procVersion: `Linux 5.4.0-54-generic-${randomHex(8)} (android-build@google.com)`,
    imei: createNativeImei(),
    brand: 'Xiaomi',
    androidId: randomHex(16),
    openUdid: randomHex(32),
    osRelease: '10',
    sdk: 29,
    qimei: '',
    qimei36: '',
    qimeiSavedAt: 0,
    sessionUid: '',
    sessionSid: '',
    sessionVkey: ''
  }
}

function createNativeImei() {
  const base = randomDigits(14)
  let sum = 0
  for (let index = 0; index < base.length; index += 1) {
    let digit = Number(base[index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return `${base}${(10 - (sum % 10)) % 10}`
}

function randomHex(length) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function randomDigits(length) {
  let result = ''
  while (result.length < length) result += String(randomInt(10))
  return result
}

function randomInt(max) {
  return randomBytes(4).readUInt32BE(0) % Math.max(1, Math.floor(max))
}

function md5(...values) {
  return createHash('md5').update(values.join('')).digest('hex')
}

function startNativeQrListener(qrcodeId, onEvent, ttlMs, externalSignal) {
  const controller = new AbortController()
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal
  let socket = null
  let queue = null
  let keepalive = null
  let closed = false
  let closeReason = null
  let readySettled = false
  let resolveReady = null
  let rejectReady = null
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const finishReady = () => {
    if (readySettled) return
    readySettled = true
    resolveReady()
  }
  const failReady = (error) => {
    if (readySettled) return
    readySettled = true
    rejectReady(error)
  }
  const close = (reason = abortError()) => {
    if (closed) return
    closed = true
    closeReason = reason instanceof Error ? reason : abortError()
    controller.abort(closeReason)
    queue?.fail(closeReason)
    try {
      socket?.close()
    } catch {}
  }
  const onExternalAbort = () => close(externalSignal?.reason || abortError())
  externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true })

  const done = (async () => {
    try {
      const connection = await connectNativeQrMqtt(qrcodeId, signal)
      socket = connection.socket
      queue = connection.queue
      if (closed) return
      keepalive = setInterval(() => {
        try {
          socket?.send(Buffer.from([0xc0, 0x00]))
        } catch {
          close(new Error('QQ 音乐二维码连接已关闭'))
        }
      }, NATIVE_QR_MQTT_KEEPALIVE_MS)
      await subscribeNativeQrEvents(socket, queue, qrcodeId, signal)
      if (closed) return
      finishReady()
      onEvent({ type: 'waiting', payload: null })
      await consumeNativeQrEvents(queue, qrcodeId, ttlMs, onEvent)
      if (!closed) onEvent({ type: 'timeout', payload: null })
    } catch (error) {
      failReady(error)
      if (!closed) throw error
    } finally {
      clearInterval(keepalive)
      externalSignal?.removeEventListener?.('abort', onExternalAbort)
      try {
        socket?.close()
      } catch {}
    }
  })()

  return { ready, done, close }
}

async function connectNativeQrMqtt(qrcodeId, signal) {
  let endpoint = NATIVE_QR_MQTT_URL
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = await openNativeMqttConnection(endpoint, signal)
    connection.socket.send(createNativeMqttConnectPacket(qrcodeId))
    const packet = await connection.queue.next(NATIVE_QR_MQTT_TIMEOUT_MS)
    const connack = parseNativeMqttConnack(packet)
    if (connack.reasonCode === 0) return connection
    const redirected = nativeMqttRedirectUrl(connack.serverReference)
    try {
      connection.socket.close()
    } catch {}
    if (!redirected || attempt > 0 || ![0x9c, 0x9d].includes(connack.reasonCode)) {
      throw new Error(`QQ 音乐二维码连接被拒绝（MQTT ${connack.reasonCode}）`)
    }
    endpoint = redirected
  }
  throw new Error('QQ 音乐二维码连接失败')
}

function openNativeMqttConnection(endpoint, signal) {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.WebSocket !== 'function') {
      reject(new Error('当前插件运行环境不支持 QQ 音乐二维码连接'))
      return
    }
    if (signal?.aborted) {
      reject(signal.reason || abortError())
      return
    }
    let socket
    let opened = false
    let settled = false
    const queue = createNativeMqttQueue()
    const timeout = setTimeout(() => {
      failOpen(new Error('QQ 音乐二维码连接超时'))
    }, NATIVE_QR_MQTT_TIMEOUT_MS)
    const cleanupOpen = () => {
      clearTimeout(timeout)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const failOpen = (error) => {
      if (settled) return
      settled = true
      cleanupOpen()
      try {
        socket?.close()
      } catch {}
      reject(error)
    }
    const onAbort = () => failOpen(signal?.reason || abortError())
    try {
      socket = new globalThis.WebSocket(endpoint, 'mqtt')
    } catch {
      failOpen(new Error('QQ 音乐二维码连接无法建立'))
      return
    }
    if (signal?.aborted) {
      failOpen(signal.reason || abortError())
      return
    }
    socket.binaryType = 'arraybuffer'
    signal?.addEventListener?.('abort', onAbort, { once: true })
    socket.addEventListener('open', () => {
      if (settled) return
      opened = true
      settled = true
      cleanupOpen()
      resolve({ socket, queue })
    })
    socket.addEventListener('message', (event) => {
      void nativeMqttBuffer(event.data)
        .then((buffer) => {
          for (const packet of nativeMqttPackets(buffer)) queue.push(packet)
        })
        .catch(() => queue.fail(new Error('QQ 音乐二维码状态数据无效')))
    })
    socket.addEventListener('error', () => {
      const error = new Error('QQ 音乐二维码连接发生错误')
      queue.fail(error)
      if (!opened) failOpen(error)
    })
    socket.addEventListener('close', () => {
      const error = new Error('QQ 音乐二维码连接已关闭')
      queue.fail(error)
      if (!opened) failOpen(error)
    })
  })
}

async function subscribeNativeQrEvents(socket, queue, qrcodeId, signal) {
  if (signal?.aborted) throw signal.reason || abortError()
  socket.send(createNativeMqttSubscribePacket(qrcodeId))
  const packet = await queue.next(NATIVE_QR_MQTT_TIMEOUT_MS)
  const reasonCode = parseNativeMqttSuback(packet)
  if (reasonCode !== 0) throw new Error(`QQ 音乐二维码订阅被拒绝（MQTT ${reasonCode}）`)
}

async function consumeNativeQrEvents(queue, qrcodeId, ttlMs, onEvent) {
  const expiresAt = Date.now() + Math.max(1, ttlMs)
  while (Date.now() < expiresAt) {
    const packet = await queue.next(Math.max(1, expiresAt - Date.now()))
    const packetType = packet[0] >> 4
    if (packetType === 13) continue
    if (packetType !== 3) continue
    const event = parseNativeMqttPublish(packet)
    if (!event || event.topic !== `management.qrcode_login/${qrcodeId}`) continue
    onEvent(event)
  }
}

function handleNativeQrEvent(key, event) {
  const session = qrSessions.get(key)
  if (!session || ['success', 'failed', 'expired'].includes(session.state)) return
  const type = String(event?.type || '').trim().toLowerCase()
  if (['waiting', 'wait', 'created'].includes(type)) {
    session.state = 'waiting'
    return
  }
  if (['scanned', 'scan', 'scanning'].includes(type)) {
    session.state = 'scanned'
    return
  }
  if (['cookies', 'authorized', 'login', 'success'].includes(type)) {
    if (session.exchangePromise) return
    session.state = 'exchanging'
    session.exchangePromise = completeNativeQrLogin(session, event?.payload)
      .then(() => {
        if (qrSessions.get(key) !== session) return
        session.state = 'success'
        session.listener?.close()
      })
      .catch((error) => handleNativeQrExchangeFailure(key, error))
    return
  }
  if (['expired', 'timeout', 'cancel', 'canceled', 'failed', 'loginfailed', 'error'].includes(type)) {
    session.state = 'expired'
    session.listener?.close()
  }
}

async function completeNativeQrLogin(session, payload) {
  const credentials = extractNativeQrCredentials(payload)
  const exchanged = await callNativeMusicu(
    'music.login.LoginServer',
    'Login',
    {
      musicid: Number(credentials.uin),
      qrCodeID: session.qrcodeId,
      token: credentials.musicKey
    },
    {
      device: session.device,
      commOverrides: { tmeLoginType: 6 }
    }
  )
  const credential = normalizeNativeCredential({
    musicid:
      findNestedValue(exchanged, ['musicid', 'str_musicid', 'uin', 'qqmusic_uin']) || credentials.uin,
    musickey: findNestedValue(exchanged, ['musickey', 'qqmusic_key', 'qm_keyst']),
    loginType: findNestedValue(exchanged, ['loginType', 'tmeLoginType']) || 6,
    encryptUin: findNestedValue(exchanged, ['encryptUin', 'encrypt_uin'])
  })
  if (!credential) throw new Error('QQ 音乐扫码未建立有效登录会话')
  const profileData = await callNativeMusicu(
    'music.UserInfo.userInfoServer',
    'GetLoginUserInfo',
    {},
    { device: session.device, credential }
  )
  const profile = mapNativeProfile(profileData, credential.musicid)
  const auth = {
    version: 2,
    uin: credential.musicid,
    credential,
    profile,
    updatedAt: new Date().toISOString()
  }
  if (qrSessions.get(session.key) !== session) throw abortError()
  await requireContext().settings.set(AUTH_KEY, auth)
  loginCache = {
    cookie: buildNativeAuthCookie(credential.musicid, credential.musickey),
    profile,
    expiresAt: Date.now() + LOGIN_CACHE_TTL_MS
  }
}

function extractNativeQrCredentials(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const cookies = source.cookies && typeof source.cookies === 'object' ? source.cookies : {}
  const uin = normalizeUin(
    nativeCredentialValue(cookies.qqmusic_uin) ||
      nativeCredentialValue(cookies.uin) ||
      nativeCredentialValue(source.qqmusic_uin) ||
      nativeCredentialValue(source.uin)
  )
  const musicKey =
    nativeCredentialValue(cookies.qqmusic_key) ||
    nativeCredentialValue(cookies.qm_keyst) ||
    nativeCredentialValue(source.qqmusic_key) ||
    nativeCredentialValue(source.qm_keyst)
  if (!uin || !musicKey) throw new Error('QQ 音乐扫码返回的登录凭据无效')
  return { uin, musicKey }
}

function nativeCredentialValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (value && typeof value === 'object' && (typeof value.value === 'string' || typeof value.value === 'number')) {
    return String(value.value).trim()
  }
  return ''
}

function buildNativeAuthCookie(uin, musicKey) {
  const key = String(musicKey || '').trim()
  if (!normalizeUin(uin) || !key || /[;\r\n]/.test(key)) {
    throw new Error('QQ 音乐扫码返回的登录凭据无效')
  }
  return `uin=${uin}; qqmusic_uin=${uin}; qqmusic_key=${key}; qm_keyst=${key}`
}

function handleNativeQrExchangeFailure(key, error) {
  const session = qrSessions.get(key)
  if (!session) return
  session.state = 'failed'
  session.errorMessage = 'QQ 音乐已确认扫码，但登录会话未建立，请刷新二维码后重试'
  logWarn(`QQ native QR exchange failed: ${safeErrorMessage(error)}`)
  session.listener?.close()
}

function handleNativeQrListenerFailure(key, error) {
  const session = qrSessions.get(key)
  if (!session || ['success', 'failed', 'expired'].includes(session.state)) return
  session.state = 'failed'
  session.errorMessage = 'QQ 音乐二维码状态检查失败，请刷新二维码后重试'
  logWarn(`QQ native QR listener failed: ${safeErrorMessage(error)}`)
}

function clearQrSessions() {
  for (const session of qrSessions.values()) session.listener?.close()
  qrSessions.clear()
}

function closeQrSession(key) {
  const session = qrSessions.get(key)
  session?.listener?.close()
  qrSessions.delete(key)
}

function createNativeMqttConnectPacket(qrcodeId) {
  const suffix = (randomBytes(2).readUInt16BE(0) % 10000).toString().padStart(4, '0')
  const clientId = `${Date.now()}${suffix}`
  const properties = nativeMqttPropertyBlock([
    nativeMqttTextProperty(0x15, 'pass'),
    nativeMqttUserProperty('tmeAppID', 'qqmusic'),
    nativeMqttUserProperty('business', 'management'),
    nativeMqttUserProperty('hashTag', qrcodeId),
    nativeMqttUserProperty('clientTag', 'management.user'),
    nativeMqttUserProperty('userID', qrcodeId)
  ])
  const header = Buffer.concat([
    nativeMqttText('MQTT'),
    Buffer.from([5, 0x02, 0, 45]),
    properties,
    nativeMqttText(clientId)
  ])
  return nativeMqttPacket(0x10, header)
}

function createNativeMqttSubscribePacket(qrcodeId) {
  const topic = `management.qrcode_login/${qrcodeId}`
  const properties = nativeMqttPropertyBlock([
    nativeMqttUserProperty('authorization', 'tmelogin'),
    nativeMqttUserProperty('pubsub', 'unicast')
  ])
  return nativeMqttPacket(
    0x82,
    Buffer.concat([Buffer.from([0, 1]), properties, nativeMqttText(topic), Buffer.from([0])])
  )
}

function nativeMqttPacket(type, body) {
  return Buffer.concat([Buffer.from([type]), nativeMqttVarInt(body.length), body])
}

function nativeMqttVarInt(value) {
  const bytes = []
  let remaining = Number(value)
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function nativeMqttText(value) {
  const bytes = Buffer.from(String(value), 'utf8')
  if (bytes.length > 0xffff) throw new Error('QQ 音乐二维码协议字段过长')
  return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes])
}

function nativeMqttTextProperty(id, value) {
  return Buffer.concat([Buffer.from([id]), nativeMqttText(value)])
}

function nativeMqttUserProperty(key, value) {
  return Buffer.concat([Buffer.from([0x26]), nativeMqttText(key), nativeMqttText(value)])
}

function nativeMqttPropertyBlock(properties) {
  const body = Buffer.concat(properties)
  return Buffer.concat([nativeMqttVarInt(body.length), body])
}

function parseNativeMqttConnack(packet) {
  if ((packet[0] >> 4) !== 2) throw new Error('QQ 音乐二维码连接响应无效')
  const remaining = nativeMqttReadVarInt(packet, 1)
  const offset = remaining.offset
  if (packet.length < offset + 3) throw new Error('QQ 音乐二维码连接响应无效')
  const properties = nativeMqttReadProperties(packet, offset + 2)
  return { reasonCode: packet[offset + 1], serverReference: properties.serverReference }
}

function parseNativeMqttSuback(packet) {
  if ((packet[0] >> 4) !== 9) throw new Error('QQ 音乐二维码订阅响应无效')
  const remaining = nativeMqttReadVarInt(packet, 1)
  const offset = remaining.offset
  if (packet.length < offset + 4) throw new Error('QQ 音乐二维码订阅响应无效')
  const properties = nativeMqttReadProperties(packet, offset + 2)
  if (properties.offset >= packet.length) throw new Error('QQ 音乐二维码订阅响应无效')
  return packet[properties.offset]
}

function parseNativeMqttPublish(packet) {
  if ((packet[0] >> 4) !== 3) return null
  const remaining = nativeMqttReadVarInt(packet, 1)
  let offset = remaining.offset
  const topic = nativeMqttReadText(packet, offset)
  offset = topic.offset
  const qos = (packet[0] >> 1) & 0x03
  if (qos > 0) {
    if (packet.length < offset + 2) throw new Error('QQ 音乐二维码状态数据无效')
    offset += 2
  }
  const properties = nativeMqttReadProperties(packet, offset)
  const payloadText = packet.subarray(properties.offset).toString('utf8')
  let payload = {}
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText)
    } catch {
      throw new Error('QQ 音乐二维码状态数据无效')
    }
  }
  const type =
    properties.userProperties.type ||
    (payload && typeof payload === 'object'
      ? payload.type || payload.event || payload.status || payload.messageType
      : '')
  return { topic: topic.value, type: String(type || ''), payload }
}

function nativeMqttReadVarInt(buffer, start) {
  let value = 0
  let multiplier = 1
  let offset = start
  for (let count = 0; count < 4; count += 1) {
    if (offset >= buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
    const byte = buffer[offset]
    offset += 1
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return { value, offset }
    multiplier *= 128
  }
  throw new Error('QQ 音乐二维码协议数据无效')
}

function nativeMqttPackets(buffer) {
  const packets = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + 1 >= buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
    const remaining = nativeMqttReadVarInt(buffer, offset + 1)
    const end = remaining.offset + remaining.value
    if (end > buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
    packets.push(buffer.subarray(offset, end))
    offset = end
  }
  return packets
}

function nativeMqttReadText(buffer, start) {
  if (start + 2 > buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
  const length = buffer.readUInt16BE(start)
  const offset = start + 2
  if (offset + length > buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
  return { value: buffer.subarray(offset, offset + length).toString('utf8'), offset: offset + length }
}

function nativeMqttReadProperties(buffer, start) {
  const lengthInfo = nativeMqttReadVarInt(buffer, start)
  let offset = lengthInfo.offset
  const end = offset + lengthInfo.value
  if (end > buffer.length) throw new Error('QQ 音乐二维码协议数据不完整')
  const result = { offset: end, serverReference: '', userProperties: {} }
  while (offset < end) {
    const id = buffer[offset]
    offset += 1
    if (id === 0x26) {
      const key = nativeMqttReadText(buffer, offset)
      const value = nativeMqttReadText(buffer, key.offset)
      result.userProperties[key.value] = value.value
      offset = value.offset
      continue
    }
    if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) {
      const value = nativeMqttReadText(buffer, offset)
      if (id === 0x1c) result.serverReference = value.value
      offset = value.offset
      continue
    }
    if ([0x09, 0x16].includes(id)) {
      const value = nativeMqttReadText(buffer, offset)
      offset = value.offset
      continue
    }
    if ([0x02, 0x11, 0x18, 0x27].includes(id)) {
      offset += 4
    } else if ([0x13, 0x21, 0x22, 0x23].includes(id)) {
      offset += 2
    } else if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) {
      offset += 1
    } else if (id === 0x0b) {
      offset = nativeMqttReadVarInt(buffer, offset).offset
    } else {
      throw new Error('QQ 音乐二维码协议属性无效')
    }
    if (offset > end) throw new Error('QQ 音乐二维码协议数据不完整')
  }
  return result
}

function nativeMqttRedirectUrl(value) {
  const reference = String(value || '').trim()
  if (!reference) return ''
  if (/^wss?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference)
      return url.protocol === 'wss:' || url.protocol === 'ws:' ? url.href : ''
    } catch {
      return ''
    }
  }
  if (!/^[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(reference)) return ''
  return `wss://${reference}`
}

function createNativeMqttQueue() {
  const packets = []
  const waiters = []
  let failure = null
  return {
    push(packet) {
      if (failure) return
      const waiter = waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timeout)
        waiter.resolve(packet)
      } else {
        packets.push(packet)
      }
    },
    fail(error) {
      if (failure) return
      failure = error instanceof Error ? error : new Error('QQ 音乐二维码连接失败')
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout)
        waiter.reject(failure)
      }
    },
    next(timeoutMs) {
      if (packets.length) return Promise.resolve(packets.shift())
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timeout: null }
        waiter.timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('QQ 音乐二维码状态等待超时'))
        }, Math.max(1, Number(timeoutMs) || NATIVE_QR_MQTT_TIMEOUT_MS))
        waiters.push(waiter)
      })
    }
  }
}

async function nativeMqttBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value && typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer())
  throw new Error('QQ 音乐二维码状态数据无效')
}

function isPng(value) {
  return (
    Buffer.isBuffer(value) &&
    value.length >= 8 &&
    value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
}

async function searchSongs(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await fetchJson(
    buildUrl('https://c.y.qq.com', '/soso/fcgi-bin/client_search_cp', {
      format: 'json',
      outCharset: 'utf-8',
      ct: 24,
      qqmusic_ver: 1298,
      remoteplace: 'txt.yqq.song',
      t: 0,
      aggr: 1,
      cr: 1,
      lossless: 0,
      flag_qc: 0,
      platform: 'yqq.json',
      w: String(keywords || '').trim(),
      n: pageSize,
      p: page
    }),
    { signal: requestSignal(requestContext) },
    requestContext
  )
  const songData = payload?.data?.song || payload?.song || {}
  const rawItems = firstArray(songData.list, payload?.data?.songlist, payload?.songlist)
  const items = rawItems.map(mapTrack).filter(Boolean)
  return {
    items,
    total: normalizeCount(songData.totalnum ?? songData.total ?? payload?.data?.totalnum)
  }
}

async function searchPlaylists(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await fetchJson(
    buildUrl('https://c.y.qq.com', '/soso/fcgi-bin/client_search_cp', {
      format: 'json',
      outCharset: 'utf-8',
      ct: 24,
      remoteplace: 'txt.yqq.playlist',
      t: 0,
      aggr: 1,
      cr: 1,
      platform: 'yqq.json',
      w: String(keywords || '').trim(),
      n: pageSize,
      p: page
    }),
    { signal: requestSignal(requestContext) },
    requestContext
  )
  const playlistData = payload?.data?.playlist || payload?.playlist || {}
  const rawItems = firstArray(playlistData.list, payload?.data?.playlistlist)
  return {
    items: rawItems.map(mapPlaylist).filter(Boolean),
    total: normalizeCount(playlistData.totalnum ?? playlistData.total)
  }
}

async function searchArtists(keywords, limit = 30, offset = 0, requestContext) {
  await assertConsent()
  const pageSize = normalizeLimit(limit)
  const page = Math.floor(Math.max(0, Number(offset) || 0) / pageSize) + 1
  const payload = await fetchJson(
    buildUrl('https://c.y.qq.com', '/soso/fcgi-bin/client_search_cp', {
      format: 'json',
      outCharset: 'utf-8',
      ct: 24,
      remoteplace: 'txt.yqq.singer',
      t: 0,
      aggr: 1,
      cr: 1,
      platform: 'yqq.json',
      w: String(keywords || '').trim(),
      n: pageSize,
      p: page
    }),
    { signal: requestSignal(requestContext) },
    requestContext
  )
  const singerData = payload?.data?.singer || payload?.data?.zhida || payload?.singer || {}
  const rawItems = firstArray(singerData.list, singerData.singerlist)
  return {
    items: rawItems.map(mapArtist).filter(Boolean),
    total: normalizeCount(singerData.totalnum ?? singerData.total)
  }
}

async function fetchRecommendSongs(requestContext) {
  await assertConsent()
  const payload = await fetchPublicMusicu(
    {
      new_song: {
        module: 'newsong.NewSongServer',
        method: 'get_new_song_info',
        param: { type: 5 }
      }
    },
    requestContext
  )
  const data = publicMusicuData(payload, 'new_song')
  return firstArray(data.songlist).map(mapTrack).filter(Boolean)
}

async function fetchRecommendPlaylists(requestContext) {
  await assertConsent()
  const payload = await fetchPublicMusicu(
    {
      recomPlaylist: {
        module: 'playlist.HotRecommendServer',
        method: 'get_hot_recommend',
        param: { async: 1, cmd: 2 }
      },
      playlist: {
        module: 'playlist.PlayListPlazaServer',
        method: 'get_playlist_by_category',
        param: { id: 8, curPage: 1, size: 20, order: 5, titleid: 8 }
      }
    },
    requestContext
  )
  const hot = firstArray(publicMusicuData(payload, 'recomPlaylist').v_hot)
  const category = firstArray(publicMusicuData(payload, 'playlist').v_playlist)
  return uniquePlaylists([...hot, ...category].map(mapPlaylist).filter(Boolean))
}

async function fetchPlaylistCategories(requestContext) {
  await assertConsent()
  const payload = await fetchJson(
    buildUrl('https://c.y.qq.com', '/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', {
      format: 'json',
      outCharset: 'utf-8'
    }),
    {
      headers: { Referer: QQ_PUBLIC_REFERER },
      signal: requestSignal(requestContext)
    },
    requestContext
  )
  const sourceGroups = firstArray(payload?.data?.categories)
  resetPlaylistCategoryIds()
  const groups = sourceGroups
    .map((group, index) => {
      const groupName = String(group?.categoryGroupName || '').trim()
      const tags = firstArray(group?.items)
        .map((item) => {
          const name = String(item?.categoryName || '').trim()
          const id = Number(item?.categoryId)
          if (!name || !Number.isFinite(id)) return null
          playlistCategoryIds.set(name, id)
          return { name, hot: groupName === '热门' }
        })
        .filter(Boolean)
      return tags.length ? { id: index, name: groupName || `分类 ${index + 1}`, tags } : null
    })
    .filter(Boolean)
  const hotTags = groups
    .filter((group) => group.name === '热门')
    .flatMap((group) => group.tags.map((tag) => tag.name))
  return { hotTags: hotTags.length ? hotTags : ['全部'], groups }
}

async function fetchDiscoveryPlaylists(
  cat = '全部',
  order = 'hot',
  limit = 30,
  offset = 0,
  requestContext
) {
  await assertConsent()
  const categoryName = String(cat || '全部').trim() || '全部'
  if (!playlistCategoryIds.has(categoryName)) await fetchPlaylistCategories(requestContext)
  const categoryId = playlistCategoryIds.get(categoryName)
  if (categoryId === undefined) throw new Error(`QQ 音乐歌单分类不存在：${categoryName}`)
  const pageSize = Math.min(60, Math.max(1, Math.floor(Number(limit) || 30)))
  const normalizedOffset = Math.max(0, Math.floor(Number(offset) || 0))
  const payload = await fetchJson(
    buildUrl('https://c.y.qq.com', '/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
      format: 'json',
      outCharset: 'utf-8',
      picmid: 1,
      categoryId,
      sortId: order === 'new' ? 2 : 3,
      sin: normalizedOffset,
      ein: normalizedOffset + pageSize - 1
    }),
    {
      headers: { Referer: QQ_PUBLIC_REFERER },
      signal: requestSignal(requestContext)
    },
    requestContext
  )
  const items = firstArray(payload?.data?.list).map(mapPlaylist).filter(Boolean)
  const total = normalizeCount(payload?.data?.sum)
  return {
    items,
    total,
    hasMore: normalizedOffset + items.length < total,
    offset: normalizedOffset,
    limit: pageSize
  }
}

async function fetchPublicMusicu(requests, requestContext) {
  return fetchJson(
    buildUrl('https://u.y.qq.com', '/cgi-bin/musicu.fcg', {
      format: 'json',
      data: JSON.stringify({ comm: { ct: 24 }, ...requests })
    }),
    {
      headers: { Referer: QQ_MUSICU_REFERER },
      signal: requestSignal(requestContext)
    },
    requestContext
  )
}

function publicMusicuData(payload, key) {
  const response = payload?.[key]
  if (!response || typeof response !== 'object') throw new Error(`QQ 音乐 ${key} 响应缺失`)
  if (typeof response.code === 'number' && response.code !== 0) {
    throw new Error(`QQ 音乐 ${key} 业务错误 ${response.code}`)
  }
  return response.data && typeof response.data === 'object' ? response.data : {}
}

async function fetchUserLibrary(force = false, requestContext) {
  await assertConsent()
  const auth = await requireAuth()
  const [libraryData, profileData] = await Promise.all([
    callNativeMusicu(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin: auth.uin },
      { device: auth.device, credential: auth.credential, requestContext }
    ),
    callNativeMusicu(
      'music.UserInfo.userInfoServer',
      'GetLoginUserInfo',
      {},
      { device: auth.device, credential: auth.credential, requestContext }
    )
  ])
  const profile = mapNativeProfile(profileData, auth.uin)
  const rawPlaylists = extractNativePlaylistItems(libraryData)
  const mapped = rawPlaylists.map((item) => mapPlaylist(item, profile.nickname)).filter(Boolean)
  const favoriteMetadata = mapped.find((playlist) => isLikedPlaylist(playlist))
  const likedPlaylist = {
    id: 'liked',
    name: favoriteMetadata?.name || '我喜欢',
    cover: favoriteMetadata?.cover || null,
    trackCount: favoriteMetadata?.trackCount || 0,
    creatorName: profile.nickname,
    owned: true,
    qqType: 1
  }
  const playlists = [likedPlaylist, ...mapped.filter((playlist) => !isLikedPlaylist(playlist))]
  if (profile) {
    loginCache = { cookie: auth.cookie, profile, expiresAt: Date.now() + LOGIN_CACHE_TTL_MS }
  }
  if (force) {
    for (const playlist of playlists) playlistCache.delete(String(playlist.id))
  }
  return { likedPlaylist, playlists }
}

async function fetchPlaylistTracks(playlistId, force = false, requestContext) {
  await assertConsent()
  const id = normalizePlaylistId(playlistId)
  const cached = playlistCache.get(id)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.tracks
  const auth = await readAuth()
  if (!auth && id !== 'liked') {
    const payload = await fetchJson(
      buildUrl('https://c.y.qq.com', '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
        format: 'json',
        outCharset: 'utf-8',
        type: 1,
        json: 1,
        utf8: 1,
        onlysong: 0,
        new_format: 1,
        disstid: id
      }),
      {
        headers: { Referer: `https://y.qq.com/n/ryqq/playlist/${id}` },
        signal: requestSignal(requestContext)
      },
      requestContext
    )
    let tracks = extractNativePlaylistTracks(payload).map(mapTrack).filter(Boolean)
    if (!tracks.length) tracks = await fetchPublicPlaylistTracks(id, requestContext)
    playlistCache.set(id, { tracks, expiresAt: Date.now() + PLAYLIST_CACHE_TTL_MS })
    return tracks
  }
  if (!auth) await requireAuth()
  const param =
    id === 'liked'
      ? {
          disstid: 0,
          dirid: 201,
          tag: true,
          song_begin: 0,
          song_num: 100,
          userinfo: true,
          orderlist: true,
          enc_host_uin: auth.credential.encryptUin || ''
        }
      : {
          disstid: Number(id),
          song_begin: 0,
          song_num: 100,
          tag: true,
          userinfo: true
        }
  const payload = await callNativeMusicu(
    'music.srfDissInfo.DissInfo',
    'CgiGetDiss',
    param,
    { device: auth.device, credential: auth.credential, requestContext }
  )
  const list = extractNativePlaylistTracks(payload)
  const tracks = list.map(mapTrack).filter(Boolean)
  playlistCache.set(id, { tracks, expiresAt: Date.now() + PLAYLIST_CACHE_TTL_MS })
  return tracks
}

async function fetchPublicPlaylistTracks(id, requestContext) {
  const payload = await fetchJson(
    NATIVE_MUSICU_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: QQ_MUSICU_REFERER,
        Origin: 'https://y.qq.com'
      },
      body: JSON.stringify({
        req_0: {
          module: 'music.srfDissInfo.DissInfo',
          method: 'CgiGetDiss',
          param: {
            disstid: Number(id),
            song_begin: 0,
            song_num: 100,
            tag: true,
            userinfo: true
          }
        },
        comm: { ct: 24, cv: 0, format: 'json', uin: 0 }
      }),
      signal: requestSignal(requestContext)
    },
    requestContext
  )
  const data = publicMusicuData(payload, 'req_0')
  return extractNativePlaylistTracks(data).map(mapTrack).filter(Boolean)
}

async function getLyrics(track, requestContext) {
  await assertConsent()
  const songmid = trackSongmid(track)
  if (!songmid) return { lyrics: null, translatedLyrics: null, wordLyrics: null }
  const auth = await readAuth()
  const songid = trackSongId(track)
  let primary = null
  try {
    primary = await fetchJson(
      buildUrl('https://c.y.qq.com', '/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        format: 'json',
        nobase64: 1,
        songmid,
        songid: songid || 0,
        g_tk: 0,
        loginUin: auth?.uin || 0,
        hostUin: 0,
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 0,
        inCharset: 'utf-8',
        outCharset: 'utf-8'
      }),
      { headers: auth ? { Cookie: auth.cookie } : {}, signal: requestSignal(requestContext) },
      requestContext
    )
  } catch (error) {
    if (requestSignal(requestContext)?.aborted || error?.name === 'AbortError') throw error
    logWarn(`QQ lyric primary request failed: ${safeErrorMessage(error)}`)
  }
  let normalized = normalizeLyrics(primary?.data || primary?.response || primary)
  if (!normalized.lyrics) {
    try {
      const fallback = await fetchJson(
        'https://u.y.qq.com/cgi-bin/musicu.fcg',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com/portal/player.html',
            Origin: 'https://y.qq.com',
            ...(auth ? { Cookie: auth.cookie } : {})
          },
          body: JSON.stringify({
            req_0: {
              module: 'music.musichallSong.PlayLyricInfo',
              method: 'GetPlayLyricInfo',
              param: {
                songMID: songmid,
                songID: Number(songid || 0),
                trans_t: 0,
                roma_t: 0,
                qrc_t: 0,
                crypt: 2,
                lrc_t: 0,
                interval: 0
              }
            },
            loginUin: auth?.uin || '',
            comm: { ct: 24, cv: 0, format: 'json', uin: auth?.uin || 0 }
          }),
          signal: requestSignal(requestContext)
        },
        requestContext
      )
      normalized = normalizeLyrics(fallback?.req_0?.data || fallback?.PlayLyricInfo?.data || fallback)
    } catch (error) {
      if (requestSignal(requestContext)?.aborted || error?.name === 'AbortError') throw error
      logWarn(`QQ lyric fallback request failed: ${safeErrorMessage(error)}`)
    }
  }
  return normalized
}

async function getPlaybackUrl(track, options = {}, requestContext) {
  await assertConsent()
  const auth = await requireAuth()
  const songmid = trackSongmid(track)
  if (!songmid) return null
  const mediaMid = trackMediaMid(track) || songmid
  const qualities = qualityLadder(options?.quality)
  for (const quality of qualities) {
    let directUrl = ''
    try {
      directUrl = await resolveDirectUrl(songmid, mediaMid, quality, auth, requestContext)
    } catch (error) {
      if (requestSignal(requestContext)?.aborted || error?.name === 'AbortError') throw error
      if (error?.name === 'QQMusicAuthExpiredError') throw error
      logWarn(`QQ playback quality ${quality} failed: ${safeErrorMessage(error)}`)
    }
    if (!directUrl) continue
    const proxyUrl = await createStreamToken({ songmid, mediaMid, quality, directUrl })
    return proxyUrl
  }
  return null
}

async function resolveDirectUrl(songmid, mediaMid, quality, auth, requestContext) {
  const definition = QUALITY_DEFINITIONS[quality]
  if (!definition) return ''
  const guid = randomDigits(10)
  const filename = `${definition.prefix}${songmid}${mediaMid || songmid}${definition.suffix}`
  const data = await callNativeMusicu(
    'music.vkey.GetVkey',
    'UrlGetVkey',
    {
      filename: [filename],
      guid,
      songmid: [songmid],
      songtype: [0],
      uin: auth.uin,
      ctx: 0
    },
    { device: auth.device, credential: auth.credential, requestContext }
  )
  const domain = pickPlayableDomain(data.sip) || DEFAULT_PLAYABLE_DOMAIN
  const midurlinfo = firstArray(data.midurlinfo, data.midUrlInfo, data.midurl_info)
  const info = midurlinfo.length
    ? midurlinfo.find((item) => String(item?.songmid || '') === songmid) || midurlinfo[0]
    : null
  if (info?.purl) return normalizeHttpUrl(joinUrl(domain, info.purl))
  if (info?.vkey && info?.filename) {
    const baseUrl = joinUrl(domain, String(info.filename))
    if (!baseUrl) return ''
    const separator = baseUrl.includes('?') ? '&' : '?'
    return normalizeHttpUrl(
      `${baseUrl}${separator}vkey=${encodeURIComponent(String(info.vkey))}&guid=${encodeURIComponent(guid)}&fromtag=66`
    )
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
  streamTokens.set(token, { ...entry, expiresAt: Date.now() + STREAM_TOKEN_TTL_MS })
  return `http://127.0.0.1:${proxyPort}/qqmusic/stream/${token}`
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
        reject(new Error('QQ 音乐本机代理启动失败'))
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
  const token = url.pathname.startsWith('/qqmusic/stream/')
    ? url.pathname.slice('/qqmusic/stream/'.length)
    : ''
  const entry = streamTokens.get(token)
  if (!entry || entry.expiresAt <= Date.now()) {
    streamTokens.delete(token)
    response.writeHead(404)
    response.end('QQ 音乐播放令牌无效或已过期')
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
    let auth = await readAuth()
    if (!auth) throw new Error('QQ 音乐登录态已失效，请重新扫码登录')
    let upstream = await fetchStream(entry.directUrl, request, auth, controller.signal)
    if ([401, 403, 404].includes(upstream.status)) {
      const refreshedUrl = await resolveDirectUrl(entry.songmid, entry.mediaMid, entry.quality, auth, {
        signal: controller.signal
      })
      if (refreshedUrl) {
        entry.directUrl = refreshedUrl
        upstream = await fetchStream(refreshedUrl, request, auth, controller.signal)
      }
    }
    if (!upstream.ok) {
      response.writeHead(upstream.status || 502)
      response.end('QQ 音乐上游播放请求失败')
      return
    }
    const headers = copyStreamHeaders(upstream.headers)
    response.writeHead(upstream.status, headers)
    if (request.method === 'HEAD' || !upstream.body) {
      response.end()
      return
    }
    for await (const chunk of upstream.body) {
      if (response.destroyed) break
      response.write(Buffer.from(chunk))
    }
    response.end()
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(error?.name === 'AbortError' ? 499 : 502)
      response.end(safeErrorMessage(error))
    } else if (!response.destroyed) {
      response.destroy()
    }
  } finally {
    finished = true
  }
}

async function fetchStream(url, request, auth, signal) {
  const range = request.headers.range
  const headers = {
    Accept: '*/*',
    Referer: 'https://y.qq.com/',
    'User-Agent': nativeUserAgent(auth.device),
    Cookie: auth.cookie
  }
  if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers.Range = range
  return fetchWithTimeout(
    url,
    { headers, signal },
    STREAM_HEADER_TIMEOUT_MS
  )
}

function copyStreamHeaders(headers) {
  const allowed = [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified'
  ]
  const result = {}
  for (const name of allowed) {
    const value = headers.get(name)
    if (value) result[name] = value
  }
  return result
}

async function requireAuth() {
  const auth = await readAuth()
  if (!auth) throw new Error('QQ 音乐需要重新扫码登录以建立可用会话')
  return auth
}

async function readAuth() {
  const value = await requireContext().settings.get(AUTH_KEY)
  if (!value || typeof value !== 'object') return null
  const credential = normalizeNativeCredential(value.credential)
  const device = await readNativeDevice()
  if (!credential || !device || !device.qimei || !device.qimei36 || !device.sessionUid || !device.sessionSid) {
    return null
  }
  const uin = credential.musicid
  return {
    cookie: buildNativeAuthCookie(credential.musicid, credential.musickey),
    uin,
    credential,
    device,
    profile: sanitizeProfile(value.profile, uin),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
  }
}

async function readNativeDevice() {
  return normalizeNativeDevice(await requireContext().settings.get(DEVICE_KEY))
}

async function saveNativeDevice(value) {
  const device = normalizeNativeDevice(value)
  if (!device) throw new Error('QQ 音乐设备会话数据无效')
  await requireContext().settings.set(DEVICE_KEY, device)
}

async function clearRejectedNativeAuth(credential) {
  const context = requireContext()
  const stored = await context.settings.get(AUTH_KEY)
  const storedCredential = normalizeNativeCredential(stored?.credential)
  if (
    !storedCredential ||
    storedCredential.musicid !== credential.musicid ||
    storedCredential.musickey !== credential.musickey
  ) {
    return
  }
  await context.settings.delete(AUTH_KEY)
  await context.settings.delete(DEVICE_KEY)
  loginCache = null
  streamTokens.clear()
  playlistCache.clear()
}

function normalizeNativeCredential(value) {
  if (!value || typeof value !== 'object') return null
  const musicid = normalizeUin(value.musicid || value.str_musicid || value.uin)
  const musickey = nativeCredentialValue(value.musickey || value.qqmusic_key || value.qm_keyst)
  if (!musicid || !musickey || /[;\r\n]/.test(musickey)) return null
  const requestedLoginType = Number(value.loginType || value.tmeLoginType || 6)
  const loginType = Number.isFinite(requestedLoginType) && requestedLoginType > 0 ? requestedLoginType : 6
  const encryptUin = nativeDeviceText(value.encryptUin || value.encrypt_uin, 512)
  return {
    musicid,
    str_musicid: musicid,
    musickey,
    loginType,
    ...(encryptUin ? { encryptUin } : {})
  }
}

function normalizeNativeDevice(value) {
  if (!value || typeof value !== 'object') return null
  const device = {
    version: 1,
    display: nativeDeviceText(value.display, 80),
    product: nativeDeviceText(value.product, 80),
    device: nativeDeviceText(value.device, 80),
    board: nativeDeviceText(value.board, 80),
    model: nativeDeviceText(value.model, 120),
    fingerprint: nativeDeviceText(value.fingerprint, 300),
    procVersion: nativeDeviceText(value.procVersion, 300),
    imei: nativeDeviceText(value.imei, 32),
    brand: nativeDeviceText(value.brand, 80),
    androidId: nativeDeviceText(value.androidId, 80),
    openUdid: nativeDeviceText(value.openUdid, 128),
    osRelease: nativeDeviceText(value.osRelease, 32),
    sdk: Number(value.sdk),
    qimei: nativeDeviceText(value.qimei, 256),
    qimei36: nativeDeviceText(value.qimei36, 256),
    qimeiSavedAt: Number(value.qimeiSavedAt),
    sessionUid: nativeDeviceText(value.sessionUid, 256),
    sessionSid: nativeDeviceText(value.sessionSid, 256),
    sessionVkey: nativeDeviceText(value.sessionVkey, 256)
  }
  const required = [
    device.display,
    device.product,
    device.device,
    device.board,
    device.model,
    device.fingerprint,
    device.procVersion,
    device.imei,
    device.brand,
    device.androidId,
    device.openUdid,
    device.osRelease
  ]
  if (
    required.some((entry) => !entry) ||
    !Number.isInteger(device.sdk) ||
    device.sdk < 1 ||
    (!Number.isFinite(device.qimeiSavedAt) && device.qimeiSavedAt !== 0)
  ) {
    return null
  }
  return device
}

function nativeDeviceText(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value).trim()
  return text && text.length <= maxLength && !/[\r\n]/.test(text) ? text : ''
}

async function assertConsent() {
  if (!(await hasConsent())) throw new Error(CONSENT_ERROR)
}

async function hasConsent() {
  const value = await requireContext().settings.get(CONSENT_KEY)
  return Boolean(
    value && typeof value === 'object' && value.disclaimerVersion === CONSENT_VERSION
  )
}

function requireContext() {
  if (!pluginContext) throw new Error('QQ 音乐插件尚未激活')
  return pluginContext
}

function buildUrl(origin, pathname, params) {
  const url = new URL(pathname, origin)
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url
}

async function fetchJson(input, options = {}, requestContext, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchWithTimeout(
    input,
    {
      ...options,
      headers: {
        'User-Agent': QQ_USER_AGENT,
        ...(options.headers || {})
      },
      signal: options.signal || requestSignal(requestContext)
    },
    timeoutMs
  )
  if (response.ok === false) throw new Error(`QQ 音乐上游 HTTP ${response.status}`)
  const payload = parseJsonp(await response.text())
  if (!payload || typeof payload !== 'object') throw new Error('QQ 音乐上游响应格式无效')
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new Error(
      safeErrorMessage(payload.msg || payload.message || `QQ 音乐业务错误 ${payload.code}`)
    )
  }
  return payload
}

async function fetchWithTimeout(input, options = {}, timeoutMs) {
  const externalSignal = options.signal
  if (externalSignal?.aborted) throw externalSignal.reason || abortError()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(abortError()), timeoutMs)
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
  try {
    return await fetch(input, { ...options, signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonp(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!normalized) return {}
  try {
    return JSON.parse(normalized)
  } catch {
    const match = normalized.match(/^[^(]+\((.*)\);?$/s)
    if (!match) throw new Error('QQ 音乐上游返回非 JSON 数据')
    return JSON.parse(match[1])
  }
}

function requestSignal(requestContext) {
  return requestContext && typeof requestContext.signal?.aborted === 'boolean'
    ? requestContext.signal
    : undefined
}

function abortError() {
  const error = new Error('QQ 音乐请求已取消或超时')
  error.name = 'AbortError'
  return error
}

function expiredAuthError() {
  const error = new Error('QQ 音乐登录会话已失效，请重新扫码登录')
  error.name = 'QQMusicAuthExpiredError'
  return error
}

function mapTrack(item) {
  if (!item || typeof item !== 'object') return null
  const songmid = String(item.songmid || item.song_mid || item.mid || '').trim()
  const songid = String(item.songid || item.song_id || item.id || '').trim()
  if (!songmid && !songid) return null
  const mid = songmid || songid
  const singers = Array.isArray(item.singer)
    ? item.singer
    : Array.isArray(item.singers)
      ? item.singers
      : []
  const artists = singers
    .map((singer) => ({
      id: singer?.mid || singer?.id || undefined,
      name: String(singer?.name || singer?.title || '').trim()
    }))
    .filter((artist) => artist.name)
  const artist =
    artists.map((entry) => entry.name).join(' / ') ||
    String(item.singername || item.artist || '未知艺术家').trim()
  const title = String(item.songname || item.songorig || item.title || '未知歌曲').trim()
  const album = item.album && typeof item.album === 'object' ? item.album : {}
  const albumName = String(item.albumname || album.name || album.title || '').trim()
  const albumMid = String(item.albummid || album.mid || album.midd || '').trim()
  const file = item.file && typeof item.file === 'object' ? item.file : {}
  const mediaMid = String(item.media_mid || item.mediaMid || file.media_mid || file.mediaMid || '').trim()
  const id = `qq:${mid}`
  return {
    id,
    title,
    artist,
    artists: artists.length ? artists : undefined,
    album: albumName,
    filePath: id,
    fileName: `${sanitizeFileName(title)}.mp3`,
    duration: normalizeDuration(item.interval || item.duration),
    size: normalizeCount(
      item.size || item.size_128 || item.size_320 || file.size_128mp3 || file.size_320mp3 || 0
    ),
    cover: normalizeHttpUrl(item.cover || item.pic || (albumMid ? albumCover(albumMid) : '')),
    lyrics: null,
    translatedLyrics: null,
    source: PROVIDER_ID,
    streamUrl: null,
    bpm: undefined,
    providerSongId: songid || undefined,
    ...(mediaMid ? { providerMediaId: mediaMid } : {})
  }
}

function mapPlaylist(item, fallbackCreator) {
  if (!item || typeof item !== 'object') return null
  const id = String(
    item.dissid ||
      item.disstid ||
      item.tid ||
      item.content_id ||
      item.id ||
      item.dirid ||
      item.dirId ||
      ''
  ).trim()
  if (!id) return null
  const name = String(item.dissname || item.diss_name || item.title || item.name || 'QQ 音乐歌单').trim()
  const cover = normalizeHttpUrl(
    item.logo ||
      item.picurl ||
      item.pic ||
      item.cover ||
      item.imgurl ||
      item.cover_url ||
      item.cover_url_big ||
      item.cover_url_medium ||
      ''
  )
  const creator =
    item.creator && typeof item.creator === 'object'
      ? item.creator
      : item.creator_info && typeof item.creator_info === 'object'
        ? item.creator_info
        : {}
  const creatorName = String(
    item.creatorname ||
      item.creator_name ||
      item.username ||
      creator.name ||
      creator.nick ||
      fallbackCreator ||
      ''
  ).trim()
  const parsedType = Number(item.type || item.playlistType)
  const type = Number.isFinite(parsedType) ? parsedType : 0
  return {
    id,
    name,
    cover: cover || null,
    trackCount: normalizeCount(
      item.songnum ||
        item.song_count ||
        item.num ||
        item.songCount ||
        item.total_song_num ||
        item.song_ids?.length
    ),
    creatorName: creatorName || undefined,
    owned: item.owner === 1 || item.isowner === 1 || item.isOwner === 1 || type === 1,
    qqType: type
  }
}

function mapArtist(item) {
  if (!item || typeof item !== 'object') return null
  const id = String(item.singerMid || item.singermid || item.mid || item.id || '').trim()
  const name = String(item.singerName || item.singername || item.name || item.title || '').trim()
  if (!id || !name) return null
  return {
    id,
    name,
    cover: normalizeHttpUrl(item.pic || item.picurl || item.avatar || '') || null
  }
}

function extractNativePlaylistItems(payload) {
  const candidates = [
    payload?.v_playlist,
    payload?.playlist,
    payload?.playlist?.list,
    payload?.playlists,
    payload?.playlists?.list,
    payload?.data?.v_playlist,
    payload?.data?.playlist,
    payload?.data?.playlist?.list,
    payload?.data?.playlists,
    payload?.data?.playlists?.list,
    payload?.data?.mydiss?.list,
    payload?.data?.mydiss,
    payload?.data?.mymusic,
    payload?.data?.mymusic?.list,
    payload?.data?.createdDissList,
    payload?.data?.createdDissList?.list,
    payload?.data?.createdList,
    payload?.data?.createdList?.list,
    payload?.data?.creator?.playlist,
    payload?.data?.creator?.playlists,
    payload?.data?.creator?.playlist?.list,
    payload?.data?.creator?.playlists?.list,
    payload?.data?.playlist,
    payload?.data?.playlists,
    payload?.data?.playlist?.list,
    payload?.data?.playlists?.list,
    payload?.mydiss?.list,
    payload?.mydiss,
    payload?.mymusic,
    payload?.mymusic?.list,
    payload?.createdDissList,
    payload?.createdDissList?.list,
    payload?.createdList,
    payload?.createdList?.list,
    payload?.creator?.playlist,
    payload?.creator?.playlists,
    payload?.creator?.playlist?.list,
    payload?.creator?.playlists?.list,
    payload?.playlist,
    payload?.playlists,
    payload?.playlist?.list,
    payload?.playlists?.list
  ]
  return candidates.find(Array.isArray) || []
}

function extractNativePlaylistTracks(payload) {
  const candidates = [
    payload?.songlist,
    payload?.songList,
    payload?.cdlist?.[0]?.songlist,
    payload?.cdlist?.songlist,
    payload?.data?.songlist,
    payload?.data?.songList,
    payload?.data?.cdlist?.[0]?.songlist,
    payload?.data?.cdlist?.songlist,
    payload?.response?.songlist,
    payload?.response?.data?.songlist,
    payload?.response?.cdlist?.[0]?.songlist,
    payload?.response?.data?.cdlist?.[0]?.songlist
  ]
  return candidates.find(Array.isArray) || []
}

function mapNativeProfile(payload, uin) {
  const candidates = [
    payload?.info,
    payload?.user,
    payload?.userInfo,
    payload?.userinfo,
    payload?.data?.creator,
    payload?.data?.userInfo,
    payload?.data?.userinfo,
    payload?.data?.profile,
    payload?.data?.user,
    payload?.creator,
    payload?.userInfo,
    payload?.profile,
    payload?.user
  ]
  const user = candidates.find((value) => value && typeof value === 'object')
  if (!user) return buildProfile(uin)
  const nickname = String(user.nick || user.nickname || user.name || '').trim()
  const avatar = normalizeHttpUrl(user.avatar || user.headurl || user.pic || '')
  return {
    userId: uin,
    nickname: nickname || `QQ 用户 ${uin}`,
    avatarUrl: avatar || buildAvatar(uin)
  }
}

function buildProfile(uin) {
  return {
    userId: uin,
    nickname: `QQ 用户 ${uin}`,
    avatarUrl: buildAvatar(uin)
  }
}

function sanitizeProfile(value, uin) {
  if (!value || typeof value !== 'object') return buildProfile(uin)
  const nickname = String(value.nickname || '').trim()
  const avatarUrl = normalizeHttpUrl(value.avatarUrl || '') || buildAvatar(uin)
  return {
    userId: uin,
    nickname: nickname || `QQ 用户 ${uin}`,
    avatarUrl
  }
}

function buildAvatar(uin) {
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(uin)}&spec=140`
}

function trackSongmid(track) {
  const id = typeof track?.id === 'string' ? track.id : ''
  if (id.startsWith('qq:')) return id.slice(3).trim()
  return String(track?.songmid || track?.song_mid || '').trim()
}

function trackSongId(track) {
  if (track?.providerSongId != null) return String(track.providerSongId)
  return String(track?.songid || track?.song_id || '').trim()
}

function trackMediaMid(track) {
  return String(track?.providerMediaId || track?.media_mid || track?.mediaMid || '').trim()
}

function normalizeLyrics(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const lyrics = decodeLyric(source.lyric || source.lrc || source.lyricText)
  const translatedLyrics = decodeLyric(source.trans || source.translated || source.transLyric)
  return {
    lyrics: lyrics || null,
    translatedLyrics: translatedLyrics || null,
    wordLyrics: decodeLyric(source.qrc || source.wordLyrics) || null
  }
}

function decodeLyric(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const text = value.trim()
  if (text.includes('[') || text.includes('\n')) return text
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8')
    return decoded.includes('[') || decoded.includes('\n') ? decoded : text
  } catch {
    return text
  }
}

function qualityLadder(value) {
  const normalized = String(value || '').toLowerCase()
  if (
    normalized === 'flac' ||
    normalized === 'ape' ||
    normalized === 'lossless' ||
    normalized === 'hires' ||
    normalized === 'hi-res' ||
    normalized === 'hi_res'
  ) {
    return ['flac', '320', '128']
  }
  if (normalized === '320' || normalized === 'high' || normalized === 'exhigh') return ['320', '128']
  return ['128']
}

function normalizeLimit(value) {
  return Math.min(50, Math.max(1, Math.floor(Number(value) || 30)))
}

function normalizeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function normalizeDuration(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.round(number > 10000 ? number / 1000 : number)
}

function normalizePlaylistId(value) {
  const id = String(value ?? '').trim()
  if (id === 'liked') return id
  if (!/^\d+$/.test(id)) throw new Error('QQ 音乐歌单 ID 无效')
  return id
}

function isLikedPlaylist(playlist) {
  return playlist.id === '201' || playlist.qqType === 1 || playlist.name.includes('喜欢')
}

function firstArray(...values) {
  return values.find(Array.isArray) || []
}

function uniquePlaylists(playlists) {
  const seen = new Set()
  return playlists.filter((playlist) => {
    const id = String(playlist.id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function resetPlaylistCategoryIds() {
  playlistCategoryIds.clear()
  playlistCategoryIds.set('全部', 10000000)
}

function albumCover(mid) {
  return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(mid)}.jpg`
}

function sanitizeFileName(value) {
  return String(value || 'QQ Music').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim()
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function pickPlayableDomain(value) {
  const values = Array.isArray(value) ? value : [value]
  const urls = values.filter((item) => typeof item === 'string' && item.trim())
  return urls.find((url) => !url.startsWith('http://ws')) || urls.find((url) => url.startsWith('https://')) || urls[0] || ''
}

function joinUrl(domain, path) {
  if (!domain || !path) return ''
  if (path.startsWith('//')) return normalizeHttpUrl(`https:${path}`)
  if (/^https?:\/\//i.test(path)) return normalizeHttpUrl(path)
  return normalizeHttpUrl(`${domain.replace(/\/$/, '')}/${path.replace(/^\//, '')}`)
}

function purgeExpiredStreamTokens() {
  const now = Date.now()
  for (const [token, entry] of streamTokens) {
    if (entry.expiresAt <= now) streamTokens.delete(token)
  }
}

function normalizeUin(value) {
  const text = String(value || '').trim().replace(/^o/i, '')
  return text && /^[0-9]+$/.test(text) ? text : ''
}

function findNestedValue(value, names) {
  if (typeof value === 'string' || typeof value === 'number') return ''
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedValue(item, names)
      if (found) return found
    }
    return ''
  }
  for (const name of names) {
    const candidate = value[name]
    if ((typeof candidate === 'string' || typeof candidate === 'number') && String(candidate).trim()) {
      return String(candidate).trim()
    }
  }
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, names)
    if (found) return found
  }
  return ''
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function safeErrorMessage(error) {
  return errorToMessage(error)
    .replace(
      /(?:^|[;\s])(?:p_skey|qrsig|qqmusic_key|qm_keyst|musickey|authst|token|qrcodeid|qrcode_id|uin|p_uin|qimei|qimei36|sid|vkey|encryptuin|set-cookie|cookie|authorization)=[^;\s]*/gi,
      '$1[credential-redacted]'
    )
    .replace(
      /((?:["']?)(?:p_skey|qrsig|qqmusic_key|qm_keyst|musickey|authst|token|qrcodeid|qrcode_id|uin|p_uin|qimei|qimei36|sid|vkey|encryptuin|set-cookie|cookie|authorization)(?:["']?\s*[:=]\s*))(?:(?:"[^"]*")|(?:'[^']*')|[^,;\s}]+)/gi,
      '$1[credential-redacted]'
    )
    .replace(/https?:\/\/[^\s]+/gi, '[upstream-url-redacted]')
    .slice(0, 240)
}

function logWarn(message) {
  pluginContext?.logger?.warn?.(message)
}
