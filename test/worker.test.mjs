import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { isAlive, sleep } from "../src/process.mjs"

const bin = fileURLToPath(new URL("../bin/worker.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("../fixture", import.meta.url))
const ORIGIN = /http:\/\/(my-app_worker_[0-9a-f]{12})\.my-app\.localhost:\d+/

const checkouts = []

function checkout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worker-env-test-")))
  cpSync(fixture, dir, {
    recursive: true,
    filter: (path) => !path.includes(".worker"),
  })
  checkouts.push(dir)
  return dir
}

function worker(cwd, args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("close", (code) => done({ code, stdout, stderr }))
  })
}

const runtime = (dir) =>
  JSON.parse(readFileSync(join(dir, ".worker", "runtime.json"), "utf8"))

const servicePids = (dir) =>
  Object.values(runtime(dir).services).map((service) => service.pid)

async function waitFor(condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await sleep(100)
  }
}

async function getJson(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  return response.json()
}

after(async () => {
  await Promise.all(checkouts.map((dir) => worker(dir, ["down"])))
  for (const dir of checkouts) rmSync(dir, { recursive: true, force: true })
})

describe("worker up", () => {
  test("starts a healthy env, is idempotent, and stops on down", async () => {
    const dir = checkout()

    const first = await worker(dir, ["up"])
    assert.equal(first.code, 0, first.stderr)
    const [origin, id] = ORIGIN.exec(first.stdout)
    const env = runtime(dir)
    assert.equal(env.id, id)
    assert.equal(env.status, "running")
    assert.equal(env.services.web.origin, origin)
    assert.equal(env.services.api.origin, env.services.api.url)
    assert.equal(
      readFileSync(join(dir, "setup.txt"), "utf8"),
      `${id} ${env.services.api.url}\n`,
    )

    assert.equal((await getJson(`${origin}/`)).app, "fixture")
    assert.deepEqual(await getJson(`${origin}/api`), {
      ok: true,
      body: '{"ok":true}',
    })
    assert.deepEqual(
      await getJson(`${origin}/self`),
      { ok: true, body: '{"ok":true}' },
      "a service reaches its own *.localhost origin",
    )

    const second = await worker(dir, ["up"])
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /Already running/)
    assert.equal(ORIGIN.exec(second.stdout)[0], origin)
    assert.equal(readFileSync(join(dir, "install.txt"), "utf8"), "installed\n")

    const status = await worker(dir, ["status", "--json"])
    assert.equal(status.code, 0)
    assert.equal(JSON.parse(status.stdout).id, id)

    const pids = [env.pid, ...servicePids(dir)]
    const down = await worker(dir, ["down"])
    assert.equal(down.code, 0, down.stderr)
    assert.ok(
      pids.every((pid) => !isAlive(pid)),
      "supervisor and services stopped",
    )
    assert.equal(runtime(dir).status, "stopped")
    assert.equal((await worker(dir, ["status"])).code, 1)
    assert.equal((await worker(dir, ["down"])).code, 0)
  })

  test("concurrent ups in one checkout share one env", async () => {
    const dir = checkout()
    const results = await Promise.all([
      worker(dir, ["up"]),
      worker(dir, ["up"]),
    ])
    for (const result of results) assert.equal(result.code, 0, result.stderr)
    const ids = results.map((result) => ORIGIN.exec(result.stdout)[1])
    assert.equal(ids[0], ids[1])
    await worker(dir, ["down"])
  })

  test("runs two envs from separate checkouts side by side", async () => {
    const dirs = [checkout(), checkout()]
    const results = await Promise.all(dirs.map((dir) => worker(dir, ["up"])))
    for (const result of results) assert.equal(result.code, 0, result.stderr)
    const [a, b] = dirs.map(runtime)
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.services.web.port, b.services.web.port)
    for (const env of [a, b])
      assert.equal(
        (await getJson(`${env.services.web.origin}/`)).app,
        "fixture",
      )

    assert.equal((await worker(dirs[0], ["down"])).code, 0)
    assert.equal(
      (await worker(dirs[1], ["status"])).code,
      0,
      "the other env keeps running",
    )
    assert.equal((await worker(dirs[1], ["down"])).code, 0)
  })

  test("a service failing at startup tears the env down", async () => {
    const dir = checkout()
    const result = await worker(dir, ["up"], { FIXTURE_FAIL: "start" })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /api exited \(1\)/)
    const env = runtime(dir)
    assert.equal(env.status, "failed")
    assert.ok([env.pid, ...servicePids(dir)].every((pid) => !isAlive(pid)))
    assert.equal((await worker(dir, ["status"])).code, 1)
  })

  test("a service exiting later tears the env down", async () => {
    const dir = checkout()
    const result = await worker(dir, ["up"], { FIXTURE_FAIL: "later" })
    assert.equal(result.code, 0, result.stderr)
    const { pid } = runtime(dir)
    const pids = servicePids(dir)
    await waitFor(() => !isAlive(pid))
    assert.equal(runtime(dir).status, "failed")
    assert.match(runtime(dir).error, /api exited/)
    assert.ok(
      pids.every((service) => !isAlive(service)),
      "the healthy web service stopped too",
    )

    const again = await worker(dir, ["up"])
    assert.equal(again.code, 0, again.stderr)
    assert.notEqual(runtime(dir).id, undefined)
    await worker(dir, ["down"])
  })
})
