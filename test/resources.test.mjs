import assert from "node:assert/strict"
import { hostname } from "node:os"
import { describe, test } from "node:test"
import { capture } from "../src/process.mjs"
import { ResourceError, provider } from "../src/resources.mjs"
import { newEnvId } from "../src/state.mjs"

// Integration tests run against throwaway containers named by these variables
// and are skipped when they are unset; see the README.
const {
  WORKER_ENV_TEST_POSTGRES: POSTGRES,
  WORKER_ENV_TEST_MONGO: MONGO,
  WORKER_ENV_TEST_REDIS: REDIS,
  WORKER_ENV_TEST_TYPESENSE_URL: TYPESENSE_URL,
  WORKER_ENV_TEST_TYPESENSE_API_KEY: TYPESENSE_API_KEY,
} = process.env

const NAME = "worker-env-test"
const owner = {
  host: hostname(),
  pid: process.pid,
  root: "/checkout",
  groups: [],
}

function exec(container, args) {
  const result = capture("docker", ["exec", container, ...args])
  assert.ok(result.ok, result.stderr)
  return result.stdout
}

const psql = (sql, database = "postgres") =>
  exec(POSTGRES, ["psql", "-U", "postgres", "-d", database, "-tAc", sql])
const mongosh = (database, script) =>
  exec(MONGO, ["mongosh", "--quiet", database, "--eval", script])
const redisCli = (...args) => exec(REDIS, ["redis-cli", ...args])

async function typesenseApi(method, path, body) {
  const response = await fetch(`${TYPESENSE_URL}${path}`, {
    method,
    headers: { "x-typesense-api-key": TYPESENSE_API_KEY },
    body: body && JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const cases = {
  postgres: {
    skip: !POSTGRES && "set WORKER_ENV_TEST_POSTGRES to a Postgres container",
    options: () => ({
      container: POSTGRES,
      user: "postgres",
      url: "postgres://postgres:postgres@localhost:5432/?sslmode=disable",
    }),
    values: (id) => ({
      database: id,
      url: `postgres://postgres:postgres@localhost:5432/${id}?sslmode=disable`,
    }),
    write: async (id) => psql("CREATE TABLE items (id int)", id),
    has: async (id) =>
      psql(`SELECT count(*) FROM pg_database WHERE datname = '${id}'`) === "1",
    outsider: {
      create: async () => psql(`CREATE DATABASE "${NAME}"`),
      exists: async () =>
        psql(`SELECT count(*) FROM pg_database WHERE datname = '${NAME}'`) ===
        "1",
      remove: async () => psql(`DROP DATABASE "${NAME}"`),
    },
  },
  mongo: {
    skip: !MONGO && "set WORKER_ENV_TEST_MONGO to a Mongo container",
    options: () => ({ container: MONGO, url: "mongodb://localhost:27017" }),
    values: (id) => ({ database: id, url: `mongodb://localhost:27017/${id}` }),
    write: async (id) => mongosh(id, "db.items.insertOne({ n: 1 })"),
    has: async (id) =>
      mongosh(id, "db.getCollectionNames().includes('items')") === "true",
    outsider: {
      create: async () => mongosh(NAME, "db.items.insertOne({ n: 1 })"),
      exists: async () =>
        mongosh(NAME, "db.getCollectionNames().includes('items')") === "true",
      remove: async () => mongosh(NAME, "db.dropDatabase()"),
    },
  },
  redis: {
    skip: !REDIS && "set WORKER_ENV_TEST_REDIS to a Redis container",
    options: () => ({ container: REDIS }),
    values: (id) => ({ prefix: id }),
    write: async (id) => {
      redisCli("SET", `${id}:cache:a`, "1")
      redisCli("SET", `${id}bull:queue`, "1")
    },
    has: async (id) => redisCli("EXISTS", `${id}:cache:a`) === "1",
    outsider: {
      create: async () => redisCli("SET", `${NAME}:cache:a`, "1"),
      exists: async () => redisCli("EXISTS", `${NAME}:cache:a`) === "1",
      remove: async () => redisCli("DEL", `${NAME}:cache:a`),
    },
  },
  typesense: {
    skip:
      !(TYPESENSE_URL && TYPESENSE_API_KEY) &&
      "set WORKER_ENV_TEST_TYPESENSE_URL and WORKER_ENV_TEST_TYPESENSE_API_KEY",
    options: () => ({ url: TYPESENSE_URL, apiKey: TYPESENSE_API_KEY }),
    values: (id) => ({ prefix: `${id}_` }),
    write: async (id) => {
      await typesenseApi("POST", "/collections", {
        name: `${id}_items`,
        fields: [{ name: "title", type: "string" }],
      })
      await typesenseApi("PUT", `/aliases/${id}_current`, {
        collection_name: `${id}_items`,
      })
    },
    has: async (id) =>
      (await typesenseApi("GET", `/collections/${id}_items`)).status === 200 &&
      (await typesenseApi("GET", `/aliases/${id}_current`)).status === 200,
    outsider: {
      create: async () =>
        typesenseApi("POST", "/collections", {
          name: `${NAME}_items`,
          fields: [{ name: "title", type: "string" }],
        }),
      exists: async () =>
        (await typesenseApi("GET", `/collections/${NAME}_items`)).status ===
        200,
      remove: async () => typesenseApi("DELETE", `/collections/${NAME}_items`),
    },
  },
}

for (const [type, spec] of Object.entries(cases)) {
  describe(type, () => {
    test("refuses names outside the env id pattern", async () => {
      const resource = provider({
        type,
        container: "unused",
        user: "postgres",
        url: "http://127.0.0.1:9",
        apiKey: "key",
      })
      for (const name of [NAME, `${NAME}_worker_`, "postgres", "*"])
        for (const operation of ["create", "recordOwner", "drop"])
          await assert.rejects(
            resource[operation](name, owner),
            (error) =>
              error instanceof ResourceError &&
              error.message.startsWith("Refusing non-worker name"),
            `${operation}(${name})`,
          )
    })

    test(
      "creates, exposes, records and drops one env's resource",
      { skip: spec.skip },
      async () => {
        const resource = provider({ type, ...spec.options() })
        await resource.check(`resources.${type}`)
        const [a, b] = [newEnvId(NAME), newEnvId(NAME)]
        await spec.outsider.create()
        try {
          for (const id of [a, b]) {
            await resource.create(id, owner)
            await spec.write(id)
          }
          assert.deepEqual(resource.values(a), spec.values(a))

          const later = { ...owner, groups: [123, 456] }
          await resource.recordOwner(a, later)
          const listed = await resource.list(NAME)
          assert.deepEqual(
            listed
              .filter(({ id }) => id === a || id === b)
              .sort((x, y) => x.id.localeCompare(y.id)),
            [
              { id: a, owner: later },
              { id: b, owner },
            ].sort((x, y) => x.id.localeCompare(y.id)),
          )

          await resource.drop(a)
          assert.equal(await spec.has(a), false, "dropped")
          assert.ok(
            !(await resource.list(NAME)).some(({ id }) => id === a),
            "no longer listed",
          )
          assert.equal(await spec.has(b), true, "another env is untouched")
          assert.equal(
            await spec.outsider.exists(),
            true,
            "a non-worker resource is untouched",
          )
        } finally {
          await resource.drop(a)
          await resource.drop(b)
          await spec.outsider.remove()
        }
      },
    )
  })
}

test("a missing container is named", () => {
  assert.throws(
    () =>
      provider({
        type: "postgres",
        container: "worker-env-test-missing",
        url: "postgres://localhost:5432",
        user: "postgres",
      }).check("resources.db"),
    /resources\.db: container worker-env-test-missing is not running/,
  )
})

test("an unreachable Typesense is named", async () => {
  await assert.rejects(
    provider({
      type: "typesense",
      url: "http://127.0.0.1:9",
      apiKey: "key",
    }).check("resources.search"),
    /resources\.search: Typesense at http:\/\/127\.0\.0\.1:9 is unreachable/,
  )
})
