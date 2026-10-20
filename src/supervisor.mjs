// Detached supervisor of one worker env, started by `worker up` with the checkout
// root as its only argument. Any service exit, failed startup or termination
// signal tears the whole env down and drops its resources; logs stay in .worker/.
// Each service port is a pass-through to the server's private port, and the env
// stops once no connection has been open on any of them for the idle timeout.
import { hostname } from "node:os"
import { join } from "node:path"
import { idleTimeoutMs, loadConfig, resolveStep } from "./config.mjs"
import {
  freePort,
  killGroups,
  runStep,
  spawnLogged,
  waitForHttp,
} from "./process.mjs"
import { passThrough } from "./passthrough.mjs"
import { provider } from "./resources.mjs"
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
const created = []
let runtime = {
  pid: process.pid,
  root,
  status: "starting",
  startedAt: new Date().toISOString(),
}
let cleanupPromise
const fronts = []
let connections = 0
let idleTimer

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
    clearTimeout(idleTimer)
    save({ status: "stopping" })
    await killGroups([...children].map((child) => child.pid))
    for (const { name, resource } of created.splice(0).reverse())
      await resource
        .drop(runtime.id)
        .catch((dropError) =>
          console.error(
            `Could not drop resource ${name}: ${dropError.message}`,
          ),
        )
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

// Only the moves between "some connection open" and "none open" matter: the
// idle countdown starts when the last connection closes.
function onConnections() {
  const open = fronts.reduce((total, front) => total + front.connections(), 0)
  const changed = !open !== !connections
  connections = open
  if (changed) armIdle()
}

function armIdle() {
  clearTimeout(idleTimer)
  if (cleanupPromise || runtime.status !== "running") return
  if (connections) {
    save({ idleSince: null })
    return
  }
  save({ idleSince: new Date().toISOString() })
  idleTimer = setTimeout(() => {
    console.log(`No connection for ${runtime.idleTimeoutMs} ms; stopping`)
    save({ stoppedBy: "idle" })
    void cleanup()
  }, runtime.idleTimeoutMs)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => void cleanup())

async function start() {
  save({})
  const config = await loadConfig(root)
  const id = newEnvId(config.name)
  save({ id, name: config.name, idleTimeoutMs: idleTimeoutMs(config) })

  const values = { id, name: config.name, root }
  const owner = { host: hostname(), pid: process.pid, root, groups: [] }
  const resources = Object.entries(config.resources).map(([name, options]) => ({
    name,
    resource: provider(options),
  }))
  for (const { name, resource } of resources)
    await resource.check(`resources.${name}`)
  const exposed = {}
  for (const { name, resource } of resources) {
    if (cleanupPromise) return
    created.push({ name, resource })
    await resource.create(id, owner)
    const resourceValues = resource.values(id)
    exposed[name] = { type: config.resources[name].type, ...resourceValues }
    for (const [key, value] of Object.entries(resourceValues))
      values[`${name}.${key}`] = value
  }
  save({ resources: exposed })

  const services = {}
  for (const [name, service] of Object.entries(config.services)) {
    const privatePort = await freePort()
    const front = await passThrough(privatePort, onConnections)
    fronts.push(front)
    const { port } = front
    const url = `http://127.0.0.1:${port}`
    const origin = service.browser
      ? `http://${id}.${config.name}.localhost:${port}`
      : url
    services[name] = {
      port,
      privatePort,
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
      port: String(services[name].privatePort),
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

  owner.groups = Object.values(services).map((service) => service.pid)
  for (const { resource } of created) await resource.recordOwner(id, owner)

  const running = () => !cleanupPromise
  const ready = await Promise.all(
    Object.entries(config.services).map(([name, service]) =>
      waitForHttp(
        `http://127.0.0.1:${services[name].privatePort}${service.health}`,
        {
          timeoutMs: config.startTimeoutMs,
          isAlive: running,
        },
      ),
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
  armIdle()
}

start().catch((error) => {
  if (!cleanupPromise) void cleanup(error.message)
})
