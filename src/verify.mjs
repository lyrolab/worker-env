import { spawn } from "node:child_process"
import { closeSync, constants, mkdirSync, openSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { sleep } from "./process.mjs"

export const BUSY_EXIT_CODE = 75
const DEFAULT_SLOTS = "3"
const DEFAULT_WAIT_SECONDS = "300"
const USAGE = "Usage: worker verify [--wait SECONDS] -- COMMAND [ARG...]"
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]

// Darwin and the BSDs take a flock(2) lock atomically in open(2); Node does not export the flag.
const O_EXLOCK = 0x20

class VerifyError extends Error {}

export function defaultLockDir(env = process.env, platform = process.platform) {
  const cache = isAbsolute(env.XDG_CACHE_HOME ?? "")
    ? env.XDG_CACHE_HOME
    : platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : join(homedir(), ".cache")
  return join(cache, "worker-env", "verify")
}

// The slot file names match the flock(1) launcher this command replaces, so
// both exclude each other while hosts migrate.
export const slotPath = (dir, slot) =>
  join(
    dir,
    slot === 0 ? "heavy-verification.lock" : `heavy-verification.${slot}.lock`,
  )

function parse(args, env) {
  let rest = args
  let wait = DEFAULT_WAIT_SECONDS
  if (rest[0] === "--wait") {
    if (rest.length < 2) throw new VerifyError("missing wait value")
    wait = rest[1]
    rest = rest.slice(2)
  }
  if (!/^\d+$/.test(wait))
    throw new VerifyError("wait must be a nonnegative integer")
  if (rest[0] !== "--") throw new VerifyError("expected -- before command")
  const [command, ...commandArgs] = rest.slice(1)
  if (!command) throw new VerifyError("missing command")

  const slots = env.WORKER_VERIFY_SLOTS ?? DEFAULT_SLOTS
  if (!/^\d+$/.test(slots) || Number(slots) === 0)
    throw new VerifyError("WORKER_VERIFY_SLOTS must be a positive integer")
  const lockDir = env.WORKER_VERIFY_LOCK_DIR ?? defaultLockDir(env)
  if (!isAbsolute(lockDir))
    throw new VerifyError("WORKER_VERIFY_LOCK_DIR must be absolute")

  return {
    waitSeconds: Number(wait),
    slots: Number(slots),
    lockDir,
    command,
    commandArgs,
  }
}

function slotPaths(lockDir, slots) {
  try {
    mkdirSync(lockDir, { recursive: true })
  } catch (error) {
    throw new VerifyError(`cannot create ${lockDir}: ${error.code}`)
  }
  if (!statSync(lockDir).isDirectory())
    throw new VerifyError(`${lockDir} must be a directory`)
  return Array.from({ length: slots }, (_, slot) => {
    const path = slotPath(lockDir, slot)
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats && !stats.isFile())
      throw new VerifyError(`lock path must be a regular file: ${path}`)
    return path
  })
}

// The descriptor is close-on-exec, so the command and its descendants never hold
// the slot, and the kernel releases it when this process exits.
function lockInProcess(path) {
  try {
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK,
    )
    return Promise.resolve({ release: async () => closeSync(fd) })
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
      return Promise.resolve(undefined)
    throw new VerifyError(`cannot lock ${path}: ${error.code}`)
  }
}

// Linux has no open-time lock, so flock(1) holds the slot in a session of its own
// that terminal signals miss. It prints a line once locked and keeps the lock
// until its stdin, a pipe only this process holds, closes: on release or when
// this process dies, even by SIGKILL.
function lockWithFlock(path) {
  return new Promise((resolve, reject) => {
    const holder = spawn(
      "flock",
      ["-n", path, "sh", "-c", "echo; exec cat >/dev/null"],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    let stderr = ""
    holder.stderr.on("data", (chunk) => (stderr += chunk))
    holder.stdin.on("error", () => {})
    holder.once("error", (error) =>
      reject(
        new VerifyError(
          error.code === "ENOENT"
            ? "util-linux flock is required on Linux"
            : `cannot start flock: ${error.message}`,
        ),
      ),
    )
    const exited = new Promise((done) => holder.once("close", done))
    holder.stdout.once("data", () =>
      resolve({
        release: () => {
          holder.stdin.end()
          return exited
        },
      }),
    )
    exited.then((code) => {
      if (code === 1) resolve(undefined)
      else reject(new VerifyError(`flock failed on ${path}: ${stderr.trim()}`))
    })
  })
}

const lockers = {
  linux: lockWithFlock,
  darwin: lockInProcess,
  freebsd: lockInProcess,
  openbsd: lockInProcess,
}

async function acquire(paths, waitSeconds) {
  const lock = lockers[process.platform]
  if (!lock) throw new VerifyError(`${process.platform} is not supported`)
  const deadline = Date.now() + waitSeconds * 1000
  for (;;) {
    for (const path of paths) {
      const held = await lock(path)
      if (held) return held
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    await sleep(Math.min(1000, remaining))
  }
}

function run(command, args) {
  return new Promise((done) => {
    const received = new Set()
    const child = spawn(command, args, { stdio: "inherit" })
    const forward = (signal) => {
      received.add(signal)
      child.kill(signal)
    }
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward)
    const finish = (result) => {
      for (const signal of FORWARDED_SIGNALS)
        process.removeListener(signal, forward)
      done(result)
    }
    child.once("error", (error) => {
      console.error(`worker verify: ${command}: ${error.message}`)
      finish({ code: error.code === "ENOENT" ? 127 : 126 })
    })
    child.once("exit", (code, signal) =>
      finish({ code, signal, received: received.has(signal) }),
    )
  })
}

export async function verify(args) {
  let options, held
  try {
    options = parse(args, process.env)
    const paths = slotPaths(options.lockDir, options.slots)
    console.error(
      `worker verify: acquiring one of ${options.slots} slots in ${options.lockDir} (wait <= ${options.waitSeconds}s); exit ${BUSY_EXIT_CODE} means busy or child exit ${BUSY_EXIT_CODE}`,
    )
    held = await acquire(paths, options.waitSeconds)
  } catch (error) {
    if (!(error instanceof VerifyError)) throw error
    console.error(`worker verify: ${error.message}\n${USAGE}`)
    return 2
  }
  if (!held) {
    console.error(
      `worker verify: no slot freed up within ${options.waitSeconds}s`,
    )
    return BUSY_EXIT_CODE
  }

  const result = await run(options.command, options.commandArgs)
  await held.release()
  if (!result.signal) return result.code
  if (result.received) {
    process.kill(process.pid, result.signal)
    await sleep(1000)
  }
  return 128 + constants.signals[result.signal]
}
