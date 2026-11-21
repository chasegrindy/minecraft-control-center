import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'releases')
const id = process.argv[2]
if (process.argv.length !== 3 || !/^[a-z0-9][a-z0-9.-]{0,47}$/.test(id)) {
  console.error('Podaj identyfikator wydania, np. 0.1.0-20261118.1.')
  process.exit(1)
}

const name = 'mcc-' + id
const filename = name + '.tar.gz'
const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const workspaceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const runtime = ['unzipit', 'web-push']
const dependencies = Object.fromEntries(runtime.map((name) => [name, workspace.dependencies[name]]))
if (workspaceLock.lockfileVersion !== 3 || runtime.some((name) =>
  workspaceLock.packages['node_modules/' + name]?.version !== dependencies[name])) {
  throw new Error('Lockfile nie odpowiada zależności uruchomieniowej paczki.')
}
const manifest = { name: workspace.name, version: workspace.version, private: true, type: 'module',
  engines: workspace.engines, dependencies,
  scripts: { start: 'node apps/api/server.mjs', account: 'node apps/api/account-cli.mjs',
    'backup:offsite': 'node apps/api/offsite-import.mjs', 'backup:restore': 'node apps/api/offsite-restore.mjs' } }
const lockRoot = { name: manifest.name, version: manifest.version, engines: manifest.engines, dependencies: manifest.dependencies }
const packages = { '': lockRoot }
const pending = [...runtime]
for (const name of pending) {
  const key = 'node_modules/' + name
  if (packages[key]) continue
  const entry = workspaceLock.packages[key]
  if (!entry || !/^sha512-/.test(entry.integrity) || entry.hasInstallScript || entry.optionalDependencies
    || Object.keys(entry.peerDependencies ?? {}).some((peer) => !entry.peerDependenciesMeta?.[peer]?.optional)) {
    throw new Error('Nieobsługiwana zależność uruchomieniowa paczki: ' + name)
  }
  packages[key] = entry
  for (const child of Object.keys(entry.dependencies ?? {})) {
    if (workspaceLock.packages[key + '/node_modules/' + child]) throw new Error('Niepłaska zależność uruchomieniowa: ' + child)
    pending.push(child)
  }
}
const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }

async function copySelected(source, destination, pattern, required = []) {
  const entries = await readdir(source, { withFileTypes: true })
  const selected = entries.filter(({ name }) => pattern.test(name))
  if (!selected.length || selected.some((entry) => !entry.isFile())
    || required.some((name) => !selected.some((entry) => entry.name === name))) {
    throw new Error('Brak kompletnych plików wydania w ' + source)
  }
  await mkdir(destination, { recursive: true })
  for (const { name } of selected) await copyFile(join(source, name), join(destination, name))
}

await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(output, '.prepare-'))
try {
  const payload = join(temporary, 'payload')
  const sealed = join(temporary, 'package')
  const archive = join(sealed, filename)
  await mkdir(sealed)
  await copySelected(join(root, 'apps', 'api'), join(payload, 'apps', 'api'), /^[a-z][a-z0-9-]*\.mjs$/,
    ['server.mjs', 'account-cli.mjs', 'offsite-import.mjs', 'offsite-restore.mjs'])
  await copySelected(join(root, 'apps', 'ops'), join(payload, 'ops'), /^mcc\.service$/, ['mcc.service'])
  await copySelected(join(root, 'dist'), join(payload, 'dist'), /^(?:index\.html|manifest\.webmanifest|favicon\.png|push-worker\.js)$/,
    ['index.html', 'manifest.webmanifest', 'favicon.png', 'push-worker.js'])
  await copySelected(join(root, 'dist', 'assets'), join(payload, 'dist', 'assets'), /^[A-Za-z0-9_.-]+\.(?:js|css|woff2|png|jpg|webp)$/)
  await writeFile(join(payload, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(payload, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  await writeFile(join(payload, 'release.json'), JSON.stringify({ id, version: manifest.version, builtAt: new Date().toISOString() }, null, 2) + '\n')
  await exec('tar', ['-czf', archive, '-C', payload, 'dist', 'apps', 'ops', 'package.json', 'package-lock.json', 'release.json'])
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  await writeFile(join(sealed, filename + '.sha256'), hash.digest('hex') + '  ' + filename + '\n')
  const destination = join(output, name)
  await rename(sealed, destination)
  console.log(join(destination, filename))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
