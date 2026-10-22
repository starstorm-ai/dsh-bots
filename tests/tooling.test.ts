import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parseIntegrationArgs, verifyPreservedProfile } from '../scripts/lib/integration.mts'

describe('embedded-codex development installation', () => {
  it('targets the existing desktop dev profile and never launches implicitly', () => {
    const options = parseIntegrationArgs([], { DSH_EMBEDDED_CODEX_ROOT: resolve('fixture-embedded') })
    expect(options.home).toBe(resolve('fixture-embedded/.tmp/dsh-home'))
    expect(options.profile).toBe('desktop')
    expect(options.cli).toBe(resolve('fixture-embedded/.tmp/desktop-source/apps/cli/lib/bin.js'))
    expect(options.launch).toBe(false)
  })
  it('supports explicit roots, profiles and an inspectable dry run', () => {
    const options = parseIntegrationArgs(['--home', 'fixture-home', '--profile', 'web', '--dry-run', '--install-only'], {})
    expect(options.home).toBe(resolve('fixture-home'))
    expect(options.cli).toMatch(/upstream[\\/]deepseek-harness[\\/]apps[\\/]cli[\\/]lib[\\/]bin.js$/)
    expect(options.dryRun).toBe(true)
  })
  it('rejects traversal, missing values and contradictory actions before side effects', () => {
    expect(() => parseIntegrationArgs(['--profile', '../desktop'], {})).toThrow('Invalid profile')
    expect(() => parseIntegrationArgs(['--home'], {})).toThrow('Missing value')
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
})
