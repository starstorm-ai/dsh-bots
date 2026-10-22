import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshRoot, ROOT } from './lib/paths.mts'
import { pnpm, tsx } from './lib/process.mts'
import { assertBuild } from './lib/artifacts.mts'

export async function packPlugin(skipBuild = false, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!skipBuild) await tsx('scripts/build.mts', [], env)
  assertBuild(resolveDshRoot(env))
  const output = resolve(ROOT, '.tmp/packs')
  mkdirSync(output, { recursive: true })
  await pnpm(['pack', '--config.ignore-scripts=true', '--pack-destination', output])
  const { name, version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
  const source = resolve(output, `${name}-${version}.tgz`)
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16)
  const target = resolve(output, `${name}-${version}-${digest}.tgz`)
  copyFileSync(source, target)
  return target
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await packPlugin(process.argv.includes('--skip-build')))
