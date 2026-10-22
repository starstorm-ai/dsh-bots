import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './paths.mts'

function hashes(patterns: readonly string[]): Record<string, string> {
  return Object.fromEntries(globSync([...patterns], { cwd: ROOT }).filter(path => statSync(resolve(ROOT, path)).isFile()).sort().map(path => [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]))
}
function sources(): Record<string, string> { return hashes(['packages/**/src/**/*', 'packages/protocol/schema/*.json', 'src/**/*', 'tsconfig*.json', 'package.json', 'scripts/build.mts']) }
export function recordBuild(): void { writeFileSync(resolve(ROOT, '.tmp/build-manifest.json'), JSON.stringify({ sources: sources(), outputs: hashes(['lib/**/*']) }, null, 2)) }
export function assertBuild(): void {
  const file = resolve(ROOT, '.tmp/build-manifest.json')
  if (!existsSync(file)) throw new Error('No verified build exists. Run pnpm build before --skip-build.')
  const expected = JSON.parse(readFileSync(file, 'utf8')) as { sources: Record<string, string>; outputs: Record<string, string> }
  if (JSON.stringify(expected.sources) !== JSON.stringify(sources()) || JSON.stringify(expected.outputs) !== JSON.stringify(hashes(['lib/**/*']))) throw new Error('Build artifacts are stale or incomplete. Run pnpm build; --skip-build cannot publish a partial build.')
}
