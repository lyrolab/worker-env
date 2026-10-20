// Per-env resources on shared containers the package never starts. Every
// create, record and drop refuses names outside the env id pattern, so the owner
// env's resources stay out of reach.
import { capture } from "./process.mjs"

const ENV_ID_PATTERN = /^[a-z][a-z0-9-]*_worker_[0-9a-f]{12}$/
const OWNER = "_worker_owner"

export class ResourceError extends Error {}

export function assertEnvId(id) {
  if (typeof id !== "string" || !ENV_ID_PATTERN.test(id))
    throw new ResourceError(`Refusing non-worker name ${JSON.stringify(id)}`)
}

// `name` is a validated config name: lowercase letters, digits and `-` only.
const idsOf = (name) => new RegExp(`^${name}_worker_[0-9a-f]{12}`)

function parseOwner(text) {
  try {
    return JSON.parse(text) ?? undefined
  } catch {
    return undefined
  }
}

function assertContainer(container, label) {
  const running = capture("docker", [
    "inspect",
    "-f",
    "{{.State.Running}}",
    container,
  ])
  if (running.stdout !== "true")
    throw new ResourceError(
      `${label}: container ${container} is not running. worker-env never starts shared containers; start it from the checkout that owns it.`,
    )
}

function dockerExec(container, args) {
  const result = capture("docker", ["exec", container, ...args])
  if (!result.ok)
    throw new ResourceError(
      `${args[0]} in ${container} failed: ${result.stderr || result.stdout}`,
    )
  return result.stdout
}

function databaseUrl(base, database) {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.href
}

const quoteLiteral = (text) => `'${text.replaceAll("'", "''")}'`

function postgres({ container, user, url }) {
  const psql = (sql, database = "postgres") =>
    dockerExec(container, [
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ])
  const provider = {
    check: (label) => assertContainer(container, label),
    values: (id) => ({ database: id, url: databaseUrl(url, id) }),
    async create(id, owner) {
      assertEnvId(id)
      psql(`CREATE DATABASE "${id}"`)
      await provider.recordOwner(id, owner)
    },
    async recordOwner(id, owner) {
      assertEnvId(id)
      psql(
        `COMMENT ON DATABASE "${id}" IS ${quoteLiteral(JSON.stringify(owner))}`,
      )
    },
    async drop(id) {
      assertEnvId(id)
      psql(`DROP DATABASE IF EXISTS "${id}" WITH (FORCE)`)
    },
    async list(name) {
      const rows = psql(
        `SELECT datname || chr(9) || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname LIKE '${name}\\_worker\\_%'`,
      )
      return rows
        .split("\n")
        .map((row) => row.split("\t"))
        .filter(([id]) => ENV_ID_PATTERN.test(id) && idsOf(name).test(id))
        .map(([id, comment]) => ({ id, owner: parseOwner(comment) }))
    },
  }
  return provider
}

function mongo({ container, url }) {
  const mongosh = (database, script) =>
    dockerExec(container, ["mongosh", "--quiet", database, "--eval", script])
  const provider = {
    check: (label) => assertContainer(container, label),
    values: (id) => ({ database: id, url: databaseUrl(url, id) }),
    // Mongo creates a database on its first write, the owner record.
    create: (id, owner) => provider.recordOwner(id, owner),
    async recordOwner(id, owner) {
      assertEnvId(id)
      mongosh(
        id,
        `db.getCollection("${OWNER}").replaceOne({ _id: "owner" }, ${JSON.stringify(owner)}, { upsert: true })`,
      )
    },
    async drop(id) {
      assertEnvId(id)
      mongosh(id, "db.dropDatabase()")
    },
    async list(name) {
      const databases = JSON.parse(
        mongosh(
          "admin",
          `JSON.stringify(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name).filter((n) => n.startsWith("${name}_worker_")).map((n) => [n, db.getSiblingDB(n).getCollection("${OWNER}").findOne({ _id: "owner" }, { _id: 0 })]))`,
        ),
      )
      return databases
        .filter(([id]) => ENV_ID_PATTERN.test(id) && idsOf(name).test(id))
        .map(([id, owner]) => ({ id, owner: owner ?? undefined }))
    },
  }
  return provider
}

function redis({ container }) {
  const cli = (args) => dockerExec(container, ["redis-cli", ...args])
  const ownerKey = (id) => `${id}:${OWNER}`
  const provider = {
    check: (label) => assertContainer(container, label),
    values: (id) => ({ prefix: id }),
    create: (id, owner) => provider.recordOwner(id, owner),
    async recordOwner(id, owner) {
      assertEnvId(id)
      cli(["SET", ownerKey(id), JSON.stringify(owner)])
    },
    // Ids are unique and every key of the env starts with its id, so the id
    // alone is a safe pattern.
    async drop(id) {
      assertEnvId(id)
      cli([
        "EVAL",
        "local n = 0 for _, k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) n = n + 1 end return n",
        "0",
        `${id}*`,
      ])
    },
    async list(name) {
      const keys = cli(["--scan", "--pattern", `${name}_worker_*`])
      const ids = [
        ...new Set(
          keys
            .split("\n")
            .map((key) => idsOf(name).exec(key)?.[0])
            .filter(Boolean),
        ),
      ]
      return ids.map((id) => ({
        id,
        owner: parseOwner(cli(["GET", ownerKey(id)])),
      }))
    },
  }
  return provider
}

function typesense({ url, apiKey }) {
  const base = url.replace(/\/+$/, "")
  async function api(method, path, body) {
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-typesense-api-key": apiKey,
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new ResourceError(
        `Typesense at ${base} is unreachable: ${error.cause?.code ?? error.message}`,
      )
    }
    const text = await response.text()
    if (!response.ok)
      throw new ResourceError(
        `Typesense ${method} ${path} failed (${response.status}): ${text}`,
      )
    return JSON.parse(text)
  }
  const ownerCollection = (id) => `${id}_${OWNER}`
  const names = async () => ({
    collections: (await api("GET", "/collections")).map(({ name }) => name),
    aliases: (await api("GET", "/aliases")).aliases.map(({ name }) => name),
  })
  const provider = {
    async check(label) {
      try {
        await api("GET", "/health")
      } catch (error) {
        throw new ResourceError(`${label}: ${error.message}`)
      }
    },
    values: (id) => ({ prefix: `${id}_` }),
    async create(id, owner) {
      assertEnvId(id)
      await api("POST", "/collections", {
        name: ownerCollection(id),
        fields: [{ name: "owner", type: "string", index: false }],
      })
      await provider.recordOwner(id, owner)
    },
    async recordOwner(id, owner) {
      assertEnvId(id)
      await api(
        "POST",
        `/collections/${ownerCollection(id)}/documents?action=upsert`,
        { id: "owner", owner: JSON.stringify(owner) },
      )
    },
    async drop(id) {
      assertEnvId(id)
      const prefix = `${id}_`
      const { collections, aliases } = await names()
      for (const alias of aliases.filter((n) => n.startsWith(prefix)))
        await api("DELETE", `/aliases/${encodeURIComponent(alias)}`)
      for (const collection of collections.filter((n) => n.startsWith(prefix)))
        await api("DELETE", `/collections/${encodeURIComponent(collection)}`)
    },
    async list(name) {
      const { collections, aliases } = await names()
      const ids = [
        ...new Set(
          [...collections, ...aliases]
            .map((n) => idsOf(name).exec(n)?.[0])
            .filter((id) => id && ENV_ID_PATTERN.test(id)),
        ),
      ]
      return Promise.all(
        ids.map(async (id) => {
          const document = await api(
            "GET",
            `/collections/${ownerCollection(id)}/documents/owner`,
          ).catch(() => undefined)
          return { id, owner: parseOwner(document?.owner) }
        }),
      )
    },
  }
  return provider
}

// `keys` maps each option to its default; `undefined` marks it required.
// `values` are the names a resource exposes as `${<resource>.<value>}`.
export const RESOURCE_TYPES = {
  postgres: {
    keys: { container: undefined, url: undefined, user: "postgres" },
    values: ["database", "url"],
    create: postgres,
  },
  mongo: {
    keys: { container: undefined, url: undefined },
    values: ["database", "url"],
    create: mongo,
  },
  redis: {
    keys: { container: undefined },
    values: ["prefix"],
    create: redis,
  },
  typesense: {
    keys: { url: undefined, apiKey: undefined },
    values: ["prefix"],
    create: typesense,
  },
}

export const provider = (resource) =>
  RESOURCE_TYPES[resource.type].create(resource)
