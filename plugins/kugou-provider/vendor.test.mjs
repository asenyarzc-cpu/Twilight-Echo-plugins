// 内嵌 KuGouMusicApi bundle 的工件测试：
// 默认只做本地校验（起服务、404、路由表、干净关闭），不访问酷狗上游。
// 设 TAE_KUGOU_E2E=1 时追加真网络冒烟（概念版 register/dev、二维码 key 与二维码图片）。
import assert from 'node:assert/strict'
import test from 'node:test'

import vendorExports from './vendor/kugouApi.vendor.cjs'

const createKugouApiServer = vendorExports.createKugouApiServer

test('vendor bundle exposes the embedded server factory and a full route table', () => {
  assert.equal(typeof createKugouApiServer, 'function')
  assert.ok(Array.isArray(vendorExports.MODULE_DEFS))
  assert.ok(vendorExports.MODULE_DEFS.length > 100)
  const routes = new Set(vendorExports.MODULE_DEFS.map((def) => def.route))
  for (const route of [
    '/search',
    '/song/url',
    '/lyric',
    '/search/lyric',
    '/register/dev',
    '/login/qr/key',
    '/login/qr/create',
    '/login/qr/check',
    '/user/detail',
    '/user/playlist',
    '/playlist/track/all'
  ]) {
    assert.ok(routes.has(route), `missing plugin-critical route: ${route}`)
  }
  assert.ok(
    vendorExports.MODULE_DEFS.every((def) => !def.identifier.startsWith('_')),
    'internal modules must stay unregistered'
  )
})

test('embedded server binds loopback on an ephemeral port and closes cleanly', async () => {
  const app = await createKugouApiServer({ host: '127.0.0.1', port: 0 })
  try {
    const address = app.service.address()
    assert.equal(address.address, '127.0.0.1')
    assert.ok(address.port > 0)
    const missing = await fetch(`http://127.0.0.1:${address.port}/definitely/not/a/route`)
    assert.equal(missing.status, 404)
  } finally {
    app.service.closeAllConnections()
    await new Promise((resolve) => app.service.close(resolve))
  }
})

const e2e = process.env.TAE_KUGOU_E2E
test('embedded server reaches the KuGou upstream end to end', { skip: !e2e }, async () => {
  process.env.KUGOU_API_PLATFORM = 'lite'
  const app = await createKugouApiServer({ host: '127.0.0.1', port: 0 })
  try {
    const base = `http://127.0.0.1:${app.service.address().port}`
    const dev = await fetch(base + '/register/dev', { method: 'POST' })
    assert.equal(dev.status, 200)
    const devPayload = await dev.json()
    assert.equal(devPayload.error_code, 0)
    assert.ok(devPayload.data?.dfid)
    // 与插件一致：注册设备后持久化 Set-Cookie，并在后续请求中回带
    const cookies = (dev.headers.getSetCookie?.() ?? [])
      .map((line) => line.split(';', 1)[0])
      .filter((pair) => pair.includes('='))
      .join('; ')

    const qr = await fetch(base + '/login/qr/key', {
      headers: { Cookie: cookies }
    })
    assert.equal(qr.status, 200)
    const qrPayload = await qr.json()
    assert.ok(qrPayload.data?.qrcode)

    const image = await fetch(
      base + '/login/qr/create?qrimg=true&key=' + encodeURIComponent(qrPayload.data.qrcode),
      { headers: { Cookie: cookies } }
    )
    assert.equal(image.status, 200)
    const imagePayload = await image.json()
    assert.match(imagePayload.data?.base64 || '', /^data:image\//)
  } finally {
    delete process.env.KUGOU_API_PLATFORM
    app.service.closeAllConnections()
    await new Promise((resolve) => app.service.close(resolve))
  }
})
