import { globSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDsh, DSH_ROOT, ROOT } from './lib/paths.mts'

/** Link the already-built SDK read-only. Only links inside our node_modules are changed. */
export function setupDsh(): void {
  assertDsh()
  const links: Record<string, string> = {}
  for (const file of globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'native/*/package.json', 'native/*/packages/*/package.json'], { cwd: DSH_ROOT })) {
    const source = dirname(resolve(DSH_ROOT, file))
    const manifest = JSON.parse(readFileSync(resolve(DSH_ROOT, file), 'utf8')) as { name?: string }
    if (!manifest.name?.startsWith('@deepseek-ai/')) continue
    const target = resolve(ROOT, 'node_modules', manifest.name)
    mkdirSync(dirname(target), { recursive: true })
    const previous = lstatSync(target, { throwIfNoEntry: false })
    if (previous) {
      if (realpathSync(target).toLowerCase() === realpathSync(source).toLowerCase()) { links[manifest.name] = source; continue }
      if (!previous.isSymbolicLink()) throw new Error(`Refusing to replace a real package directory: ${target}`)
      unlinkSync(target)
    }
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    links[manifest.name] = source
  }
  mkdirSync(resolve(ROOT, '.tmp'), { recursive: true })
  writeFileSync(resolve(ROOT, '.tmp/dsh-sdk.json'), `${JSON.stringify({ root: DSH_ROOT, links }, null, 2)}\n`)
  console.log(`DSH SDK ready (${Object.keys(links).length} local package links): ${DSH_ROOT}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) setupDsh()
