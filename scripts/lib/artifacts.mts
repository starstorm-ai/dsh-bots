import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DSH_ROOT, ROOT } from './paths.mts'

function hashes(root: string, patterns: readonly string[]): Record<string, string> {
  return Object.fromEntries(globSync([...patterns], { cwd: root }).filter(path => statSync(resolve(root, path)).isFile()).sort().map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]))
}
function sources(root: string): Record<string, string> { return hashes(root, ['packages/**/src/**/*', 'packages/protocol/schema/*.json', 'src/**/*', 'tsconfig*.json', 'package.json', 'scripts/**/*.mts']) }
export function recordBuild(sdkRoot = DSH_ROOT, root = ROOT): void { writeFileSync(resolve(root, '.tmp/build-manifest.json'), JSON.stringify({ sdkRoot: realpathSync(sdkRoot), sources: sources(root), outputs: hashes(root, ['lib/**/*']) }, null, 2)) }
export function assertBuild(sdkRoot = DSH_ROOT, root = ROOT): void {
  const file = resolve(root, '.tmp/build-manifest.json')
  if (!existsSync(file)) throw new Error('No verified build exists. Run pnpm build before --skip-build.')
  const expected = JSON.parse(readFileSync(file, 'utf8')) as { sdkRoot?: string; sources: Record<string, string>; outputs: Record<string, string> }
  if (expected.sdkRoot !== realpathSync(sdkRoot)) throw new Error('Build artifacts use a different DSH SDK checkout. Rebuild for the target Host without --skip-build.')
  if (JSON.stringify(expected.sources) !== JSON.stringify(sources(root)) || JSON.stringify(expected.outputs) !== JSON.stringify(hashes(root, ['lib/**/*']))) throw new Error('Build artifacts are stale or incomplete. Run pnpm build; --skip-build cannot publish a partial build.')
}
