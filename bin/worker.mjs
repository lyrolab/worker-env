#!/usr/bin/env node
import { down, status, up } from "../src/commands.mjs"
import { ConfigError } from "../src/config.mjs"
import { init } from "../src/init.mjs"

const commands = { up, down, status, init }
const usage = `Usage: worker <command>

Commands:
  up              install, start the env in the background and print its URLs
  down            stop the env of this checkout
  status [--json] print the env of this checkout; exit 1 when none runs
  init [--check]  write .claude/rules/worker-env.md; with --check, exit 1 when it differs`

const [name, ...args] = process.argv.slice(2)
const command = commands[name]
if (!command) {
  console.error(usage)
  process.exit(name === undefined || name === "--help" || name === "-h" ? 0 : 1)
}

try {
  process.exitCode = await command(args)
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error.stack)
  process.exitCode = 1
}
