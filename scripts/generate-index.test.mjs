import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createZip } from '../../Twilight_Echo-main/packages/create-twilight-plugin/lib/zip.cjs'
import { generatePluginIndex } from './generate-index.mjs'

const manifest = {
  id: 'com.example.generated',
  name: 'Generated Plugin',
  version: '1.2.3',
  description: 'A generated test plugin',
  author: 'Example',
  license: 'Apache-2.0',
  type: ['tool'],
  main: 'index.mjs',
  engines: {
    twilightEcho: '>=0.20.0'
  },
  apiVersion: 1,
  permissions: ['player:observe']
}

test('generates plugins.json from packaged tep files', async () => {
  const root = await createRepoFixture()
  const packagePath = await createPluginPackage(root, manifest)
  const checksumSha256 = createHash('sha256').update(await readFile(packagePath)).digest('hex')

  const index = await generatePluginIndex({ repoRoot: root, write: true })
  const written = JSON.parse(await readFile(join(root, 'plugins.json'), 'utf-8'))

  assert.equal(index.schemaVersion, 1)
  assert.deepEqual(written, index)
  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].id, manifest.id)
  assert.equal(index.plugins[0].sourceUrl, `packages/${manifest.id}-${manifest.version}.tep`)
  assert.equal(index.plugins[0].checksumSha256, checksumSha256)
  assert.equal(index.plugins[0].repository, 'https://github.com/asenyarzc-cpu/Twilight-Echo-plugins')
  assert.equal(index.plugins[0].verified, true)
})

test('validate mode rejects a stale plugins.json', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, manifest)
  await writeFile(
    join(root, 'plugins.json'),
    JSON.stringify({ schemaVersion: 1, plugins: [] }, null, 2),
    'utf-8'
  )

  await assert.rejects(
    () => generatePluginIndex({ repoRoot: root, validateOnly: true }),
    /plugins.json is out of date/
  )
})

test('keeps only the latest package for each plugin id', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, { ...manifest, version: '1.0.0' })
  await createPluginPackage(root, { ...manifest, version: '1.2.3' })

  const index = await generatePluginIndex({ repoRoot: root })

  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].version, '1.2.3')
  assert.equal(index.plugins[0].sourceUrl, `packages/${manifest.id}-1.2.3.tep`)
})

test('rejects packages without plugin README and bundled plugin ids', async () => {
  const missingReadmeRoot = await createRepoFixture()
  await createPluginPackage(missingReadmeRoot, manifest, { readme: false })
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: missingReadmeRoot }),
    /README/
  )

  const bundledRoot = await createRepoFixture()
  await createPluginPackage(bundledRoot, {
    ...manifest,
    id: 'com.twilightecho.provider.ncm',
    name: 'NCM'
  })
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: bundledRoot }),
    /内置/
  )
})

async function createRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-index-generator-'))
  await mkdir(join(root, 'packages'), { recursive: true })
  await mkdir(join(root, 'plugins'), { recursive: true })
  return root
}

async function createPluginPackage(root, pluginManifest, options = {}) {
  const pluginName = pluginManifest.id.split('.').at(-1)
  const pluginDir = join(root, 'plugins', pluginName)
  const stagingDir = join(root, '.cache', pluginManifest.id)
  await mkdir(pluginDir, { recursive: true })
  await mkdir(stagingDir, { recursive: true })
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8')
  await writeFile(join(pluginDir, 'README.md'), '# Test plugin\n', 'utf-8')
  if (options.readme === false) {
    await writeFile(join(pluginDir, 'README.md'), '', 'utf-8')
  }
  await writeFile(join(stagingDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8')
  await writeFile(join(stagingDir, 'index.mjs'), 'export function activate() {}', 'utf-8')
  const packagePath = resolve(root, 'packages', `${pluginManifest.id}-${pluginManifest.version}.tep`)
  await createZip(stagingDir, packagePath)
  return packagePath
}
