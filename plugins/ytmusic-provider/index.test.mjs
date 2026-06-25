import assert from 'node:assert/strict'
import test from 'node:test'

// Unit tests for utility functions that don't require network access.
// Integration tests (search, playback, lyrics) require a live YouTube Music
// cookie and are not included here.

test('plugin exports activate and deactivate functions', async () => {
  const mod = await import('./index.mjs')
  assert.equal(typeof mod.activate, 'function')
  assert.equal(typeof mod.deactivate, 'function')
})

test('activate registers provider with correct id and capabilities', async () => {
  const mod = await import('./index.mjs')
  let registered = null
  let uiRegistered = null

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: {
        register: async (provider) => { registered = provider }
      },
      ui: {
        register: async (ui) => { uiRegistered = ui }
      }
    }
  }

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

  assert.equal(uiRegistered.id, 'ytmusic-settings')
  assert.equal(uiRegistered.kind, 'settingsPanel')

  await mod.deactivate()
})

test('deactivate cleans up state without throwing', async () => {
  const mod = await import('./index.mjs')

  const mockContext = {
    logger: { info: () => {}, warn: () => {} },
    twilight: {
      providers: { register: async () => {} },
      ui: { register: async () => {} }
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
