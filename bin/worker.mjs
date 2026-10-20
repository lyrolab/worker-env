#!/usr/bin/env node
import { down, status, up } from "../src/commands.mjs"
import { ConfigError } from "../src/config.mjs"

const commands = { up, down, status }
const usage = `Usage: worker <command>

Commands:
  up              install, start the env in the background and print its URLs
  down            stop the env of this checkout
  status [--json] print the env of this checkout; exit 1 when none runs`

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
