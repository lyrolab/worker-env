import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { capture, isAlive, sleep } from "../src/process.mjs"
import { provider } from "../src/resources.mjs"

const bin = fileURLToPath(new URL("../bin/worker.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("../fixture", import.meta.url))
const ORIGIN = /http:\/\/(my-app_worker_[0-9a-f]{12})\.my-app\.localhost:\d+/

const checkouts = []
const { WORKER_ENV_TEST_POSTGRES: POSTGRES, WORKER_ENV_TEST_REDIS: REDIS } =
  process.env
const IDLE = { WORKER_ENV_IDLE_TIMEOUT_MS: "1500" }

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

function exec(container, args) {
  const result = capture("docker", ["exec", container, ...args])
  assert.ok(result.ok, result.stderr)
  return result.stdout
}

const postgres = () =>
  provider({
    type: "postgres",
    container: POSTGRES,
    user: "postgres",
    url: "postgres://localhost",
  })

const hasDatabase = async (id) =>
  (await postgres().list("my-app")).some((record) => record.id === id)

const redisKeys = (pattern) =>
  exec(REDIS, ["redis-cli", "--scan", "--pattern", pattern])
    .split("\n")
    .filter(Boolean)

const openWebSocket = (origin) =>
  new Promise((done, reject) => {
    const socket = new WebSocket(`${origin.replace("http", "ws")}/hmr`)
    socket.onopen = () => done(socket)
    socket.onerror = () => reject(new Error(`WebSocket to ${origin} failed`))
  })

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

describe("worker up with resources", () => {
  test("a missing container fails up and names it", async () => {
    const dir = checkout()
    const result = await worker(dir, ["up"], {
      FIXTURE_POSTGRES: "worker-env-test-missing",
    })
    assert.equal(result.code, 1)
    assert.match(
      result.stderr,
      /resources\.db: container worker-env-test-missing is not running/,
    )
    assert.equal(runtime(dir).status, "failed")
  })

  test(
    "creates the database before setup, records its owner and drops it on down",
    {
      skip: !POSTGRES && "set WORKER_ENV_TEST_POSTGRES to a Postgres container",
    },
    async () => {
      const dir = checkout()
      const db = provider({
        type: "postgres",
        container: POSTGRES,
        user: "postgres",
        url: "postgres://localhost",
      })
      const result = await worker(dir, ["up"], { FIXTURE_POSTGRES: POSTGRES })
      assert.equal(result.code, 0, result.stderr)
      const env = runtime(dir)
      const url = `postgres://postgres:postgres@localhost:5432/${env.id}`
      assert.deepEqual(env.resources, {
        db: { type: "postgres", database: env.id, url },
      })
      assert.equal(
        readFileSync(join(dir, "setup.txt"), "utf8"),
        `${env.id} ${env.services.api.url} ${url}\n`,
      )
      const [record] = (await db.list("my-app")).filter(
        ({ id }) => id === env.id,
      )
      assert.deepEqual(record.owner, {
        host: hostname(),
        pid: env.pid,
        root: dir,
        groups: servicePids(dir),
      })

      assert.equal((await worker(dir, ["down"])).code, 0)
      assert.ok(!(await db.list("my-app")).some(({ id }) => id === env.id))
    },
  )

  test(
    "a failing service drops the database",
    {
      skip: !POSTGRES && "set WORKER_ENV_TEST_POSTGRES to a Postgres container",
    },
    async () => {
      const dir = checkout()
      const result = await worker(dir, ["up"], {
        FIXTURE_POSTGRES: POSTGRES,
        FIXTURE_FAIL: "start",
      })
      assert.equal(result.code, 1)
      const { id } = runtime(dir)
      const db = provider({
        type: "postgres",
        container: POSTGRES,
        user: "postgres",
        url: "postgres://localhost",
      })
      assert.ok(!(await db.list("my-app")).some((record) => record.id === id))
    },
  )
})

describe("idle stop", () => {
  test("stops an env with no connection for the idle timeout", async () => {
    const dir = checkout()
    const result = await worker(dir, ["up"], IDLE)
    assert.equal(result.code, 0, result.stderr)
    const env = runtime(dir)
    assert.equal(env.idleTimeoutMs, 1500)

    const status = await worker(dir, ["status"])
    assert.match(
      status.stdout,
      /Idle; it stops in [12]s unless a connection opens/,
    )
    const json = JSON.parse((await worker(dir, ["status", "--json"])).stdout)
    assert.ok(json.idleStopInMs > 0 && json.idleStopInMs <= 1500)

    const pids = servicePids(dir)
    await waitFor(() => !isAlive(env.pid))
    assert.equal(runtime(dir).status, "stopped")
    assert.equal(runtime(dir).stoppedBy, "idle")
    assert.ok(pids.every((pid) => !isAlive(pid)))
  })

  test("an open WebSocket keeps the env alive until it closes", async () => {
    const dir = checkout()
    const result = await worker(dir, ["up"], IDLE)
    assert.equal(result.code, 0, result.stderr)
    const env = runtime(dir)
    const socket = await openWebSocket(env.services.web.origin)

    await sleep(4000)
    assert.ok(isAlive(env.pid), "the WebSocket holds the env")
    const status = await worker(dir, ["status"])
    assert.equal(status.code, 0)
    assert.match(status.stdout, /Connections are open; it stops 2s after/)
    assert.equal(
      JSON.parse((await worker(dir, ["status", "--json"])).stdout).idleStopInMs,
      null,
    )

    socket.close()
    await waitFor(() => !isAlive(env.pid))
    assert.equal(runtime(dir).stoppedBy, "idle")
  })

  test(
    "drops the database of an idle env",
    {
      skip: !POSTGRES && "set WORKER_ENV_TEST_POSTGRES to a Postgres container",
    },
    async () => {
      const dir = checkout()
      const result = await worker(dir, ["up"], {
        ...IDLE,
        FIXTURE_POSTGRES: POSTGRES,
      })
      assert.equal(result.code, 0, result.stderr)
      const env = runtime(dir)
      assert.ok(await hasDatabase(env.id))
      await waitFor(() => !isAlive(env.pid))
      assert.ok(!(await hasDatabase(env.id)))
    },
  )
})

describe("collection on up", () => {
  test("stops the services a killed supervisor left in this checkout", async () => {
    const dir = checkout()
    assert.equal((await worker(dir, ["up"])).code, 0)
    const { pid } = runtime(dir)
    const pids = servicePids(dir)
    process.kill(pid, "SIGKILL")
    await waitFor(() => !isAlive(pid))
    assert.ok(pids.every(isAlive), "services outlive a killed supervisor")

    const again = await worker(dir, ["up"])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /Stopping orphaned process group/)
    assert.ok(pids.every((service) => !isAlive(service)))
    assert.notEqual(runtime(dir).pid, pid)
    await worker(dir, ["down"])
  })

  test(
    "collects the database, Redis keys and process groups of a killed supervisor",
    {
      skip:
        !(POSTGRES && REDIS) &&
        "set WORKER_ENV_TEST_POSTGRES and WORKER_ENV_TEST_REDIS",
    },
    async () => {
      const resources = { FIXTURE_POSTGRES: POSTGRES, FIXTURE_REDIS: REDIS }
      const [live, killed, next] = [checkout(), checkout(), checkout()]
      exec(REDIS, ["redis-cli", "SET", "my-app:owner", "kept"])
      exec(POSTGRES, [
        "psql",
        "-U",
        "postgres",
        "-c",
        'CREATE DATABASE "my-app"',
      ])
      try {
        for (const dir of [live, killed])
          assert.equal((await worker(dir, ["up"], resources)).code, 0)
        const [a, b] = [runtime(live), runtime(killed)]
        exec(REDIS, ["redis-cli", "SET", `${b.id}:jobs`, "1"])
        const orphans = servicePids(killed)
        process.kill(b.pid, "SIGKILL")
        await waitFor(() => !isAlive(b.pid))

        const result = await worker(next, ["up"], resources)
        assert.equal(result.code, 0, result.stderr)
        assert.match(result.stdout, new RegExp(`Collecting worker env ${b.id}`))
        assert.ok(
          orphans.every((pid) => !isAlive(pid)),
          "orphans stopped",
        )
        assert.ok(!(await hasDatabase(b.id)), "database dropped")
        assert.deepEqual(redisKeys(`${b.id}*`), [], "Redis keys deleted")

        assert.equal((await worker(live, ["status"])).code, 0, "live env kept")
        assert.ok(await hasDatabase(a.id))
        assert.notDeepEqual(redisKeys(`${a.id}*`), [])
        assert.ok(servicePids(live).every(isAlive))
        assert.equal(
          exec(REDIS, ["redis-cli", "GET", "my-app:owner"]),
          "kept",
          "owner keys untouched",
        )
        assert.equal(
          exec(POSTGRES, [
            "psql",
            "-U",
            "postgres",
            "-tAc",
            "SELECT count(*) FROM pg_database WHERE datname = 'my-app'",
          ]),
          "1",
          "owner database untouched",
        )
      } finally {
        await Promise.all([live, next].map((dir) => worker(dir, ["down"])))
        exec(REDIS, ["redis-cli", "DEL", "my-app:owner"])
        exec(POSTGRES, [
          "psql",
          "-U",
          "postgres",
          "-c",
          'DROP DATABASE "my-app"',
        ])
      }
    },
  )
})
