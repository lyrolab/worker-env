// Detached supervisor of one worker env, started by `worker up` with the checkout
// root as its only argument. Any service exit, failed startup or termination
// signal tears the whole env down; logs stay in .worker/.
import { join } from "node:path"
import { loadConfig, resolveStep } from "./config.mjs"
import {
  freePort,
  killGroups,
  runStep,
  spawnLogged,
  waitForHttp,
} from "./process.mjs"
import {
  LOCK_HELD_EXIT_CODE,
  LockHeldError,
  acquireLock,
  newEnvId,
  releaseLock,
  stateDir,
  writeRuntime,
} from "./state.mjs"

const root = process.argv[2]
const state = stateDir(root)

try {
  acquireLock(root)
} catch (error) {
  console.error(error.message)
  process.exit(error instanceof LockHeldError ? LOCK_HELD_EXIT_CODE : 1)
}

const children = new Set()
let runtime = {
  pid: process.pid,
  root,
  status: "starting",
  startedAt: new Date().toISOString(),
}
let cleanupPromise

const save = (patch) => {
  runtime = { ...runtime, ...patch }
  writeRuntime(root, runtime)
}

const track = (child) => {
  children.add(child)
  child.once("exit", () => children.delete(child))
  return child
}

function cleanup(error) {
  cleanupPromise ??= (async () => {
    if (error) console.error(error)
    save({ status: "stopping" })
    await killGroups([...children].map((child) => child.pid))
    save({
      status: error ? "failed" : "stopped",
      ...(error && { error }),
      stoppedAt: new Date().toISOString(),
    })
    releaseLock(root)
    console.log(`Worker env ${runtime.id} stopped`)
    process.exit(error ? 1 : 0)
  })()
  return cleanupPromise
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => void cleanup())

async function start() {
  save({})
  const config = await loadConfig(root)
  const id = newEnvId(config.name)
  save({ id, name: config.name })

  const values = { id, name: config.name, root }
  const services = {}
  for (const [name, service] of Object.entries(config.services)) {
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const origin = service.browser
      ? `http://${id}.${config.name}.localhost:${port}`
      : url
    services[name] = {
      port,
      url,
      origin,
      browser: service.browser,
      log: join(state, `${name}.log`),
    }
    Object.assign(values, {
      [`${name}.port`]: String(port),
      [`${name}.url`]: url,
      [`${name}.origin`]: origin,
    })
  }
  save({ services })

  const setupLog = join(state, "setup.log")
  for (const [index, step] of config.setup.entries())
    await runStep({
      ...resolveStep(root, step, values),
      label: `setup[${index}]`,
      logFile: setupLog,
      onSpawn: track,
    })

  for (const [name, service] of Object.entries(config.services)) {
    const own = {
      ...values,
      port: values[`${name}.port`],
      url: services[name].url,
      origin: services[name].origin,
    }
    const child = track(
      spawnLogged({
        ...resolveStep(root, service, own),
        logFile: services[name].log,
      }),
    )
    services[name].pid = child.pid
    child.once(
      "error",
      (error) => void cleanup(`${name} failed to start: ${error.message}`),
    )
    child.once("exit", (code, signal) => {
      if (!cleanupPromise)
        void cleanup(
          `${name} exited (${signal ?? code}); see .worker/${name}.log`,
        )
    })
  }
  save({ services })

  const running = () => !cleanupPromise
  const ready = await Promise.all(
    Object.entries(config.services).map(([name, service]) =>
      waitForHttp(`${services[name].url}${service.health}`, {
        timeoutMs: config.startTimeoutMs,
        isAlive: running,
      }),
    ),
  )
  if (!running()) return
  const late = Object.keys(config.services).filter((_, index) => !ready[index])
  if (late.length)
    throw new Error(
      `${late.join(", ")} did not answer health within ${config.startTimeoutMs} ms`,
    )

  save({ status: "running", readyAt: new Date().toISOString() })
  console.log(`Worker env ${id} is running`)
}

start().catch((error) => {
  if (!cleanupPromise) void cleanup(error.message)
})
