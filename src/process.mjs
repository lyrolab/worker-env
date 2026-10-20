import { spawn, spawnSync } from "node:child_process"
import { closeSync, openSync, readlinkSync } from "node:fs"
import { createServer } from "node:net"

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

export const commandLine = (pid) =>
  capture("ps", ["-ww", "-o", "command=", "-p", String(pid)]).stdout

function workingDirectory(pid) {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return ""
    }
  }
  const lsof = capture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
  const line = lsof.stdout.split("\n").find((field) => field.startsWith("n"))
  return line?.slice(1) ?? ""
}

// A recorded process group may be gone and its id reused, so a group is only
// signalled while its leader still runs from inside the checkout that recorded it.
export function leadsGroupIn(pgid, root) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  const group = capture("ps", ["-o", "pgid=", "-p", String(pgid)])
  if (!group.ok || Number(group.stdout) !== pgid) return false
  const cwd = workingDirectory(pgid)
  return cwd === root || cwd.startsWith(`${root}/`)
}

export const freePort = () =>
  new Promise((done, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
  } catch {}
}

export async function killGroups(groups, timeoutMs = 15_000) {
  const targets = groups.filter((pgid) => Number.isInteger(pgid) && pgid > 1)
  for (const pgid of targets) signalGroup(pgid, "SIGTERM")
  const deadline = Date.now() + timeoutMs
  while (targets.some(groupAlive) && Date.now() < deadline) await sleep(100)
  for (const pgid of targets.filter(groupAlive)) signalGroup(pgid, "SIGKILL")
}

// Every child leads a process group of its own, so teardown signals everything it
// started. Tools that move their children to another group (pnpm scripts do)
// escape that signal.
export function spawnLogged({
  command,
  args = [],
  shell = false,
  cwd,
  env,
  logFile,
}) {
  const log = openSync(logFile, "a")
  try {
    return spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      shell,
      stdio: ["ignore", log, log],
    })
  } finally {
    closeSync(log)
  }
}

export function runStep({ label, ...options }) {
  return new Promise((done, reject) => {
    const child = spawnLogged(options)
    options.onSpawn?.(child)
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) done()
      else
        reject(
          new Error(
            `${label} failed (${signal ?? code}); see ${options.logFile}`,
          ),
        )
    })
  })
}

export async function waitForHttp(url, { timeoutMs, isAlive: alive }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (alive && !alive()) return false
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      await response.body?.cancel()
      if (response.status < 500) return true
    } catch {}
    await sleep(250)
  }
  return false
}
