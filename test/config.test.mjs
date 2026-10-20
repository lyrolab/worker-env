import assert from "node:assert/strict"
import { test } from "node:test"
import { ConfigError, interpolate, validateConfig } from "../src/config.mjs"

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
    "an unknown key",
    (c) => (c.resources = {}),
    /config\.resources is not a known key/,
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

test("interpolates values", () => {
  assert.equal(interpolate("${a}-${b.c}", { a: "1", "b.c": "2" }), "1-2")
})
