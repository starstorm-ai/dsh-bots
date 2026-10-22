import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const EMBEDDED_ROOT = resolve(process.env.DSH_EMBEDDED_CODEX_ROOT || resolve(ROOT, '../dsh-embedded-codex'))
/** Compile against the same checkout as the target Host, including its client declarations. */
export function resolveDshRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SOURCE_ROOT) return resolve(env.DSH_SOURCE_ROOT)
  if (env.DSH_BOTS_DSH_CLI) {
    const lib = dirname(resolve(env.DSH_BOTS_DSH_CLI))
    const cli = dirname(lib)
    const apps = dirname(cli)
    if (basename(lib) === 'lib' && basename(cli) === 'cli' && basename(apps) === 'apps') return dirname(apps)
  }
  return resolve(env.DSH_EMBEDDED_CODEX_ROOT || EMBEDDED_ROOT, (env.DSH_BOTS_PROFILE || 'desktop') === 'desktop' ? '.tmp/desktop-source' : 'upstream/deepseek-harness')
}
export const DSH_ROOT = resolveDshRoot()
export function assertDsh(): void {
  const manifestPath = resolve(DSH_ROOT, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`DSH checkout not found: ${DSH_ROOT}. Run pnpm build:desktop in the embedded-codex repository first, or set DSH_SOURCE_ROOT to the built checkout used by your target Host (see README).`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
  if (manifest.version !== '0.2.0-rc.2') throw new Error(`Unsupported DSH ${manifest.version}; expected 0.2.0-rc.2. See compatibility.json.`)
  if (!existsSync(resolve(DSH_ROOT, 'vendor/cordis/lib/index.js'))) throw new Error(`DSH checkout has not been built: ${DSH_ROOT}. Run its documented install/build first.`)
}
