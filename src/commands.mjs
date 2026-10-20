import { spawn } from "node:child_process"
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { collectDeadEnvs } from "./collect.mjs"
import { findRoot, loadConfig, resolveStep } from "./config.mjs"
import { isAlive, killGroups, runStep, sleep } from "./process.mjs"
import {
  LOCK_HELD_EXIT_CODE,
  SUPERVISOR_SCRIPT,
  liveSupervisor,
  readRuntime,
  stateDir,
} from "./state.mjs"

const supervisorPath = realpathSync(
  fileURLToPath(new URL(SUPERVISOR_SCRIPT, import.meta.url)),
)

const SETTLED = ["running", "failed", "stopped"]

export function idleStopInMs(runtime, now = Date.now()) {
  if (runtime.status !== "running" || !runtime.idleTimeoutMs) return undefined
  if (!runtime.idleSince) return null
  return Math.max(
    0,
    Date.parse(runtime.idleSince) + runtime.idleTimeoutMs - now,
  )
}

const duration = (ms) => {
  const seconds = Math.ceil(ms / 1000)
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

function idleLine(runtime) {
  const remaining = idleStopInMs(runtime)
  if (remaining === undefined) return []
  if (remaining === null)
    return [
      `Connections are open; it stops ${duration(runtime.idleTimeoutMs)} after the last one closes.`,
    ]
  return [`Idle; it stops in ${duration(remaining)} unless a connection opens.`]
}

function describe(runtime, root) {
  const services = Object.entries(runtime.services ?? {})
  const width = Math.max(0, ...services.map(([name]) => name.length))
  const lines = services.map(
    ([name, service]) =>
      `  ${name.padEnd(width)}  ${service.origin}${service.browser ? "   (browser)" : ""}`,
  )
  const logs = relative(process.cwd(), join(root, ".worker")) || "."
  return [
    `Worker env ${runtime.id} is ${runtime.status} (supervisor pid ${runtime.pid}).`,
    ...lines,
    ...idleLine(runtime),
    `Logs in ${logs}/<service>.log, state in ${logs}/runtime.json. Stop it with \`worker down\`.`,
  ].join("\n")
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n")
  } catch {
    return ""
  }
}

// Resolves once the supervisor `pid` reports a settled status or dies.
async function waitForSupervisor(root, pid, exited = () => !isAlive(pid)) {
  for (;;) {
    const runtime = readRuntime(root)
    const own = runtime?.pid === pid ? runtime : undefined
    if (own && SETTLED.includes(own.status)) return own
    if (exited()) {
      const last = readRuntime(root)
      return last?.pid === pid ? last : undefined
    }
    await sleep(200)
  }
}

function report(runtime, root) {
  if (runtime?.status === "running") {
    console.log(describe(runtime, root))
    return 0
  }
  console.error(
    `Worker env failed: ${runtime?.error ?? "the supervisor exited before reporting"}`,
  )
  const supervisorLog = tail(join(root, ".worker", "supervisor.log"))
  if (supervisorLog)
    console.error(`\n.worker/supervisor.log:\n${supervisorLog}`)
  return 1
}

async function existingEnv(root) {
  const pid = liveSupervisor(root)
  if (!pid) return undefined
  const runtime = await waitForSupervisor(root, pid)
  if (runtime?.status !== "running") {
    while (isAlive(pid)) await sleep(200)
    return undefined
  }
  return runtime
}

async function install(root, config, state) {
  const logFile = join(state, "install.log")
  closeSync(openSync(logFile, "w"))
  for (const [index, step] of config.install.entries()) {
    const resolved = resolveStep(root, step, { root })
    console.log(`Installing: ${[resolved.command, ...resolved.args].join(" ")}`)
    try {
      await runStep({ ...resolved, label: `install[${index}]`, logFile })
    } catch (error) {
      console.error(`${error.message}\n${tail(logFile)}`)
      return false
    }
  }
  return true
}

function startSupervisor(root, state) {
  const log = openSync(join(state, "supervisor.log"), "w")
  const child = spawn(process.execPath, [supervisorPath, root], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  child.unref()
  let exitCode
  child.once("exit", (code, signal) => (exitCode = code ?? signal))
  return { pid: child.pid, exitCode: () => exitCode }
}

export async function up() {
  const root = findRoot()
  const config = await loadConfig(root)
  const state = stateDir(root)

  await collectDeadEnvs(root, config)

  const running = await existingEnv(root)
  if (running) {
    console.log(`Already running.\n${describe(running, root)}`)
    return 0
  }

  if (!(await install(root, config, state))) return 1

  console.log(`Starting ${config.name} worker env`)
  const supervisor = startSupervisor(root, state)
  const runtime = await waitForSupervisor(
    root,
    supervisor.pid,
    () => supervisor.exitCode() !== undefined,
  )
  if (supervisor.exitCode() === LOCK_HELD_EXIT_CODE) {
    const other = await existingEnv(root)
    if (other) {
      console.log(`Already running.\n${describe(other, root)}`)
      return 0
    }
  }
  return report(runtime, root)
}

export async function down() {
  const root = findRoot()
  const pid = liveSupervisor(root)
  if (!pid) {
    console.log(`No worker env runs in ${root}`)
    return 0
  }
  const { id } = readRuntime(root) ?? {}
  process.kill(pid, "SIGTERM")
  const deadline = Date.now() + 30_000
  while (isAlive(pid) && Date.now() < deadline) await sleep(100)
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL")
    const runtime = readRuntime(root)
    await killGroups(
      Object.values(runtime?.services ?? {}).map((service) => service.pid),
    )
    console.error(
      `Supervisor ${pid} did not stop in time; killed it and its services`,
    )
  }
  console.log(`Worker env ${id} stopped`)
  return 0
}

export async function status(args) {
  const root = findRoot()
  const pid = liveSupervisor(root)
  const runtime = pid ? readRuntime(root) : undefined
  const env = runtime?.pid === pid ? runtime : undefined
  if (args.includes("--json")) {
    const record = env && { ...env, idleStopInMs: idleStopInMs(env) }
    console.log(JSON.stringify(record ?? { status: "absent", root }, null, 2))
  } else if (env) {
    console.log(describe(env, root))
  } else {
    console.log(`No worker env runs in ${root}`)
  }
  return env?.status === "running" ? 0 : 1
}
