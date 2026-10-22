import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { setupDsh } from './setup-dsh.mts'
import { DSH_ROOT, ROOT } from './lib/paths.mts'
import { run } from './lib/process.mts'
import { recordBuild } from './lib/artifacts.mts'

setupDsh()
mkdirSync(resolve(ROOT, 'lib'), { recursive: true })

async function generateTypert(): Promise<void> {
  const { WorkspaceAnalyzer } = await import(pathToFileURL(resolve(DSH_ROOT, 'packages/typert/generator/src/analyzer.ts')).href)
  const { FaceModelEmitter } = await import(pathToFileURL(resolve(DSH_ROOT, 'packages/typert/generator/src/emitter.ts')).href)
  // DSH's generator inventories packages/* projects. Mirror only our sources
  // into our disposable workspace; never write a shadow package into the SDK.
  const workspaceRoot = resolve(ROOT, '.tmp/typert-workspace')
  const shadow = resolve(workspaceRoot, 'packages/plugin')
  if (!shadow.startsWith(resolve(ROOT, '.tmp') + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe Typert mirror path')
  rmSync(shadow, { recursive: true, force: true })
  mkdirSync(shadow, { recursive: true })
  cpSync(resolve(ROOT, 'packages'), resolve(shadow, 'packages'), { recursive: true })
  cpSync(resolve(ROOT, 'src'), resolve(shadow, 'src'), { recursive: true })
  const metadata = resolve(workspaceRoot, 'packages/typert-protocol')
  mkdirSync(metadata, { recursive: true })
  cpSync(resolve(DSH_ROOT, 'packages/typert/protocol/src'), resolve(metadata, 'src'), { recursive: true })
  cpSync(resolve(DSH_ROOT, 'packages/typert/protocol/package.json'), resolve(metadata, 'package.json'))
  writeFileSync(resolve(metadata, 'tsconfig.json'), JSON.stringify({ extends: resolve(ROOT, 'tsconfig.json'), include: ['src'] }))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  manifest.exports = { '.': './src/index.ts', './types': './src/types.ts', './protocol': './packages/protocol/src/index.ts' }
  delete manifest.dsh.client
  writeFileSync(resolve(shadow, 'package.json'), JSON.stringify(manifest))
  writeFileSync(resolve(shadow, 'tsconfig.json'), JSON.stringify({ extends: resolve(ROOT, 'tsconfig.json'), compilerOptions: { paths: { '@deepseek-ai/dsh-typert-protocol': [resolve(metadata, 'src/index.ts')], '@deepseek-ai/dsh-typert-protocol/*': [resolve(metadata, 'src/*.ts')] } }, include: ['src/index.ts', 'src/types.ts', 'packages/protocol/src', 'packages/core/src', 'packages/dsh-plugin/src'] }))
  const config = resolve(workspaceRoot, 'tsconfig.host.json')
  writeFileSync(config, JSON.stringify({ extends: resolve(shadow, 'tsconfig.json'), files: [], include: [], references: [{ path: metadata }, { path: shadow }] }))
  const workspace = new WorkspaceAnalyzer({ root: workspaceRoot, hostConfig: config, packages: ['dsh-bots'], faces: ['host'], checkDiagnostics: false }).analyze()
  const face = workspace.faces.find((entry: { face: string }) => entry.face === 'host')
  if (!face) throw new Error('Typert did not discover the dsh-bots Host face')
  const artifact = new FaceModelEmitter(face).emit('dsh-bots')
  if (!artifact.remote) { writeFileSync(resolve(ROOT, '.tmp/typert-model.json'), JSON.stringify(workspace, null, 2)); throw new Error('Typert did not generate the dsh-bots remote contract; see .tmp/typert-model.json') }
  for (const [path, source] of Object.entries({ 'typert.host.js': artifact.js, 'typert.host.d.ts': artifact.dts, 'typert.remote-client.js': artifact.remote.js, 'typert.remote-client.d.ts': artifact.remote.dts })) writeFileSync(resolve(ROOT, 'lib', path), source as string)
}

await generateTypert()
await run(process.execPath, [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'])
if (process.argv.includes('--check')) { console.log('DSH Bots typecheck passed'); process.exit(0) }

await run(process.execPath, [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.host.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'lib/types', '--rootDir', '.'])
mkdirSync(resolve(ROOT, 'lib/types/client'), { recursive: true })
writeFileSync(resolve(ROOT, 'lib/types/index.d.ts'), "export * from './packages/dsh-plugin/src/index.js';\nexport { default } from './packages/dsh-plugin/src/index.js';\n")
writeFileSync(resolve(ROOT, 'lib/types/types.d.ts'), "export type * from './src/types.js';\n")
writeFileSync(resolve(ROOT, 'lib/types/client/index.d.ts'), "import type { Context } from '@deepseek-ai/cordis';\nexport declare const inject: readonly string[];\nexport declare function apply(ctx: Context): void;\n")

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
await build({ absWorkingDir: ROOT, entryPoints: ['packages/dsh-plugin/src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', sourcemap: true })
await build({ absWorkingDir: ROOT, entryPoints: ['packages/protocol/src/index.ts'], outfile: 'lib/protocol.js', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022' })
const css: Plugin = { name: 'dsh-plugin-styles', setup(builder) {
  // Bundle the SDK's real CSS modules, preserving :global selectors and scoped
  // class mappings. Native components must not fall back to hand-copied styles.
  builder.onLoad({ filter: /\.module\.css$/, namespace: 'file' }, async ({ path }) => {
    const compiled = await build({ stdin: { contents: `export { default } from ${JSON.stringify(path)};`, resolveDir: dirname(path), loader: 'js' }, bundle: true, write: false, outdir: resolve(ROOT, '.tmp/native-css'), format: 'esm', loader: { '.css': 'local-css', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' })
    const js = compiled.outputFiles.find(file => file.path.endsWith('.js'))!.text
    const styles = compiled.outputFiles.find(file => file.path.endsWith('.css'))!.text
    return { contents: `${js}\nconst tag=document.createElement('style');tag.dataset.plugin='dsh-bots';tag.textContent=${JSON.stringify(styles)};document.head.appendChild(tag);`, loader: 'js' }
  })
  builder.onResolve({ filter: /\.css\?inline$/ }, ({ path, importer }) => ({ path: resolve(dirname(importer), path.replace(/\?inline$/, '')), namespace: 'inline-css' }))
  builder.onLoad({ filter: /\.css$/, namespace: 'inline-css' }, async ({ path }) => ({ contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`, loader: 'js' }))
  builder.onLoad({ filter: /\.css$/, namespace: 'file' }, async ({ path }) => ({ contents: `const tag=document.createElement('style');tag.dataset.plugin='dsh-bots';tag.textContent=${JSON.stringify(readFileSync(path, 'utf8'))};document.head.appendChild(tag);`, loader: 'js' }))
} }
const client = await build({ absWorkingDir: ROOT, entryPoints: ['packages/desktop-ui/src/index.ts'], outfile: 'lib/client.js', bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, sourcemap: 'external', minify: false,
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', ...manifest.dsh.client.external],
  alias: { 'dsh-bots/remote': resolve(ROOT, 'lib/typert.remote-client.js') }, plugins: [css], loader: { '.png': 'dataurl' },
  banner: { js: "window.__ModuleLoader__.load({id:'dsh-bots',factory:(require)=>{var module={exports:{}};var exports=module.exports;" }, footer: { js: 'return module.exports;}});' },
})
for (const file of client.outputFiles) writeFileSync(file.path, file.contents)
for (const file of ['index.js', 'client.js', 'protocol.js', 'typert.host.js', 'typert.remote-client.js']) if (!existsSync(resolve(ROOT, 'lib', file))) throw new Error(`Missing artifact: ${file}`)
const js = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')
if (/require\("node:|require\("(?:fs|https|net|tls)"/.test(js)) throw new Error('Browser bundle contains a Node dependency')
recordBuild()
console.log('Built dsh-bots Host, desktop client, protocol and Typert contracts.')
