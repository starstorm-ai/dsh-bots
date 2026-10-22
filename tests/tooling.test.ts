import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { integrationEnvironment, parseIntegrationArgs, verifyPreservedProfile } from '../scripts/lib/integration.mts'
import { resolveDshRoot } from '../scripts/lib/paths.mts'
import { assertBuild, recordBuild } from '../scripts/lib/artifacts.mts'

describe('embedded-codex development installation', () => {
  it('targets the existing desktop dev profile and never launches implicitly', () => {
    const options = parseIntegrationArgs([], { DSH_EMBEDDED_CODEX_ROOT: resolve('fixture-embedded') })
    expect(options.home).toBe(resolve('fixture-embedded/.tmp/dsh-home'))
    expect(options.profile).toBe('desktop')
    expect(options.cli).toBe(resolve('fixture-embedded/.tmp/desktop-source/apps/cli/lib/bin.js'))
    expect(options.sourceRoot).toBe(resolve('fixture-embedded/.tmp/desktop-source'))
    expect(resolveDshRoot({ DSH_EMBEDDED_CODEX_ROOT: resolve('fixture-embedded') })).toBe(options.sourceRoot)
    expect(options.launch).toBe(false)
  })
  it('supports explicit roots, profiles and an inspectable dry run', () => {
    const options = parseIntegrationArgs(['--home', 'fixture-home', '--profile', 'web', '--dry-run', '--install-only'], {})
    expect(options.home).toBe(resolve('fixture-home'))
    expect(options.cli).toMatch(/upstream[\\/]deepseek-harness[\\/]apps[\\/]cli[\\/]lib[\\/]bin.js$/)
    expect(options.sourceRoot).toBe(resolve(options.embeddedRoot, 'upstream/deepseek-harness'))
    expect(options.dryRun).toBe(true)
  })
  it('passes the selected embedded checkout to build and install without mutating the parent environment', () => {
    const env = { DSH_EMBEDDED_CODEX_ROOT: resolve('old-embedded'), KEEP_SETTING: 'kept' }
    const options = parseIntegrationArgs(['--embedded-root', 'new-embedded'], env)
    const child = integrationEnvironment(options, env)
    expect(child.DSH_EMBEDDED_CODEX_ROOT).toBe(resolve('new-embedded'))
    expect(child.DSH_HOME).toBe(options.home)
    expect(child.DSH_BOTS_DSH_CLI).toBe(options.cli)
    expect(child.KEEP_SETTING).toBe('kept')
    expect(resolveDshRoot(child)).toBe(resolve('new-embedded/.tmp/desktop-source'))
    expect(env.DSH_EMBEDDED_CODEX_ROOT).toBe(resolve('old-embedded'))
  })
  it('derives the SDK from an explicit compiled CLI and supports a source override for custom carriers', () => {
    const cli = resolve('custom-sdk/apps/cli/lib/bin.js')
    expect(parseIntegrationArgs(['--cli', cli], {}).sourceRoot).toBe(resolve('custom-sdk'))
    expect(parseIntegrationArgs([], { DSH_BOTS_DSH_CLI: cli }).sourceRoot).toBe(resolve('custom-sdk'))
    const options = parseIntegrationArgs(['--cli', 'carrier/bin.js', '--source-root', 'selected-sdk'], { DSH_SOURCE_ROOT: resolve('old-sdk') })
    expect(options.sourceRoot).toBe(resolve('selected-sdk'))
    expect(resolveDshRoot(integrationEnvironment(options, {}))).toBe(options.sourceRoot)
    expect(parseIntegrationArgs([], { DSH_SOURCE_ROOT: resolve('custom-sdk') }).sourceRoot).toBe(resolve('custom-sdk'))
  })
  it('rejects traversal, missing values and contradictory actions before side effects', () => {
    expect(() => parseIntegrationArgs(['--profile', '../desktop'], {})).toThrow('Invalid profile')
    expect(() => parseIntegrationArgs(['--home'], {})).toThrow('Missing value')
    expect(() => parseIntegrationArgs(['--source-root'], {})).toThrow('Missing value')
    expect(() => parseIntegrationArgs(['--launch', '--install-only'], {})).toThrow('mutually exclusive')
  })
  it('accepts an additive install but detects removal or modification of another plugin', () => {
    const before = { name: 'existing', dependencies: { other: 'file:original.tgz' }, dsh: { profile: { bundles: ['base', 'other'] }, custom: true } }
    const after = { ...before, dependencies: { ...before.dependencies, 'dsh-bots': 'file:bots.tgz' }, dsh: { ...before.dsh, profile: { bundles: ['base', 'other', 'dsh-bots'] } } }
    expect(() => verifyPreservedProfile(before, after)).not.toThrow()
    expect(() => verifyPreservedProfile(before, { ...after, dependencies: { other: 'file:changed.tgz' } })).toThrow('unrelated dependency')
    expect(() => verifyPreservedProfile(before, { ...after, dsh: { profile: { bundles: ['base', 'dsh-bots'] } } })).toThrow('unrelated bundle')
    expect(() => verifyPreservedProfile(before, { ...after, dsh: { ...after.dsh, profile: { bundles: ['other', 'base', 'dsh-bots'] } } })).toThrow('unrelated bundle order')
    expect(() => verifyPreservedProfile(before, { ...after, dsh: { ...after.dsh, custom: false } })).toThrow('unrelated DSH settings')
  })
  it('rejects skip-build artifacts from another SDK, changed build helpers, or modified outputs', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'dsh-bots-build-'))
    try {
      for (const folder of ['.tmp', 'lib', 'scripts/lib', 'desktop-sdk', 'upstream-sdk']) mkdirSync(resolve(root, folder), { recursive: true })
      const desktop = resolve(root, 'desktop-sdk')
      const upstream = resolve(root, 'upstream-sdk')
      writeFileSync(resolve(root, 'lib/client.js'), 'verified client')
      writeFileSync(resolve(root, 'scripts/lib/paths.mts'), 'original helper')
      expect(() => assertBuild(desktop, root)).toThrow('No verified build')
      recordBuild(desktop, root)
      expect(() => assertBuild(desktop, root)).not.toThrow()
      expect(() => assertBuild(upstream, root)).toThrow('different DSH SDK checkout')
      writeFileSync(resolve(root, 'scripts/lib/paths.mts'), 'changed helper')
      expect(() => assertBuild(desktop, root)).toThrow('stale or incomplete')
      recordBuild(desktop, root)
      writeFileSync(resolve(root, 'lib/client.js'), 'partial build')
      expect(() => assertBuild(desktop, root)).toThrow('stale or incomplete')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
