import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { isAlive, sleep } from "../src/process.mjs"
import { defaultLockDir, slotPath } from "../src/verify.mjs"

const bin = fileURLToPath(new URL("../bin/worker.mjs", import.meta.url))
const holdingCommand = `
  require('node:fs').writeFileSync(process.argv[1], String(process.pid));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
`

async function eventually(predicate, description) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  assert.fail(`Timed out: ${description}`)
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-verify-")))
  const lockDir = join(root, "locks")
  const lock = slotPath(lockDir, 0)
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, "SIGTERM")
        const exited = await Promise.race([
          child.result.then(() => true),
          sleep(2000).then(() => false),
        ])
        if (!exited) process.kill(-child.pid, "SIGKILL")
      }
      await child.result
    }
    rmSync(root, { recursive: true, force: true })
  })

  function start(args, options = {}) {
    const child = spawn(process.execPath, [bin, "verify", ...args], {
      cwd: options.cwd ?? root,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKER_VERIFY_LOCK_DIR: lockDir,
        WORKER_VERIFY_SLOTS: "1",
        ...options.env,
      },
    })
    child.output = ""
    child.errors = ""
    child.stdout.on("data", (data) => (child.output += data))
    child.stderr.on("data", (data) => (child.errors += data))
    child.result = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    children.push(child)
    return child
  }
  async function run(args, options) {
    const child = start(args, options)
    child.stdin.end()
    const result = await child.result
    return { ...result, output: child.output, errors: child.errors }
  }
  async function hold(options = {}) {
    const marker = join(root, `ready-${children.length}`)
    const child = start(
      ["--", process.execPath, "-e", holdingCommand, marker],
      options,
    )
    await eventually(() => existsSync(marker), "holder ready")
    return { child, marker }
  }
  async function acquire(options) {
    const result = await run(["--wait", "0", "--", "true"], options)
    assert.equal(result.code, 0, result.errors)
  }
  return { root, lockDir, lock, start, run, hold, acquire }
}

describe("worker verify", () => {
  test("a held slot excludes contenders from any directory without starting them", async (t) => {
    const f = fixture(t)
    const { child } = await f.hold()
    const inode = statSync(f.lock).ino
    const other = join(f.root, "other-checkout")
    mkdirSync(other)
    for (const cwd of [f.root, other]) {
      const marker = join(f.root, "unexpected")
      const started = Date.now()
      const result = await f.run(["--wait", "1", "--", "touch", marker], {
        cwd,
      })
      assert.equal(result.code, 75)
      assert.ok(Date.now() - started >= 700)
      assert.ok(Date.now() - started < 10_000)
      assert.equal(existsSync(marker), false)
    }
    child.stdin.end()
    assert.equal((await child.result).code, 0)
    await f.acquire()
    assert.equal(statSync(f.lock).ino, inode)
  })

  test("configured slots run that many commands concurrently and exclude the next contender", async (t) => {
    const f = fixture(t)
    const env = { WORKER_VERIFY_SLOTS: "2" }
    const first = await f.hold({ env })
    const second = await f.hold({ env })
    const marker = join(f.root, "third")
    const third = await f.run(["--wait", "1", "--", "touch", marker], { env })
    assert.equal(third.code, 75)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(slotPath(f.lockDir, 1)), true)
    second.child.stdin.end()
    assert.equal((await second.child.result).code, 0)
    await f.acquire({ env })
    first.child.stdin.end()
    assert.equal((await first.child.result).code, 0)
  })

  for (const status of [75, 197, 1])
    test(`a child exiting ${status} runs once and keeps its status`, async (t) => {
      const f = fixture(t)
      const counter = join(f.root, "runs")
      const result = await f.run(
        [
          "--",
          "sh",
          "-c",
          `echo run >> "$1"; exit ${status}`,
          "child",
          counter,
        ],
        { env: { WORKER_VERIFY_SLOTS: "3" } },
      )
      assert.equal(result.code, status)
      assert.equal(readFileSync(counter, "utf8"), "run\n")
    })

  test("a waiting contender starts only after the holder releases", async (t) => {
    const f = fixture(t)
    const { child } = await f.hold()
    const marker = join(f.root, "waiter")
    const waiter = f.start(["--wait", "10", "--", "touch", marker])
    await eventually(
      () => waiter.errors.includes("acquiring"),
      "waiter entering acquisition",
    )
    await sleep(300)
    assert.equal(existsSync(marker), false)
    child.stdin.end()
    assert.equal((await child.result).code, 0)
    assert.equal((await waiter.result).code, 0)
    assert.equal(existsSync(marker), true)
  })

  test("exit statuses, missing executables and reacquisition keep the lock file contents and inode", async (t) => {
    const f = fixture(t)
    mkdirSync(f.lockDir, { recursive: true })
    writeFileSync(f.lock, "stable contents")
    const inode = statSync(f.lock).ino
    for (const status of [0, 23, 75]) {
      const result = await f.run(["--", "sh", "-c", `exit ${status}`])
      assert.equal(result.code, status)
      assert.match(result.errors, /wait <= 300s/)
      assert.match(result.errors, /busy or child exit 75/)
      await f.acquire()
    }
    const missing = await f.run(["--", "worker-env-nonexistent-command"])
    assert.equal(missing.code, 127)
    await f.acquire()
    assert.equal(statSync(f.lock).ino, inode)
    assert.equal(readFileSync(f.lock, "utf8"), "stable contents")
  })

  test("invalid arguments, settings and lock paths fail without a child", async (t) => {
    const f = fixture(t)
    const marker = join(f.root, "unexpected")
    const command = ["--", "touch", marker]
    for (const args of [
      [],
      ["--"],
      ["--", ""],
      ["true"],
      ["--wait"],
      ["--unknown", ...command],
      ...["", "-1", "1.2", "abc"].map((value) => ["--wait", value, ...command]),
    ]) {
      const result = await f.run(args)
      assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.errors}`)
      assert.match(result.errors, /Usage: worker verify/)
    }
    writeFileSync(join(f.root, "file"), "not a directory")
    for (const path of [
      "",
      "relative-locks",
      join(f.root, "file"),
      join(f.root, "file/locks"),
    ]) {
      const result = await f.run(command, {
        env: { WORKER_VERIFY_LOCK_DIR: path },
      })
      assert.equal(result.code, 2, `${path}: ${result.errors}`)
    }
    mkdirSync(f.lock, { recursive: true })
    assert.equal((await f.run(command)).code, 2)
    rmSync(f.lock, { recursive: true })
    for (const slots of ["", "0", "-1", "two"]) {
      const result = await f.run(command, {
        env: { WORKER_VERIFY_SLOTS: slots },
      })
      assert.equal(result.code, 2, `${slots}: ${result.errors}`)
    }
    assert.equal(existsSync(marker), false)
  })

  test("cwd, environment, exact argv and standard streams reach the command", async (t) => {
    const f = fixture(t)
    const cwd = join(f.root, "packages/backend")
    mkdirSync(cwd, { recursive: true })
    const args = [
      "",
      "two words",
      "$(touch forbidden)",
      "'quoted'",
      "*",
      "--flag",
    ]
    const child = f.start(
      [
        "--",
        process.execPath,
        "-e",
        `
    process.stderr.write('child stderr');
    process.stdin.on('data', (data) => process.stdout.write(JSON.stringify({
      cwd: process.cwd(), env: process.env.FIXTURE_VALUE, args: process.argv.slice(1), input: data.toString()
    })));
  `,
        "--",
        ...args,
      ],
      { cwd, env: { FIXTURE_VALUE: "preserved" } },
    )
    child.stdin.end("fixture stdin")
    assert.equal((await child.result).code, 0)
    assert.deepEqual(JSON.parse(child.output), {
      cwd,
      env: "preserved",
      args,
      input: "fixture stdin",
    })
    assert.match(child.errors, /child stderr/)
    assert.equal(existsSync(join(cwd, "forbidden")), false)
  })

  for (const signal of ["SIGINT", "SIGTERM"])
    test(`${signal} to the process group stops the command and releases the slot`, async (t) => {
      const f = fixture(t)
      const { child, marker } = await f.hold()
      const pid = Number(readFileSync(marker, "utf8"))
      const inode = statSync(f.lock).ino
      process.kill(-child.pid, signal)
      const result = await child.result
      assert.equal(result.signal, signal)
      await eventually(() => !isAlive(pid), "command stopped")
      await f.acquire()
      assert.equal(statSync(f.lock).ino, inode)
    })

  test("a signal to the launcher alone reaches the command", async (t) => {
    const f = fixture(t)
    const { child, marker } = await f.hold()
    const pid = Number(readFileSync(marker, "utf8"))
    child.kill("SIGTERM")
    assert.equal((await child.result).signal, "SIGTERM")
    await eventually(() => !isAlive(pid), "command stopped")
    await f.acquire()
  })

  test("a killed launcher holds no slot", async (t) => {
    const f = fixture(t)
    const { child } = await f.hold()
    child.kill("SIGKILL")
    await child.result
    await eventually(
      () =>
        spawnSync(
          process.execPath,
          [bin, "verify", "--wait", "0", "--", "true"],
          {
            env: {
              ...process.env,
              WORKER_VERIFY_LOCK_DIR: f.lockDir,
              WORKER_VERIFY_SLOTS: "1",
            },
          },
        ).status === 0,
      "slot released",
    )
  })

  test("detached descendants stay alive without retaining the slot", async (t) => {
    const f = fixture(t)
    const marker = join(f.root, "detached")
    t.after(() => {
      if (existsSync(marker)) {
        try {
          process.kill(Number(readFileSync(marker, "utf8")), "SIGTERM")
        } catch {}
      }
    })
    const result = await f.run([
      "--",
      process.execPath,
      "-e",
      `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore'
    });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid));
    child.unref();
  `,
      marker,
    ])
    assert.equal(result.code, 0)
    const pid = Number(readFileSync(marker, "utf8"))
    assert.ok(isAlive(pid))
    await f.acquire()
    assert.ok(isAlive(pid))
  })

  test("an interactive shell holds its slot until it exits", async (t) => {
    const f = fixture(t)
    const ready = join(f.root, "shell-ready")
    const child = f.start(["--", "sh"])
    child.stdin.write(`touch '${ready}'\n`)
    await eventually(() => existsSync(ready), "shell ready")
    assert.equal((await f.run(["--wait", "0", "--", "true"])).code, 75)
    child.stdin.end("exit 0\n")
    assert.equal((await child.result).code, 0)
    await f.acquire()
  })

  const flock = spawnSync("flock", ["--version"]).status === 0
  test(
    "a slot held through flock(1) excludes the launcher",
    { skip: !flock && "flock(1) is not installed" },
    async (t) => {
      const f = fixture(t)
      mkdirSync(f.lockDir, { recursive: true })
      const holder = spawn("flock", [f.lock, "cat"], {
        stdio: ["pipe", "ignore", "ignore"],
      })
      t.after(() => holder.kill())
      await eventually(
        () => spawnSync("flock", ["-n", f.lock, "true"]).status !== 0,
        "flock holder ready",
      )
      assert.equal((await f.run(["--wait", "0", "--", "true"])).code, 75)
      holder.stdin.end()
      await new Promise((done) => holder.once("close", done))
      await f.acquire()
    },
  )

  test("the default lock directory is a per-user cache directory", () => {
    assert.equal(
      defaultLockDir({ XDG_CACHE_HOME: "/xdg" }, "linux"),
      "/xdg/worker-env/verify",
    )
    assert.equal(
      defaultLockDir({ XDG_CACHE_HOME: "relative" }, "linux"),
      join(homedir(), ".cache", "worker-env", "verify"),
    )
    assert.equal(
      defaultLockDir({}, "darwin"),
      join(homedir(), "Library", "Caches", "worker-env", "verify"),
    )
  })
})
