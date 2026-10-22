import { pathToFileURL } from 'node:url'

// DSH's public CLI deliberately reserves the desktop profile for the Electron
// application. Use its same compiled CLI carrier and explicit application flag.
const cli = process.env.DSH_BOTS_DSH_CLI
if (!cli) throw new Error('DSH_BOTS_DSH_CLI is required; invoke dev:embedded-codex instead')
const { runCli } = await import(pathToFileURL(cli).href)
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm run')
await runCli({ manageDesktopProfile: true, packageManager: { command: process.execPath, args: [pnpm] } })
