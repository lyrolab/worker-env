# @lyrolab/worker-env

Private, isolated dev environments for coding agents. One idempotent command starts every service of a checkout on its own ports and browser origin, under a detached supervisor; another stops it.

Node built-ins only, no runtime dependencies. Requires Node 22 or later on macOS or Linux.

## Commands

```sh
npm install --save-dev @lyrolab/worker-env
npx worker up       # install, start the env in the background, print its URLs
npx worker status   # print the env of this checkout (--json for the runtime record)
npx worker down     # stop the env and wait for teardown
```

The commands find `worker.config.mjs` in the current directory or its nearest parent; that directory is the checkout.

- `worker up` runs the `install` steps, starts a detached supervisor, waits until every service answers its health path, prints the URLs and exits 0. When the checkout already has a live env, it prints that env and exits 0 without installing. A failed install, setup step or service start exits 1 with the error and leaves nothing running.
- `worker up` first [collects](#idle-stop-and-collection) envs whose supervisor died.
- `worker status` exits 0 when the env runs, 1 otherwise. It shows the time left before the env stops for idleness; `--json` adds it as `idleStopInMs` (`null` while connections are open).
- `worker down` stops the env and exits 0, also when none runs.

Each checkout runs at most one env; separate checkouts (clones or worktrees) run side by side.

## How an env runs

- The env id is `<name>_worker_<12 hex>`, new on every start.
- The supervisor creates the configured [resources](#resources) on shared containers, then runs the `setup` steps, then starts the services. Teardown stops the services, then drops the resources.
- Every service gets an OS-assigned port on `127.0.0.1` and runs in a process group of its own. Any service exit, failed setup step, health timeout, `worker down` or [idle stop](#idle-stop-and-collection) stops every group.
- The service port the browser and agents use belongs to the supervisor, which relays every TCP connection, WebSockets included, to a private port the service listens on (`${port}`).
- A service with `browser: true` gets the origin `http://<id>.<name>.localhost:<port>`. Browsers resolve `*.localhost` to loopback and treat it as a secure context, so cookies and storage never mix with another env or the owner env. Other services' origin is their loopback URL.
- State lives in `.worker/` at the checkout root, which ignores itself in git:
  - `runtime.json`: id, supervisor pid, status (`starting`, `running`, `stopping`, `stopped`, `failed`), the error that stopped the env, `stoppedBy: "idle"` after an idle stop, the idle timeout and `idleSince` (when the last connection closed, `null` while one is open), and each service's port, private port, URL, origin, pid and log.
  - `<service>.log`, `install.log`, `setup.log`, `supervisor.log`.
  - `dev.lock`: held by the live supervisor.

## Configuration

`worker.config.mjs` default-exports an object:

```js
export default {
  name: "my-app",
  install: ["pnpm install --frozen-lockfile --prefer-offline"],
  resources: {
    db: {
      type: "postgres",
      container: "my-app-postgres",
      url: "postgres://postgres:postgres@localhost:5432",
    },
    cache: { type: "redis", container: "my-app-redis" },
  },
  setup: [
    {
      command: "node_modules/.bin/prisma",
      args: ["migrate", "deploy"],
      cwd: "packages/api",
      env: { DATABASE_URL: "${db.url}" },
    },
  ],
  services: {
    api: {
      cwd: "packages/api",
      command: "node_modules/.bin/tsx",
      args: ["watch", "src/main.ts"],
      env: {
        PORT: "${port}",
        FRONTEND_URL: "${web.origin}",
        DATABASE_URL: "${db.url}",
        REDIS_URL: "redis://localhost:6379",
        REDIS_PREFIX: "${cache.prefix}",
      },
      health: "/health",
    },
    web: {
      cwd: "packages/web",
      command: "node_modules/.bin/vite",
      args: ["--host", "127.0.0.1", "--port", "${port}", "--strictPort"],
      env: { VITE_API_URL: "${api.url}" },
      browser: true,
    },
  },
}
```

| Key              | Type             | Description                                                                                                                           |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string, required | Lowercase letters, digits and `-`, starting with a letter, at most 43 characters. Prefix of the env id and part of browser hostnames. |
| `install`        | step[]           | Run by `worker up` before starting, from the checkout root, logged to `.worker/install.log`. Skipped when the env already runs.       |
| `resources`      | object           | Resource name (lowercase letters, digits, `-`, distinct from service names) to [resource](#resources).                                |
| `setup`          | step[]           | Run by the supervisor in order once ports are assigned, before services start, logged to `.worker/setup.log`.                         |
| `services`       | object, required | Service name (lowercase letters, digits, `-`) to service. Services start together.                                                    |
| `startTimeoutMs` | integer          | Time every service has to answer its health path. Default `180000`.                                                                   |
| `idleTimeoutMs`  | integer          | Time without any open connection on the service ports after which the env stops. Default `1800000` (30 minutes).                      |

A step is either a string, run through `sh -c`, or an object:

| Key       | Type             | Description                                           |
| --------- | ---------------- | ----------------------------------------------------- |
| `command` | string, required | Executable, run without a shell.                      |
| `args`    | string[]         | Arguments.                                            |
| `cwd`     | string           | Directory relative to the checkout root. Default `.`. |
| `env`     | object           | Variables added to the inherited environment.         |

A service is a step object with two more keys:

| Key       | Type    | Description                                                         |
| --------- | ------- | ------------------------------------------------------------------- |
| `health`  | string  | Path that answers below 500 once the service is ready. Default `/`. |
| `browser` | boolean | Gives the service a `*.localhost` origin. Default `false`.          |

A service must listen on `127.0.0.1` at `${port}`, its private port; `${<service>.port}` is the supervisor's port in front of it. Start servers through their binary (`node_modules/.bin/vite`) rather than a package-manager script: pnpm runs scripts in a process group of its own, which teardown cannot reach.

### Interpolation

`command`, `args`, `cwd`, `env` values and `health` accept `${variable}`:

| Variable                | Value                                                  | Available in             |
| ----------------------- | ------------------------------------------------------ | ------------------------ |
| `${id}`                 | Env id                                                 | setup, services          |
| `${name}`               | Config `name`                                          | setup, services          |
| `${root}`               | Absolute checkout root                                 | install, setup, services |
| `${<resource>.<value>}` | A value of that [resource](#resources)                 | setup, services          |
| `${<service>.port}`     | That service's port, fronted by the supervisor         | setup, services          |
| `${<service>.url}`      | `http://127.0.0.1:<port>`                              | setup, services          |
| `${<service>.origin}`   | Browser origin when `browser: true`, its URL otherwise | setup, services          |
| `${port}`               | Private port the service itself listens on             | services                 |
| `${url}`, `${origin}`   | `${<service>.url}` and `.origin` of the service itself | services                 |

An unknown variable fails validation. Shell variables in string steps use the `$NAME` form.

### Resources

Each resource is a database or prefix of the env on a container shared with the checkout that owns it. The supervisor creates it before `setup` and drops it on teardown. worker-env never starts, stops or recreates containers: a container that is not running fails `worker up` with a message naming it. Creation and teardown refuse any name outside the env id pattern, so resources of the owner env stay untouched.

The owner of each resource is recorded as `{ host, pid, root, groups }`: host name, supervisor pid, checkout root and service process groups.

| `type`      | Keys                                                          | Created on the shared container                                                                             | Owner record                    | Values            |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------- |
| `postgres`  | `container` (required), `url` (required), `user` (`postgres`) | Database `<id>` through `docker exec <container> psql`; dropped `WITH (FORCE)`. Postgres 13 or later.       | Database comment                | `database`, `url` |
| `mongo`     | `container` (required), `url` (required)                      | Database `<id>` through `docker exec <container> mongosh`, which must connect without credentials.          | `_worker_owner` collection      | `database`, `url` |
| `redis`     | `container` (required)                                        | Key prefix `<id>`; teardown deletes every key matching `<id>*` through `docker exec <container> redis-cli`. | Key `<id>:_worker_owner`        | `prefix`          |
| `typesense` | `url` (required), `apiKey` (required)                         | Collection prefix `<id>_`; teardown deletes collections and aliases named `<id>_*` through the HTTP API.    | Collection `<id>__worker_owner` | `prefix`          |

- `container` is the name of the running Docker container.
- `url` of `postgres` and `mongo` is the server URL as services reach it; `${<resource>.url}` is that URL with the env's database as its path, keeping credentials and query.
- `url` of `typesense` is the API base URL, also used to check that Typesense answers before creating anything.
- `${<resource>.database}` is the env id; `${<resource>.prefix}` is `<id>` for Redis and `<id>_` for Typesense. Every key, queue and collection the app writes must start with its prefix, or it leaks across envs and survives teardown.

## Idle stop and collection

The supervisor counts the connections open on every service port. Once none has been open for `idleTimeoutMs`, it stops the env and drops its resources, as `worker down` does. An open browser tab keeps the env alive through its HMR WebSocket until the tab closes, and so does a service that keeps a connection open to another service's URL. `WORKER_ENV_IDLE_TIMEOUT_MS` overrides the timeout for the supervisor `worker up` starts.

Every `worker up` first collects envs whose supervisor died without tearing down (`kill -9`, reboot, deleted checkout), for the configured resources and the config `name`:

- An env id is collected when every owner recorded on its resources names this host and a supervisor that no longer runs. Envs of live supervisors and of other hosts stay, and so does a resource without a readable owner record, whose supervisor may still be starting.
- The recorded process groups are stopped first, each only while its leader still runs from inside the recorded checkout. Services of this checkout's last env are stopped the same way when its supervisor is gone.
- Its resources are then dropped from every configured resource, under the same id pattern check as teardown, so the owner env is never touched.

## Agent setup

```sh
npx worker init           # write .claude/rules/worker-env.md
npx worker init --check   # exit 1 when that file differs from the installed version
```

`worker init` writes the agent rules shipped with the installed version to `.claude/rules/worker-env.md` at the checkout root, replacing the whole file; running it again changes nothing. The rules tell agents to prove changes with tests and typecheck first, start an env only to see the UI, QA a flow end to end or reproduce runtime-only behavior, and never clean up. Commit the file and run `worker init --check` in CI so it follows package upgrades. Edits to the file fail the check; put project-specific rules elsewhere.

Claude Code loads `.claude/rules/` on its own. Add one line to the agent instructions every agent reads (`AGENTS.md`, or `CLAUDE.md` where no `AGENTS.md` exists):

```md
Before running the app, read and follow `.claude/rules/worker-env.md`.
```

Stop the env when a Claude Code session ends with a `SessionEnd` hook in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && pnpm worker down"
          }
        ]
      }
    ]
  }
}
```

## Development

```sh
npm test   # node --test, against the fixture app in fixture/
```

Resource integration tests run against throwaway containers named by environment variables and are skipped when they are unset:

```sh
docker run -d --name test-postgres -e POSTGRES_PASSWORD=postgres postgres:16
docker run -d --name test-mongo mongo:7
docker run -d --name test-redis redis:7
docker run -d --name test-typesense -p 8108:8108 -e TYPESENSE_API_KEY=test-key -e TYPESENSE_DATA_DIR=/tmp typesense/typesense:27.1

WORKER_ENV_TEST_POSTGRES=test-postgres WORKER_ENV_TEST_MONGO=test-mongo WORKER_ENV_TEST_REDIS=test-redis \
WORKER_ENV_TEST_TYPESENSE_URL=http://localhost:8108 WORKER_ENV_TEST_TYPESENSE_API_KEY=test-key npm test
```

Releases are published to npm by semantic-release from conventional commits on `main`.
