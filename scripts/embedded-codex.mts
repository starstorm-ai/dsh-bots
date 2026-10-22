import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { integrationEnvironment, parseIntegrationArgs, readProfile, verifyPreservedProfile } from './lib/integration.mts'
import { ROOT } from './lib/paths.mts'
import { run, tsx } from './lib/process.mts'
import { packPlugin } from './pack.mts'

const options = parseIntegrationArgs(process.argv.slice(2))
const profile = resolve(options.home, 'profiles', options.profile)
const manifestPath = resolve(profile, 'package.json')
const plan = { action: options.remove ? 'remove' : 'build, pack, install', repository: ROOT, embeddedRoot: options.embeddedRoot, sourceRoot: options.sourceRoot, home: options.home, profile: options.profile, cli: options.cli, launch: options.launch }
console.log(JSON.stringify(plan, null, 2))
if (options.dryRun) process.exit(0)
if (!existsSync(options.cli)) throw new Error(`DSH CLI not built: ${options.cli}. Run pnpm build:desktop in the embedded-codex repository first.`)
if (!existsSync(manifestPath)) throw new Error(`Existing development profile required: ${manifestPath}. Initialize the embedded-codex dev DSH first; this command does not create or reset its settings.`)
const before = readProfile(manifestPath)
const patchPath = resolve(profile, 'cordis.patch.yml')
const previousPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
const backup = resolve(ROOT, '.tmp/profile-backups', `${Date.now()}-${options.profile}`)
mkdirSync(backup, { recursive: true })
for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
  if (existsSync(resolve(profile, name))) copyFileSync(resolve(profile, name), resolve(backup, name))
}
const env = integrationEnvironment(options)
const tarball = options.remove ? undefined : await packPlugin(options.skipBuild, env)
await tsx('scripts/dsh-cli.mts', ['plugin', '--profile', options.profile, options.remove ? 'remove' : 'add', options.remove ? 'dsh-bots' : tarball!, '--config.prefer-offline=true', '--config.fetch-retries=0', '--config.fetch-timeout=15000', ...(options.offline ? ['--config.offline=true'] : [])], env)
// A prior interrupted add may have saved the dependency before DSH reconciled
// Bundle activation. Explicitly requesting installation enables our own Bundle
// through the same profile API under its lock, retaining all other selections.
if (!options.remove) {
  const require = createRequire(options.cli)
  const { withFileLock } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  const { writeProfileBundles } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  await withFileLock(manifestPath, async () => {
    const current = readProfile(manifestPath)
    const bundles = current.dsh?.profile?.bundles ?? []
    if (!bundles.includes('dsh-bots')) writeProfileBundles(profile, current, [...bundles, 'dsh-bots'])
  }, { waitMs: 30_000 })
}
const after = readProfile(manifestPath)
verifyPreservedProfile(before, after)
if (previousPatch !== undefined && readFileSync(patchPath, 'utf8') !== previousPatch) throw new Error(`DSH changed the existing profile patch. A backup is at ${backup}`)
if (!options.remove) {
  const installed = resolve(profile, 'node_modules/dsh-bots')
  if (!existsSync(resolve(installed, 'lib/index.js')) || !existsSync(resolve(installed, 'lib/client.js'))) throw new Error('Installed plugin is missing Host or client artifacts')
  if (realpathSync(installed) === realpathSync(ROOT)) throw new Error('Expected a packed plugin installation, received source link')
  if (!after.dsh?.profile?.bundles?.includes('dsh-bots')) throw new Error('DSH did not activate the dsh-bots bundle')
  if (readFileSync(resolve(installed, 'lib/index.js'), 'utf8') !== readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8')) throw new Error('Installed Host differs from local build')
}
writeFileSync(resolve(ROOT, '.tmp/embedded-install.json'), JSON.stringify({ ...plan, tarball, installedAt: new Date().toISOString(), backup }, null, 2))
console.log(`dsh-bots ${options.remove ? 'removed from' : 'installed in'} ${profile}. Existing bundles/settings preserved. Backup: ${backup}`)
if (options.launch && !options.remove) {
  const desktopSource = resolve(options.embeddedRoot, '.tmp/desktop-source')
  await run(process.execPath, [resolve(options.embeddedRoot, 'node_modules/tsx/dist/cli.mjs'), resolve(desktopSource, 'apps/desktop/scripts/dev.ts'), '--skip-build'], {
    cwd: desktopSource,
    env: { ...env, DSH_DESKTOP_USER_DATA_DIR: process.env.DSH_DESKTOP_USER_DATA_DIR || resolve(options.embeddedRoot, '.tmp/electron-user-data') },
  })
} else if (!options.remove) {
  console.log(`Restart the running DSH Host to load the new version, or run pnpm dev:embedded-codex --launch. The chat invitation button starts HTTPS/WSS automatically.`)
}
