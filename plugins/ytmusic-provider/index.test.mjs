import assert from 'node:assert/strict'
import test from 'node:test'

// Unit tests for utility functions that don't require network access.
// Integration tests (search, playback, lyrics) require a live YouTube Music
// cookie and are not included here.

function createMockContext({ settings = new Map(), onProvider, onUi, onCommand } = {}) {
  return {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { if (onProvider) onProvider(provider) }
      },
      ui: {
        register: async (ui) => { if (onUi) onUi(ui) },
        onCommand: (command, handler) => {
          if (onCommand) onCommand(command, handler)
          return () => {}
        }
      }
    },
    settings: {
      get: async (key) => settings.get(key) ?? null,
      set: async (key, value) => { settings.set(key, value) },
      delete: async (key) => { settings.delete(key) }
    }
  }
}

test('plugin exports activate and deactivate functions', async () => {
  const mod = await import('./index.mjs')
  assert.equal(typeof mod.activate, 'function')
  assert.equal(typeof mod.deactivate, 'function')
})

test('activate registers provider with correct id and capabilities', async () => {
  const mod = await import('./index.mjs')
  let registered = null
  const uiRegistered = []
  const commands = new Map()

  const mockContext = createMockContext({
    onProvider: (provider) => { registered = provider },
    onUi: (ui) => { uiRegistered.push(ui) },
    onCommand: (command, handler) => { commands.set(command, handler) }
  })

  await mod.activate(mockContext)

  assert.equal(registered.id, 'ytm')
  assert.equal(registered.name, 'YouTube Music')
  assert.deepEqual(registered.capabilities, [
    'search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'
  ])
  assert.equal(typeof registered.searchSongs, 'function')
  assert.equal(typeof registered.getPlaybackUrl, 'function')
  assert.equal(typeof registered.getLyrics, 'function')
  assert.equal(typeof registered.fetchPlaylistTracks, 'function')
  assert.equal(typeof registered.fetchUserLibrary, 'function')
  assert.equal(typeof registered.checkLogin, 'function')
  assert.equal(typeof registered.getProfile, 'function')
  assert.equal(typeof registered.logout, 'function')
  assert.equal(typeof registered.getQrLogin, 'function')
  assert.equal(typeof registered.checkQrLogin, 'function')

  const settingsPanel = uiRegistered.find((ui) => ui.id === 'ytmusic-settings')
  const accountPage = uiRegistered.find((ui) => ui.id === 'ytmusic-account')
  assert.equal(settingsPanel.kind, 'settingsPanel')
  assert.equal(settingsPanel.command, 'ytmusic.settingsHelp')
  assert.equal(accountPage.kind, 'sidebarPage')
  assert.equal(accountPage.command, 'ytmusic.accountSettings')
  assert.equal(accountPage.renderMode, 'html')
  assert.equal(typeof commands.get('ytmusic.settingsHelp'), 'function')
  assert.equal(typeof commands.get('ytmusic.accountSettings'), 'function')

  await mod.deactivate()
})

test('account settings command returns an HTML form without leaking stored cookie', async () => {
  const mod = await import('./index.mjs')
  const settings = new Map([
    ['cookie', 'SAPISID=secret-sapisid; SID=secret-sid']
  ])
  const commands = new Map()

  const mockContext = createMockContext({
    settings,
    onCommand: (command, handler) => { commands.set(command, handler) }
  })

  await mod.activate(mockContext)
  const html = await commands.get('ytmusic.accountSettings')()

  assert.match(html, /<form/)
  assert.match(html, /127\.0\.0\.1/)
  assert.match(html, /name="cookie"/)
  assert.match(html, /name="oauth_client_id"/)
  assert.doesNotMatch(html, /secret-sapisid/)
  assert.doesNotMatch(html, /secret-sid/)

  await mod.deactivate()
})

test('settings endpoint rejects missing token, missing SAPISID, and cross-origin posts', async () => {
  const mod = await import('./index.mjs')
  const commands = new Map()
  const mockContext = createMockContext({
    onCommand: (command, handler) => { commands.set(command, handler) }
  })

  await mod.activate(mockContext)
  const html = await commands.get('ytmusic.accountSettings')()
  const action = html.match(/action="([^"]+)"/)?.[1]
  assert.ok(action)
  const missingTokenUrl = action.replace(/token=[^"&]+/, 'token=wrong')

  try {
    const missingToken = await fetch(missingTokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ cookie: 'SAPISID=value' })
    })
    assert.equal(missingToken.status, 403)

    const missingSapisid = await fetch(action, {
      method: 'POST',
      body: new URLSearchParams({ cookie: 'SID=value; HSID=value' })
    })
    assert.equal(missingSapisid.status, 400)

    const crossOrigin = await fetch(action, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: new URLSearchParams({ cookie: 'SAPISID=value' })
    })
    assert.equal(crossOrigin.status, 403)
  } finally {
    await mod.deactivate()
  }
})

test('settings endpoint accepts raw cookie and complete request headers', async () => {
  const mod = await import('./index.mjs')
  const settings = new Map([
    ['innertube', { apiKey: 'cached', clientVersion: 'cached' }]
  ])
  const commands = new Map()
  const mockContext = createMockContext({
    settings,
    onCommand: (command, handler) => { commands.set(command, handler) }
  })

  await mod.activate(mockContext)
  const html = await commands.get('ytmusic.accountSettings')()
  const action = html.match(/action="([^"]+)"/)?.[1]
  assert.ok(action)

  try {
    const rawCookie = await fetch(action, {
      method: 'POST',
      body: new URLSearchParams({ cookie: 'SID=sid; __Secure-3PAPISID=secure; HSID=hsid' })
    })
    assert.equal(rawCookie.status, 200)
    assert.equal(settings.get('cookie'), 'SID=sid; __Secure-3PAPISID=secure; HSID=hsid')
    assert.equal(settings.has('innertube'), false)

    const headerCookie = await fetch(action, {
      method: 'POST',
      body: new URLSearchParams({
        cookie: [
          'GET /youtubei/v1/browse HTTP/2',
          'Host: music.youtube.com',
          'User-Agent: Mozilla/5.0',
          'Cookie: SID=next; SAPISID=plain; CONSENT=YES'
        ].join('\n')
      })
    })
    assert.equal(headerCookie.status, 200)
    assert.equal(settings.get('cookie'), 'SID=next; SAPISID=plain; CONSENT=YES')
  } finally {
    await mod.deactivate()
  }
})

test('settings endpoint saves user supplied OAuth client credentials', async () => {
  const mod = await import('./index.mjs')
  const settings = new Map()
  const commands = new Map()
  const mockContext = createMockContext({
    settings,
    onCommand: (command, handler) => { commands.set(command, handler) }
  })

  await mod.activate(mockContext)
  const html = await commands.get('ytmusic.accountSettings')()
  const action = html.match(/action="([^"]+)"/)?.[1]
  assert.ok(action)

  try {
    const response = await fetch(action, {
      method: 'POST',
      body: new URLSearchParams({
        cookie: 'SAPISID=value',
        oauth_client_id: 'user-client-id',
        oauth_client_secret: 'user-client-secret'
      })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(settings.get('oauth_client'), {
      client_id: 'user-client-id',
      client_secret: 'user-client-secret'
    })
  } finally {
    await mod.deactivate()
  }
})

test('stored OAuth client is preferred when refreshing tokens', async () => {
  const mod = await import('./index.mjs')
  const originalFetch = globalThis.fetch
  const settings = new Map([
    ['oauth_client', {
      client_id: 'stored-client-id',
      client_secret: 'stored-client-secret'
    }],
    ['oauth_token', {
      access_token: 'old-access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 10,
      scope: 'profile',
      token_type: 'Bearer'
    }]
  ])
  let tokenRequestBody = null

  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === 'https://www.youtube.com/o/oauth2/token') {
      tokenRequestBody = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access-token',
          expires_in: 3600,
          scope: 'profile',
          token_type: 'Bearer'
        })
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ''
    }
  }

  const mockContext = createMockContext({ settings })

  try {
    await mod.activate(mockContext)
    assert.deepEqual(tokenRequestBody, {
      client_id: 'stored-client-id',
      client_secret: 'stored-client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token'
    })
  } finally {
    await mod.deactivate()
    globalThis.fetch = originalFetch
  }
})

test('WEB_REMIX search does not send OAuth bearer token', async () => {
  const mod = await import('./index.mjs')
  const originalFetch = globalThis.fetch
  let registered = null
  let capturedHeaders = null
  const settings = new Map([
    ['oauth_token', {
      access_token: 'oauth-access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'profile',
      token_type: 'Bearer'
    }],
    ['innertube', {
      apiKey: 'test-api-key',
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260626.01.00',
      visitorData: 'visitor'
    }]
  ])

  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return {
        ok: false,
        status: 401,
        json: async () => ({})
      }
    }
    if (String(input).startsWith('https://music.youtube.com/youtubei/v1/search')) {
      capturedHeaders = options.headers
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ''
    }
  }

  const mockContext = createMockContext({
    settings,
    onProvider: (provider) => { registered = provider }
  })

  try {
    await mod.activate(mockContext)
    await registered.searchSongs('test')
    assert.ok(capturedHeaders)
    assert.notEqual(capturedHeaders.Authorization, 'Bearer oauth-access-token')
  } finally {
    await mod.deactivate()
    globalThis.fetch = originalFetch
  }
})

test('fetchUserLibrary sends SAPISIDHASH authorization when cookie auth is available', async () => {
  const mod = await import('./index.mjs')
  const originalFetch = globalThis.fetch
  let registered = null
  let capturedHeaders = null
  const settings = new Map([
    ['cookie', 'SID=sid; SAPISID=sapisid-value; HSID=hsid'],
    ['innertube', {
      apiKey: 'test-api-key',
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260626.01.00',
      visitorData: 'visitor'
    }]
  ])

  globalThis.fetch = async (input, options = {}) => {
    if (String(input).startsWith('https://music.youtube.com/youtubei/v1/browse')) {
      capturedHeaders = options.headers
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ''
    }
  }

  const mockContext = createMockContext({
    settings,
    onProvider: (provider) => { registered = provider }
  })

  try {
    await mod.activate(mockContext)
    const library = await registered.fetchUserLibrary()
    assert.deepEqual(library, { likedPlaylist: null, playlists: [] })
    assert.ok(capturedHeaders)
    assert.match(capturedHeaders.Authorization, /^SAPISIDHASH /)
    assert.equal(capturedHeaders.Cookie, 'SID=sid; SAPISID=sapisid-value; HSID=hsid')
  } finally {
    await mod.deactivate()
    globalThis.fetch = originalFetch
  }
})

test('fetchUserLibrary returns an actionable message when cookie auth is missing', async () => {
  const mod = await import('./index.mjs')
  let registered = null

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    }
  }

  await mod.activate(mockContext)
  assert.ok(registered.capabilities.includes('library'))
  await assert.rejects(
    () => registered.fetchUserLibrary(false),
    /音乐库需要浏览器 Cookie 登录/
  )
  await mod.deactivate()
})

test('deactivate cleans up state without throwing', async () => {
  const mod = await import('./index.mjs')

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: { register: async () => {} },
      ui: { register: async () => {} }
    },
    settings: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    }
  }

  await mod.activate(mockContext)
  await mod.deactivate()

  // deactivate should complete without error
  assert.ok(true)
})

test('getQrLogin is a function registered on provider', async () => {
  const mod = await import('./index.mjs')
  let registered = null

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    }
  }

  await mod.activate(mockContext)
  assert.equal(typeof registered.getQrLogin, 'function')
  await mod.deactivate()
})

test('checkQrLogin returns error when no OAuth flow initiated', async () => {
  const mod = await import('./index.mjs')
  let registered = null

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    }
  }

  await mod.activate(mockContext)

  const result = await registered.checkQrLogin()
  // Without OAuth client_id configured, should return error
  assert.equal(result.code, -1)
  assert.ok(result.message.length > 0)

  await mod.deactivate()
})

test('checkLogin returns not logged in when no cookie', async () => {
  const mod = await import('./index.mjs')
  let registered = null

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async () => null,
      set: async () => {},
      delete: async () => {}
    }
  }

  await mod.activate(mockContext)

  const result = await registered.checkLogin()
  assert.equal(result.loggedIn, false)
  assert.equal(result.profile, null)

  await mod.deactivate()
})

test('checkLogin treats a stored OAuth token as logged in when profile fetch fails', async () => {
  const mod = await import('./index.mjs')
  let registered = null
  const originalFetch = globalThis.fetch
  const settings = new Map([
    ['oauth_token', {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'http://gdata.youtube.com',
      token_type: 'Bearer'
    }],
    ['innertube', {
      apiKey: 'test-api-key',
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260626.01.00',
      visitorData: 'visitor'
    }]
  ])

  globalThis.fetch = async () => ({
    ok: false,
    status: 401
  })

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async (key) => settings.get(key) ?? null,
      set: async (key, value) => { settings.set(key, value) },
      delete: async (key) => { settings.delete(key) }
    }
  }

  try {
    await mod.activate(mockContext)

    const result = await registered.checkLogin()
    assert.equal(result.loggedIn, true)
    assert.equal(result.profile.nickname, 'YouTube Music 用户')
  } finally {
    await mod.deactivate()
    globalThis.fetch = originalFetch
  }
})

test('checkLogin uses OAuth userinfo when the token includes profile scope', async () => {
  const mod = await import('./index.mjs')
  let registered = null
  const originalFetch = globalThis.fetch
  const settings = new Map([
    ['oauth_token', {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'https://www.googleapis.com/auth/youtube-paid-content openid profile email',
      token_type: 'Bearer'
    }],
    ['innertube', {
      apiKey: 'test-api-key',
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260626.01.00',
      visitorData: 'visitor'
    }]
  ])

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: '真实 YouTube 账号',
          sub: 'google-user-id',
          picture: 'https://lh3.googleusercontent.com/avatar'
        })
      }
    }
    return {
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}'
    }
  }

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: { register: async () => {} }
    },
    settings: {
      get: async (key) => settings.get(key) ?? null,
      set: async (key, value) => { settings.set(key, value) },
      delete: async (key) => { settings.delete(key) }
    }
  }

  try {
    await mod.activate(mockContext)

    const result = await registered.checkLogin()
    assert.equal(result.loggedIn, true)
    assert.deepEqual(result.profile, {
      nickname: '真实 YouTube 账号',
      userId: 'google-user-id',
      avatarUrl: 'https://lh3.googleusercontent.com/avatar'
    })
  } finally {
    await mod.deactivate()
    globalThis.fetch = originalFetch
  }
})

test('plugin.json has correct manifest fields', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const manifestPath = path.join(import.meta.dirname, 'plugin.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

  assert.equal(manifest.id, 'com.twilightecho.provider.ytmusic')
  assert.equal(manifest.author, 'Px_asen')
  assert.ok(manifest.type.includes('provider'))
  assert.ok(manifest.type.includes('ui'))
  assert.ok(manifest.permissions.includes('network'))
  assert.ok(manifest.permissions.includes('settings'))
  assert.equal(manifest.main, 'index.mjs')
  assert.ok(manifest.version)
})
