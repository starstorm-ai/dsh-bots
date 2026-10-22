import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const EMBEDDED_ROOT = resolve(process.env.DSH_EMBEDDED_CODEX_ROOT || resolve(ROOT, '../dsh-embedded-codex'))
export const DSH_ROOT = resolve(process.env.DSH_SOURCE_ROOT || resolve(EMBEDDED_ROOT, 'upstream/deepseek-harness'))
export function assertDsh(): void {
  const manifestPath = resolve(DSH_ROOT, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`DSH checkout not found: ${DSH_ROOT}. Set DSH_SOURCE_ROOT to a built DeepSeek Harness checkout (see README).`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
  if (manifest.version !== '0.2.0-rc.2') throw new Error(`Unsupported DSH ${manifest.version}; expected 0.2.0-rc.2. See compatibility.json.`)
  if (!existsSync(resolve(DSH_ROOT, 'vendor/cordis/lib/index.js'))) throw new Error(`DSH checkout has not been built: ${DSH_ROOT}. Run its documented install/build first.`)
}
