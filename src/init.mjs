import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { findRoot } from "./config.mjs"

export const RULES_FILE = join(".claude", "rules", "worker-env.md")

const rules = readFileSync(new URL("rules.md", import.meta.url), "utf8")

function read(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

export async function init(args) {
  const root = findRoot()
  const file = join(root, RULES_FILE)
  const shown = relative(process.cwd(), file)
  const current = read(file)

  if (current === rules) {
    console.log(`${shown} is up to date`)
    return 0
  }
  if (args.includes("--check")) {
    console.error(
      `${shown} ${current === undefined ? "is missing" : "differs from the installed @lyrolab/worker-env"}. Run \`worker init\` to update it.`,
    )
    return 1
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, rules)
  console.log(`Wrote ${shown}`)
  return 0
}
