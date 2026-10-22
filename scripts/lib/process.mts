import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { ROOT } from './paths.mts'

export async function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {}): Promise<string> {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? done(output) : reject(new Error(`${command} failed (${signal ?? code})`)))
  })
}
export async function tsx(file: string, args: readonly string[] = [], env = process.env): Promise<string> {
  return run(process.execPath, [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(ROOT, file), ...args], { env })
}
export async function pnpm(args: readonly string[], cwd = ROOT): Promise<string> {
  const executable = process.env.npm_execpath
  if (!executable) throw new Error('Run this command using pnpm run so npm_execpath selects the package manager without a shell.')
  return run(process.execPath, [executable, '--pm-on-fail=ignore', ...args], { cwd })
}
