// 构建 KuGouMusicApi 内嵌 bundle：
//   node scripts/build-kugou-vendor.mjs
// 环境变量：
//   KUGOU_API_SRC          上游克隆目录（默认 D:\KuGouMusicApi）
//   KUGOU_API_PINNED_COMMIT 期望的上游 commit（见常量）
// 产物：plugins/kugou-provider/vendor/kugouApi.vendor.cjs（自包含，运行期零文件依赖）
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const DEFAULT_SRC = 'D:\\KuGouMusicApi'
const PINNED_COMMIT = '2e2bcba4bf81c0833b44aad566c9a7edaba9c8cd'
const UPSTREAM_LICENSE = 'MIT'
const UPSTREAM_URL = 'https://github.com/MakcRe/KuGouMusicApi'

const srcRoot = path.resolve(process.env.KUGOU_API_SRC || DEFAULT_SRC)
const pluginDir = path.join(repoRoot, 'plugins', 'kugou-provider')
const outFile = path.join(pluginDir, 'vendor', 'kugouApi.vendor.cjs')

function assertPinnedSource() {
  let head = ''
  try {
    head = execFileSync('git', ['-C', srcRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
  } catch (error) {
    throw new Error(`无法读取上游 commit（${srcRoot}）：${error.message}`)
  }
  if (head !== PINNED_COMMIT) {
    throw new Error(
      `上游 commit 不匹配：期望 ${PINNED_COMMIT}，实际 ${head}。` +
        '请在 KUGOU_API_SRC 指向正确版本，或审核上游变更后更新 build-kugou-vendor.mjs 中的 PINNED_COMMIT。'
    )
  }
}

// 与上游 server.js getModulesDefinitions 的扫描规则保持一致：
// readdir 倒序 → 仅保留 .js 且不以 _ 开头 → 路由为下划线换斜杠
function collectModuleDefs() {
  const moduleDir = path.join(srcRoot, 'module')
  const files = readdirSync(moduleDir).reverse()
  const defs = []
  for (const fileName of files) {
    if (!fileName.endsWith('.js') || fileName.startsWith('_')) continue
    const identifier = fileName.split('.').shift()
    defs.push({
      identifier,
      route: `/${identifier.replace(/_/g, '/')}`,
      absolutePath: path.join(moduleDir, fileName).split(path.sep).join('/')
    })
  }
  if (defs.length < 100) throw new Error(`module 目录异常，仅发现 ${defs.length} 个模块`)
  return defs
}

function generateEntry(defs) {
  const lines = [
    '// 由 scripts/build-kugou-vendor.mjs 生成，请勿手改。',
    "const { consturctServer } = require('virtual:kugou-server-patched')",
    ''
  ]
  defs.forEach((def, index) => {
    lines.push(`const mod_${index} = require('${def.absolutePath}')`)
  })
  lines.push('')
  lines.push('const MODULE_DEFS = [')
  defs.forEach((def, index) => {
    lines.push(
      `  { identifier: ${JSON.stringify(def.identifier)}, route: ${JSON.stringify(def.route)}, module: mod_${index} },`
    )
  })
  lines.push(']')
  lines.push('')
  lines.push(
    `async function createKugouApiServer({ host = '127.0.0.1', port = 0 } = {}) {`,
    '  const app = await consturctServer(MODULE_DEFS)',
    '  const service = app.listen(port, host)',
    '  app.service = service',
    '  await new Promise((resolve, reject) => {',
    "    service.once('listening', resolve)",
    "    service.once('error', reject)",
    '  })',
    '  return app',
    '}',
    '',
    'module.exports = { createKugouApiServer, MODULE_DEFS }'
  )
  return lines.join('\n')
}

// 上游 server.js 只导出 startService/getModulesDefinitions；
// 构建期为导出行追加 consturctServer（运行期文件不被改动）。
// 同时脱敏每请求日志：originalUrl 含完整 query（凭证经 query cookie 传递），
// 插件宿主的 stdout 会被落盘到插件日志，绝不能包含 token。
function patchServerSource(source) {
  const marker = 'module.exports = { startService, getModulesDefinitions }'
  if (!source.includes(marker)) {
    throw new Error('上游 server.js 导出行与预期不一致，请审核上游变更后更新构建脚本')
  }
  let patched = source.replace(
    marker,
    'module.exports = { startService, getModulesDefinitions, consturctServer }'
  )
  const okMarker = "console.log('[OK]', decode(req.originalUrl));"
  const ipForwardPattern = /config\.ip = ip;\r?\n\s*return createRequest\(config\);/
  const errLogPattern =
    /console\.log\('\[ERR\]', decode\(req\.originalUrl\), \{\s*status: moduleResponse\.status,\s*body: moduleResponse\.body,\s*\}\);/
  if (
    !patched.includes(okMarker) ||
    !ipForwardPattern.test(patched) ||
    !errLogPattern.test(patched)
  ) {
    throw new Error('上游 server.js 请求日志行与预期不一致，请人工审核后更新构建脚本')
  }
  patched = patched.replace(
    ipForwardPattern,
    `delete config.ip;
          delete config.realIP;
          return createRequest(config);`
  )
  patched = patched.replace(okMarker, "console.log('[OK]', req.originalUrl.split('?', 1)[0]);")
  patched = patched.replace(
    errLogPattern,
    "console.log('[ERR]', req.originalUrl.split('?', 1)[0], { status: moduleResponse.status, errorCode: moduleResponse.body?.error_code ?? moduleResponse.body?.errcode ?? null });"
  )
  return patchScopedPlatformSource(patched)
}

function patchScopedPlatformSource(source) {
  return source.replaceAll('process.env.platform', 'process.env.KUGOU_API_PLATFORM')
}

function patchGenerateSimulateSource(source) {
  const marker = 'console.log(sidPlaintext);'
  if (!source.includes(marker)) {
    throw new Error('上游 generate_simulate.js 指纹日志行与预期不一致，请人工审核后更新构建脚本')
  }
  // 兜底：KuGouMusicApi 2e2bcba4 的 generate_simulate.js 会在 20028 验证路径输出含 dfid 的明文指纹。
  // 删除条件：上游固定版本删除该 console.log(sidPlaintext) 后，移除此构建期补丁。
  return source.replace(marker, '')
}

const virtualServerPlugin = {
  name: 'kugou-patched-server',
  setup(build) {
    build.onResolve({ filter: /^virtual:kugou-server-patched$/ }, (args) => ({
      path: args.path,
      namespace: 'kugou-patched-server'
    }))
    build.onLoad({ filter: /.*/, namespace: 'kugou-patched-server' }, async () => {
      const serverSource = await import('node:fs').then((fs) =>
        fs.promises.readFile(path.join(srcRoot, 'server.js'), 'utf8')
      )
      return {
        contents: patchServerSource(serverSource),
        loader: 'js',
        resolveDir: srcRoot
      }
    })
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      const relative = path.relative(srcRoot, args.path)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null
      let contents = await import('node:fs').then((fs) => fs.promises.readFile(args.path, 'utf8'))
      contents = patchScopedPlatformSource(contents)
      if (path.basename(args.path) === 'generate_simulate.js') {
        contents = patchGenerateSimulateSource(contents)
      }
      return {
        contents,
        loader: 'js',
        resolveDir: path.dirname(args.path)
      }
    })
  }
}

async function main() {
  assertPinnedSource()
  const defs = collectModuleDefs()
  await mkdir(path.dirname(outFile), { recursive: true })
  const result = await esbuild.build({
    stdin: {
      contents: generateEntry(defs),
      sourcefile: 'embed-entry.generated.js',
      resolveDir: srcRoot,
      loader: 'js'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    sourcemap: false,
    outfile: outFile,
    plugins: [virtualServerPlugin],
    logLevel: 'info'
  })
  if (result.warnings.length) {
    console.warn(`esbuild warnings: ${result.warnings.length}`)
  }
  const size = statSync(outFile).size
  await writeFile(
    path.join(pluginDir, 'vendor', 'VENDOR.md'),
    [
      '# 内嵌 KuGouMusicApi vendor',
      '',
      `- 上游：${UPSTREAM_URL}`,
      `- pin commit：\`${PINNED_COMMIT}\``,
      `- 许可：${UPSTREAM_LICENSE}（完整文本见插件根目录 THIRD_PARTY_NOTICES.md）`,
      `- 产物：\`kugouApi.vendor.cjs\`（esbuild 自包含单文件，运行期不依赖 node_modules 与上游目录）`,
      `- 导出：\`createKugouApiServer({ host, port })\` → Express app（\`app.service\` 为 http.Server）`,
      '- 构建期改动：server.js 导出行追加 `consturctServer` 导出并脱敏错误日志；不把插件回环地址伪装成上游客户端 IP；将上游通用 `platform` 环境变量改为插件私有 `KUGOU_API_PLATFORM`；移除 generate_simulate.js 的明文指纹日志；运行期不改上游任何文件',
      '- 上游 public/ 与 docs/ 静态资源未随包分发（仅影响浏览器辅助页与文档站，API 不受影响）',
      '',
      '## 重新构建',
      '',
      '```shell',
      `git -C ${DEFAULT_SRC} fetch && git -C ${DEFAULT_SRC} checkout <新commit>`,
      '# 审核上游 diff 后更新 scripts/build-kugou-vendor.mjs 的 PINNED_COMMIT',
      'pnpm run build:kugou-vendor',
      '```',
      ''
    ].join('\n')
  )
  console.log(
    `vendor bundle: ${outFile} (${(size / 1024 / 1024).toFixed(2)} MB, ${defs.length} modules)`
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
