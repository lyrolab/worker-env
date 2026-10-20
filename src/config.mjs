import { existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { RESOURCE_TYPES } from "./resources.mjs"

export const CONFIG_FILE = "worker.config.mjs"

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
// The env id `<name>_worker_<12 hex>` is a hostname label and a database name,
// both capped at 63 characters.
const NAME_MAX_LENGTH = 43
const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/
const VARIABLE_PATTERN = /\$\{([^}]*)\}/g
const GLOBAL_VARIABLES = ["id", "name", "root"]
const SERVICE_VARIABLES = ["port", "url", "origin"]
const TOP_LEVEL_KEYS = [
  "name",
  "install",
  "setup",
  "resources",
  "services",
  "startTimeoutMs",
  "idleTimeoutMs",
]
export const IDLE_TIMEOUT_VARIABLE = "WORKER_ENV_IDLE_TIMEOUT_MS"
const STEP_KEYS = ["command", "args", "cwd", "env"]
const SERVICE_KEYS = [...STEP_KEYS, "health", "browser"]

export class ConfigError extends Error {}

export function findRoot(from = process.cwd()) {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return realpathSync(dir)
    const parent = dirname(dir)
    if (parent === dir)
      throw new ConfigError(`No ${CONFIG_FILE} found in ${from} or its parents`)
    dir = parent
  }
}

export async function loadConfig(root) {
  const module = await import(pathToFileURL(join(root, CONFIG_FILE)).href)
  return validateConfig(module.default)
}

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function fail(path, message) {
  throw new ConfigError(`${CONFIG_FILE}: ${path} ${message}`)
}

function checkKeys(value, allowed, path) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail(
        `${path}.${key}`,
        `is not a known key (expected one of ${allowed.join(", ")})`,
      )
}

function checkString(value, path) {
  if (typeof value !== "string" || value === "")
    fail(path, "must be a non-empty string")
}

function checkStep(step, path) {
  if (typeof step === "string") {
    checkString(step, path)
    return { command: step, args: [], cwd: ".", env: {}, shell: true }
  }
  if (!isObject(step)) fail(path, "must be a string or an object")
  checkKeys(step, STEP_KEYS, path)
  checkString(step.command, `${path}.command`)
  const args = step.args ?? []
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    fail(`${path}.args`, "must be an array of strings")
  const cwd = step.cwd ?? "."
  checkString(cwd, `${path}.cwd`)
  const env = step.env ?? {}
  if (!isObject(env) || !Object.values(env).every((v) => typeof v === "string"))
    fail(`${path}.env`, "must map names to strings")
  return { command: step.command, args, cwd, env, shell: false }
}

function checkSteps(steps, path) {
  if (steps === undefined) return []
  if (!Array.isArray(steps)) fail(path, "must be an array")
  return steps.map((step, index) => checkStep(step, `${path}[${index}]`))
}

function stepStrings(step) {
  return [step.command, ...step.args, step.cwd, ...Object.values(step.env)]
}

function checkVariables(strings, allowed, path) {
  for (const text of strings)
    for (const [, name] of text.matchAll(VARIABLE_PATTERN))
      if (!allowed.has(name))
        fail(
          path,
          `uses unknown variable \${${name}} (known: ${[...allowed].join(", ")})`,
        )
}

function checkResources(resources, services) {
  if (resources === undefined) return {}
  if (!isObject(resources)) fail("resources", "must be an object")
  const types = Object.keys(RESOURCE_TYPES)
  return Object.fromEntries(
    Object.entries(resources).map(([name, resource]) => {
      const path = `resources.${name}`
      if (!SERVICE_PATTERN.test(name))
        fail(path, `name must match ${SERVICE_PATTERN}`)
      if (name in services) fail(path, "has the name of a service")
      if (!isObject(resource)) fail(path, "must be an object")
      if (!types.includes(resource.type))
        fail(`${path}.type`, `must be one of ${types.join(", ")}`)
      const { keys } = RESOURCE_TYPES[resource.type]
      checkKeys(resource, ["type", ...Object.keys(keys)], path)
      const checked = { type: resource.type }
      for (const [key, fallback] of Object.entries(keys)) {
        const value = resource[key] ?? fallback
        if (value === undefined) fail(`${path}.${key}`, "is required")
        checkString(value, `${path}.${key}`)
        if (key === "url" && !URL.canParse(value))
          fail(`${path}.url`, "must be a URL")
        checked[key] = value
      }
      return [name, checked]
    }),
  )
}

export function validateConfig(config) {
  if (!isObject(config)) fail("default export", "must be an object")
  checkKeys(config, TOP_LEVEL_KEYS, "config")
  checkString(config.name, "name")
  if (!NAME_PATTERN.test(config.name))
    fail("name", `must match ${NAME_PATTERN} (it becomes part of hostnames)`)
  if (config.name.length > NAME_MAX_LENGTH)
    fail("name", `must be at most ${NAME_MAX_LENGTH} characters`)

  const startTimeoutMs = config.startTimeoutMs ?? 180_000
  if (!Number.isInteger(startTimeoutMs) || startTimeoutMs <= 0)
    fail("startTimeoutMs", "must be a positive integer")

  const idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60_000
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0)
    fail("idleTimeoutMs", "must be a positive integer")

  if (!isObject(config.services) || Object.keys(config.services).length === 0)
    fail("services", "must declare at least one service")
  const services = {}
  for (const [name, service] of Object.entries(config.services)) {
    const path = `services.${name}`
    if (!SERVICE_PATTERN.test(name))
      fail(path, `name must match ${SERVICE_PATTERN}`)
    if (!isObject(service)) fail(path, "must be an object")
    checkKeys(service, SERVICE_KEYS, path)
    const health = service.health ?? "/"
    if (typeof health !== "string" || !health.startsWith("/"))
      fail(`${path}.health`, "must be a path starting with /")
    if (service.browser !== undefined && typeof service.browser !== "boolean")
      fail(`${path}.browser`, "must be a boolean")
    const { browser, health: _, ...step } = service
    services[name] = {
      ...checkStep(step, path),
      health,
      browser: browser ?? false,
    }
  }

  const resources = checkResources(config.resources, services)

  const shared = new Set([
    ...GLOBAL_VARIABLES,
    ...Object.keys(services).flatMap((name) =>
      SERVICE_VARIABLES.map((variable) => `${name}.${variable}`),
    ),
    ...Object.entries(resources).flatMap(([name, { type }]) =>
      RESOURCE_TYPES[type].values.map((value) => `${name}.${value}`),
    ),
  ])
  const own = new Set([...shared, ...SERVICE_VARIABLES])
  for (const [name, service] of Object.entries(services))
    checkVariables(
      [...stepStrings(service), service.health],
      own,
      `services.${name}`,
    )

  const install = checkSteps(config.install, "install")
  checkVariables(install.flatMap(stepStrings), new Set(["root"]), "install")
  const setup = checkSteps(config.setup, "setup")
  checkVariables(setup.flatMap(stepStrings), shared, "setup")

  return {
    name: config.name,
    install,
    setup,
    resources,
    services,
    startTimeoutMs,
    idleTimeoutMs,
  }
}

export function idleTimeoutMs(config, env = process.env) {
  const override = env[IDLE_TIMEOUT_VARIABLE]
  if (override === undefined || override === "") return config.idleTimeoutMs
  const value = Number(override)
  if (!Number.isInteger(value) || value <= 0)
    throw new ConfigError(
      `${IDLE_TIMEOUT_VARIABLE} must be a positive integer, got ${JSON.stringify(override)}`,
    )
  return value
}

export function interpolate(text, values) {
  return text.replace(VARIABLE_PATTERN, (_, name) => values[name])
}

export function resolveStep(root, step, values) {
  const apply = (text) => interpolate(text, values)
  return {
    command: apply(step.command),
    shell: step.shell,
    args: step.args.map(apply),
    cwd: resolve(root, apply(step.cwd)),
    env: Object.fromEntries(
      Object.entries(step.env).map(([key, value]) => [key, apply(value)]),
    ),
  }
}
