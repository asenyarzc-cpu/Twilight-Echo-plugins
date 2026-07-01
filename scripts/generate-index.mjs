import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const INDEX_SCHEMA_VERSION = 1
const DEFAULT_REPOSITORY = 'https://github.com/asenyarzc-cpu/Twilight-Echo-plugins'
const BUNDLED_PLUGIN_IDS = new Set(['com.twilightecho.provider.ncm'])
const REQUIRED_FIELDS = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'type',
  'engines',
  'apiVersion',
  'permissions'
]

export async function generatePluginIndex(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'))
  const packagesDir = join(repoRoot, 'packages')
  const entries = []

  await mkdir(packagesDir, { recursive: true })
  const packageNames = (await readdir(packagesDir))
    .filter((name) => name.toLowerCase().endsWith('.tep'))
    .sort((left, right) => left.localeCompare(right))

  const latestById = new Map()
  for (const packageName of packageNames) {
    const packagePath = join(packagesDir, packageName)
    const manifest = await readPackageManifest(packagePath)
    validateManifest(manifest, packageName)
    if (BUNDLED_PLUGIN_IDS.has(manifest.id)) {
      throw new Error(`插件索引不能包含 Twilight Echo 内置插件：${manifest.id}`)
    }
    await assertPluginReadme(repoRoot, manifest)
    const existing = latestById.get(manifest.id)
    if (existing && compareSemver(existing.manifest.version, manifest.version) >= 0) continue
    latestById.set(manifest.id, { packageName, packagePath, manifest })
  }

  const seenIds = new Set()
  for (const { packageName, packagePath, manifest } of latestById.values()) {
    if (seenIds.has(manifest.id)) throw new Error(`插件索引存在重复插件 id：${manifest.id}`)
    seenIds.add(manifest.id)
    const buffer = await readFile(packagePath)
    entries.push({
      ...manifest,
      sourceUrl: packageSourceUrl(packageName, options.baseUrl),
      checksumSha256: createHash('sha256').update(buffer).digest('hex'),
      repository: options.repository ?? DEFAULT_REPOSITORY,
      homepage: options.homepage ?? options.repository ?? DEFAULT_REPOSITORY,
      tags: inferTags(manifest),
      verified: true
    })
  }

  entries.sort((left, right) => left.id.localeCompare(right.id))
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    plugins: entries
  }

  const indexPath = join(repoRoot, 'plugins.json')
  const serialized = `${JSON.stringify(index, null, 2)}\n`
  if (options.validateOnly) {
    const existing = await readFile(indexPath, 'utf-8')
    if (existing !== serialized) {
      throw new Error('plugins.json is out of date; run npm run index')
    }
  }
  if (options.write) await writeFile(indexPath, serialized, 'utf-8')
  return index
}

async function readPackageManifest(packagePath) {
  const { stdout } = await execFileAsync('tar', ['-xOf', packagePath, 'plugin.json'], {
    maxBuffer: 1024 * 1024
  })
  return JSON.parse(stdout)
}

function validateManifest(manifest, packageName) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${packageName} 缺少有效 plugin.json`)
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) throw new Error(`${manifest.id ?? packageName} 缺少 manifest 字段：${field}`)
  }
  if (!manifest.main && !manifest.binary) {
    throw new Error(`${manifest.id} 必须声明 main 或 binary`)
  }
  if (manifest.type?.includes('dsp') && !manifest.binary) {
    throw new Error(`${manifest.id} 是 DSP 插件但缺少 binary`)
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new Error(`${manifest.id} permissions 必须是数组`)
  }
  const expectedPackageName = `${manifest.id}-${manifest.version}.tep`
  if (basename(packageName) !== expectedPackageName) {
    throw new Error(`${manifest.id} 包名必须是 ${expectedPackageName}`)
  }
}

async function assertPluginReadme(repoRoot, manifest) {
  const pluginsRoot = join(repoRoot, 'plugins')
  const names = await readdir(pluginsRoot).catch(() => [])
  for (const name of names) {
    const manifestPath = join(pluginsRoot, name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const pluginManifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    if (pluginManifest.id !== manifest.id) continue
    const readmePath = join(pluginsRoot, name, 'README.md')
    const readme = existsSync(readmePath) ? await readFile(readmePath, 'utf-8') : ''
    if (!readme.trim()) throw new Error(`${manifest.id} 缺少 README.md`)
    return
  }
  throw new Error(`${manifest.id} 缺少 plugins/<name>/plugin.json 与 README.md`)
}

function packageSourceUrl(packageName, baseUrl) {
  if (!baseUrl) return `packages/${packageName}`
  return `${String(baseUrl).replace(/\/$/, '')}/${packageName}`
}

function inferTags(manifest) {
  const tags = new Set(Array.isArray(manifest.type) ? manifest.type : [])
  const id = String(manifest.id ?? '').toLowerCase()
  if (id.includes('bilibili')) tags.add('bilibili')
  if (id.includes('ytmusic') || id.includes('youtube')) tags.add('youtube-music')
  return [...tags]
}

function compareSemver(left, right) {
  const leftParts = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  generatePluginIndex({
    repoRoot: readArg('--repo-root'),
    baseUrl: process.env.PLUGIN_BASE_URL || readArg('--base-url'),
    repository: process.env.PLUGIN_REPOSITORY || readArg('--repository'),
    homepage: process.env.PLUGIN_HOMEPAGE || readArg('--homepage'),
    validateOnly: process.argv.includes('--validate'),
    write: !process.argv.includes('--validate')
  })
    .then((index) => {
      console.log(`${process.argv.includes('--validate') ? 'Validated' : 'Generated'} ${index.plugins.length} plugin entries`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
