import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMBEDDED_ROOT, resolveDshRoot } from './paths.mts'

export interface IntegrationOptions {
  embeddedRoot: string
  home: string
  profile: string
  cli: string
  sourceRoot: string
  dryRun: boolean
  remove: boolean
  launch: boolean
  skipBuild: boolean
  offline: boolean
}
export interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; [key: string]: unknown }
  [key: string]: unknown
}
export function parseIntegrationArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): IntegrationOptions {
  const flags = new Set(['--dry-run', '--remove', '--launch', '--install-only', '--skip-build', '--offline'])
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (flags.has(arg)) continue
    if (!['--embedded-root', '--home', '--profile', '--cli', '--source-root'].includes(arg)) throw new Error(`Unknown option: ${arg}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}`)
    values.set(arg, value)
  }
  const embeddedRoot = resolve(values.get('--embedded-root') || env.DSH_EMBEDDED_CODEX_ROOT || EMBEDDED_ROOT)
  const profile = values.get('--profile') || env.DSH_BOTS_PROFILE || 'desktop'
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error(`Invalid profile name: ${profile}`)
  if (args.includes('--launch') && args.includes('--install-only')) throw new Error('--launch and --install-only are mutually exclusive')
  if (args.includes('--launch') && profile !== 'desktop') throw new Error('--launch requires the desktop profile')
  const cli = resolve(values.get('--cli') || env.DSH_BOTS_DSH_CLI || resolve(embeddedRoot, profile === 'desktop' ? '.tmp/desktop-source/apps/cli/lib/bin.js' : 'upstream/deepseek-harness/apps/cli/lib/bin.js'))
  const sourceRoot = resolveDshRoot({ ...env, DSH_EMBEDDED_CODEX_ROOT: embeddedRoot, DSH_BOTS_PROFILE: profile, DSH_BOTS_DSH_CLI: cli, DSH_SOURCE_ROOT: values.get('--source-root') || env.DSH_SOURCE_ROOT })
  return {
    embeddedRoot, profile, cli, sourceRoot,
    home: resolve(values.get('--home') || env.DSH_BOTS_DSH_HOME || resolve(embeddedRoot, '.tmp/dsh-home')),
    dryRun: args.includes('--dry-run'), remove: args.includes('--remove'), launch: args.includes('--launch'), skipBuild: args.includes('--skip-build'),
    offline: args.includes('--offline'),
  }
}
export function integrationEnvironment(options: IntegrationOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, DSH_EMBEDDED_CODEX_ROOT: options.embeddedRoot, DSH_SOURCE_ROOT: options.sourceRoot, DSH_BOTS_PROFILE: options.profile, DSH_HOME: options.home, DSH_BOTS_DSH_CLI: options.cli }
}
export function readProfile(path: string): ProfileManifest { return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest }
/** Enforce that the DSH package operation retained every unrelated top-level setting and dependency. */
export function verifyPreservedProfile(before: ProfileManifest, after: ProfileManifest): void {
  for (const [name, value] of Object.entries(before.dependencies ?? {})) {
    if (name !== 'dsh-bots' && after.dependencies?.[name] !== value) throw new Error(`Profile changed unrelated dependency ${name}`)
  }
  for (const name of before.dsh?.profile?.bundles ?? []) {
    if (name !== 'dsh-bots' && !after.dsh?.profile?.bundles?.includes(name)) throw new Error(`Profile removed unrelated bundle ${name}`)
  }
  const existingBundles = (before.dsh?.profile?.bundles ?? []).filter(name => name !== 'dsh-bots')
  const retainedOrder = (after.dsh?.profile?.bundles ?? []).filter(name => existingBundles.includes(name))
  if (JSON.stringify(existingBundles) !== JSON.stringify(retainedOrder)) throw new Error('Profile changed unrelated bundle order')
  for (const [key, value] of Object.entries(before)) {
    if (key !== 'dependencies' && key !== 'dsh' && JSON.stringify(after[key]) !== JSON.stringify(value)) throw new Error(`Profile changed unrelated setting ${key}`)
  }
  const withoutBundles = (manifest: ProfileManifest) => {
    const result = structuredClone(manifest.dsh ?? {})
    if (result.profile) delete result.profile.bundles
    return result
  }
  if (JSON.stringify(withoutBundles(before)) !== JSON.stringify(withoutBundles(after))) throw new Error('Profile changed unrelated DSH settings')
}
