import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("../bin/worker.mjs", import.meta.url))
const rules = readFileSync(new URL("../src/rules.md", import.meta.url), "utf8")

const checkouts = []

function checkout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worker-env-init-")))
  writeFileSync(
    join(dir, "worker.config.mjs"),
    'export default { name: "my-app", services: {} }\n',
  )
  checkouts.push(dir)
  return dir
}

const worker = (cwd, args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" })

const rulesFile = (dir) => join(dir, ".claude", "rules", "worker-env.md")

after(() => {
  for (const dir of checkouts) rmSync(dir, { recursive: true, force: true })
})

describe("worker init", () => {
  test("writes the rules file identically on every run", () => {
    const dir = checkout()

    const first = worker(dir, ["init"])
    assert.equal(first.status, 0, first.stderr)
    const written = readFileSync(rulesFile(dir), "utf8")
    assert.equal(written, rules)

    const second = worker(dir, ["init"])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(rulesFile(dir), "utf8"), written)
  })

  test("writes at the checkout root from a subdirectory", () => {
    const dir = checkout()
    const sub = join(dir, "packages", "api")
    mkdirSync(sub, { recursive: true })

    const result = worker(sub, ["init"])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(rulesFile(dir), "utf8"), rules)
  })

  test("overwrites a manual edit", () => {
    const dir = checkout()
    worker(dir, ["init"])
    appendFileSync(rulesFile(dir), "- A local rule.\n")

    const result = worker(dir, ["init"])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(rulesFile(dir), "utf8"), rules)
  })
})

describe("worker init --check", () => {
  test("passes right after init", () => {
    const dir = checkout()
    worker(dir, ["init"])

    const result = worker(dir, ["init", "--check"])
    assert.equal(result.status, 0, result.stderr)
  })

  test("fails after a manual edit and leaves the file alone", () => {
    const dir = checkout()
    worker(dir, ["init"])
    appendFileSync(rulesFile(dir), "- A local rule.\n")
    const edited = readFileSync(rulesFile(dir), "utf8")

    const result = worker(dir, ["init", "--check"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /differs/)
    assert.equal(readFileSync(rulesFile(dir), "utf8"), edited)
  })

  test("fails when the file is missing", () => {
    const dir = checkout()

    const result = worker(dir, ["init", "--check"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing/)
  })
})
