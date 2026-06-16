const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const DEFAULT_TWILIGHT_ROOT = path.resolve(__dirname, '..', '..', 'Twilight_Echo-main')

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function relativePackageUrl(packageName) {
  const baseUrl = process.env.PLUGIN_BASE_URL || readArg('--base-url')
  if (!baseUrl) return `packages/${packageName}`
  return `${baseUrl.replace(/\/$/, '')}/${packageName}`
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'))
}

async function main() {
  const pluginName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
  if (!pluginName) throw new Error('Usage: node scripts/pack-plugin.cjs <plugin-directory-name>')

  const repoRoot = path.resolve(__dirname, '..')
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName)
  const twilightRoot = path.resolve(
    process.env.TWILIGHT_ECHO_ROOT || readArg('--twilight-root') || DEFAULT_TWILIGHT_ROOT
  )
  const { createZip } = require(path.join(twilightRoot, 'packages', 'create-twilight-plugin', 'lib', 'zip.cjs'))
  const { validatePluginManifest } = require(path.join(
    twilightRoot,
    'packages',
    'create-twilight-plugin',
    'lib',
    'manifest.cjs'
  ))

  const manifestPath = path.join(pluginRoot, 'plugin.json')
  const manifest = validatePluginManifest(await readJson(manifestPath))
  const packageName = `${manifest.id}-${manifest.version}.tep`
  const packagesDir = path.join(repoRoot, 'packages')
  const stagingDir = path.join(repoRoot, '.cache', `${manifest.id}-${manifest.version}`)
  const packagePath = path.join(packagesDir, packageName)

  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(stagingDir, { recursive: true })
  await fs.copyFile(manifestPath, path.join(stagingDir, 'plugin.json'))
  if (manifest.main) {
    await fs.copyFile(path.join(pluginRoot, manifest.main), path.join(stagingDir, manifest.main))
  }
  if (manifest.binary) {
    for (const binaryPath of Object.values(manifest.binary)) {
      await fs.mkdir(path.dirname(path.join(stagingDir, binaryPath)), { recursive: true })
      await fs.copyFile(path.join(pluginRoot, binaryPath), path.join(stagingDir, binaryPath))
    }
  }

  await createZip(stagingDir, packagePath)
  await fs.rm(stagingDir, { recursive: true, force: true })

  const buffer = await fs.readFile(packagePath)
  const checksumSha256 = createHash('sha256').update(buffer).digest('hex')
  const sourceUrl = process.env.PLUGIN_SOURCE_URL || readArg('--source-url') || relativePackageUrl(packageName)
  const repository =
    process.env.PLUGIN_REPOSITORY ||
    readArg('--repository') ||
    'https://github.com/asenyarzc-cpu/Twilight-Echo-plugins'
  const homepage = process.env.PLUGIN_HOMEPAGE || readArg('--homepage') || repository

  const indexPath = path.join(repoRoot, 'plugins.json')
  let index = { schemaVersion: 1, plugins: [] }
  try {
    index = await readJson(indexPath)
  } catch {
    /* create a new index */
  }
  const entry = {
    ...manifest,
    sourceUrl,
    checksumSha256,
    repository,
    homepage,
    tags: manifest.type.includes('provider') ? ['provider', 'ui', 'bilibili'] : manifest.type,
    verified: true
  }
  index.plugins = Array.isArray(index.plugins)
    ? index.plugins.filter((plugin) => plugin && plugin.id !== manifest.id)
    : []
  index.plugins.push(entry)
  index.plugins.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8')

  console.log(`Packed ${packagePath}`)
  console.log(`sha256 ${checksumSha256}`)
  console.log(`index ${indexPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
