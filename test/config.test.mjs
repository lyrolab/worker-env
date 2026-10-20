import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ConfigError,
  idleTimeoutMs,
  interpolate,
  validateConfig,
} from "../src/config.mjs"

const valid = () => ({
  name: "my-app",
  services: {
    api: { command: "node", args: ["api.mjs"], env: { PORT: "${port}" } },
    web: {
      command: "vite",
      env: { API: "${api.url}", ORIGIN: "${origin}" },
      browser: true,
    },
  },
})

test("fills defaults", () => {
  const config = validateConfig(valid())
  assert.deepEqual(config.install, [])
  assert.equal(config.services.api.health, "/")
  assert.equal(config.services.web.browser, true)
  assert.equal(config.startTimeoutMs, 180_000)
  assert.equal(config.idleTimeoutMs, 1_800_000)
})

test("the idle timeout comes from the config unless the environment overrides it", () => {
  const config = validateConfig({ ...valid(), idleTimeoutMs: 60_000 })
  assert.equal(idleTimeoutMs(config, {}), 60_000)
  assert.equal(
    idleTimeoutMs(config, { WORKER_ENV_IDLE_TIMEOUT_MS: "1500" }),
    1500,
  )
  assert.throws(
    () => idleTimeoutMs(config, { WORKER_ENV_IDLE_TIMEOUT_MS: "soon" }),
    /WORKER_ENV_IDLE_TIMEOUT_MS must be a positive integer/,
  )
  assert.throws(
    () => validateConfig({ ...valid(), idleTimeoutMs: 0 }),
    /idleTimeoutMs must be a positive integer/,
  )
})

test("string steps run through the shell", () => {
  const config = validateConfig({
    ...valid(),
    install: ["pnpm install --frozen-lockfile"],
  })
  assert.equal(config.install[0].shell, true)
  assert.equal(config.services.api.shell, false)
})

for (const [label, change, message] of [
  ["a missing name", (c) => delete c.name, /name must be a non-empty string/],
  ["a name unfit for hostnames", (c) => (c.name = "My_App"), /name must match/],
  ["no services", (c) => (c.services = {}), /at least one service/],
  [
    "a name too long for an env id",
    (c) => (c.name = "a".repeat(44)),
    /name must be at most 43 characters/,
  ],
  [
    "an unknown key",
    (c) => (c.volumes = {}),
    /config\.volumes is not a known key/,
  ],
  [
    "an unknown resource type",
    (c) => (c.resources = { db: { type: "mysql" } }),
    /resources\.db\.type must be one of postgres, mongo, redis, typesense/,
  ],
  [
    "a resource without its container",
    (c) => (c.resources = { db: { type: "postgres", url: "postgres://x" } }),
    /resources\.db\.container is required/,
  ],
  [
    "a resource with an invalid URL",
    (c) =>
      (c.resources = { db: { type: "mongo", container: "m", url: "nope" } }),
    /resources\.db\.url must be a URL/,
  ],
  [
    "an unknown resource key",
    (c) => (c.resources = { cache: { type: "redis", container: "r", db: 1 } }),
    /resources\.cache\.db is not a known key/,
  ],
  [
    "a resource named like a service",
    (c) => (c.resources = { api: { type: "redis", container: "r" } }),
    /resources\.api has the name of a service/,
  ],
  [
    "a variable of another resource type",
    (c) => {
      c.resources = { cache: { type: "redis", container: "r" } }
      c.services.api.env.X = "${cache.url}"
    },
    /unknown variable \$\{cache\.url\}/,
  ],
  [
    "an unknown service key",
    (c) => (c.services.api.port = 1),
    /services\.api\.port is not a known key/,
  ],
  [
    "an unknown variable",
    (c) => (c.services.api.env.X = "${nope}"),
    /unknown variable \$\{nope\}/,
  ],
  [
    "an unknown service variable",
    (c) => (c.services.api.env.X = "${db.url}"),
    /\$\{db\.url\}/,
  ],
  [
    "own values in setup",
    (c) => (c.setup = [{ command: "x", args: ["${port}"] }]),
    /setup uses unknown variable/,
  ],
  [
    "a relative health path",
    (c) => (c.services.api.health = "health"),
    /health must be a path/,
  ],
]) {
  test(`rejects ${label}`, () => {
    const config = valid()
    change(config)
    assert.throws(
      () => validateConfig(config),
      (error) => error instanceof ConfigError && message.test(error.message),
    )
  })
}

test("resources fill defaults and expose their values", () => {
  const config = valid()
  config.resources = {
    db: { type: "postgres", container: "pg", url: "postgres://localhost" },
    search: { type: "typesense", url: "http://localhost:8108", apiKey: "k" },
  }
  config.setup = [{ command: "migrate", env: { DATABASE_URL: "${db.url}" } }]
  config.services.api.env.DB = "${db.database}"
  config.services.api.env.PREFIX = "${search.prefix}"
  assert.deepEqual(validateConfig(config).resources.db, {
    type: "postgres",
    container: "pg",
    url: "postgres://localhost",
    user: "postgres",
  })
})

test("interpolates values", () => {
  assert.equal(interpolate("${a}-${b.c}", { a: "1", "b.c": "2" }), "1-2")
})
