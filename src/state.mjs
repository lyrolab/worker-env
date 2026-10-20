import { randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  statSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { commandLine, isAlive } from "./process.mjs"

export const SUPERVISOR_SCRIPT = "supervisor.mjs"
export const LOCK_HELD_EXIT_CODE = 3

export const newEnvId = (name) =>
  `${name}_worker_${randomBytes(6).toString("hex")}`

export function stateDir(root) {
  const dir = join(root, ".worker")
  mkdirSync(dir, { recursive: true })
  if (realpathSync(dir) !== dir)
    throw new Error(`${dir} must be a real directory of this checkout`)
  const ignore = join(dir, ".gitignore")
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n")
  return dir
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

const runtimeFile = (root) => join(root, ".worker", "runtime.json")

export const readRuntime = (root) => readJson(runtimeFile(root))

// `up` and `status` poll this file, so it is replaced atomically, never seen half written.
export function writeRuntime(root, runtime) {
  const file = runtimeFile(root)
  writeFileSync(`${file}.tmp`, `${JSON.stringify(runtime, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const lockDir = (root) => join(root, ".worker", "dev.lock")

export const readLockOwner = (root) => readJson(join(lockDir(root), "owner"))

// A reused pid would otherwise make an unrelated process look like this
// checkout's supervisor.
export function isSupervisor(pid, root) {
  if (!isAlive(pid)) return false
  const command = commandLine(pid)
  return command.includes(SUPERVISOR_SCRIPT) && command.includes(root)
}

// Between mkdir and writing the owner file the lock has no owner yet; a fresh
// ownerless lock is a supervisor starting, not a stale one.
const startingLock = (root) => {
  try {
    return Date.now() - statSync(lockDir(root)).mtimeMs < 5_000
  } catch {
    return false
  }
}

export function liveSupervisor(root) {
  const owner = readLockOwner(root)
  return owner && isSupervisor(owner.pid, root) ? owner.pid : undefined
}

export class LockHeldError extends Error {}

export function acquireLock(root) {
  const dir = lockDir(root)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid }))
      return
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!readLockOwner(root) && startingLock(root))
        throw new LockHeldError(`A worker env is starting in ${root}`)
      const pid = liveSupervisor(root)
      if (pid)
        throw new LockHeldError(
          `A worker env already runs in ${root} (supervisor pid ${pid})`,
        )
      rmSync(dir, { recursive: true, force: true })
    }
  }
  throw new Error(`Could not acquire ${dir}`)
}

export function releaseLock(root) {
  const owner = readLockOwner(root)
  if (!owner || owner.pid === process.pid)
    rmSync(lockDir(root), { recursive: true, force: true })
}
