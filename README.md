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
- `worker status` exits 0 when the env runs, 1 otherwise.
- `worker down` stops the env and exits 0, also when none runs.

Each checkout runs at most one env; separate checkouts (clones or worktrees) run side by side.

## How an env runs

- The env id is `<name>_worker_<12 hex>`, new on every start.
- Every service gets an OS-assigned port on `127.0.0.1` and runs in a process group of its own. Any service exit, failed setup step, health timeout or `worker down` stops every group.
- A service with `browser: true` gets the origin `http://<id>.<name>.localhost:<port>`. Browsers resolve `*.localhost` to loopback and treat it as a secure context, so cookies and storage never mix with another env or the owner env. Other services' origin is their loopback URL.
- State lives in `.worker/` at the checkout root, which ignores itself in git:
  - `runtime.json`: id, supervisor pid, status (`starting`, `running`, `stopping`, `stopped`, `failed`), the error that stopped the env, and each service's port, URL, origin, pid and log.
  - `<service>.log`, `install.log`, `setup.log`, `supervisor.log`.
  - `dev.lock`: held by the live supervisor.

## Configuration

`worker.config.mjs` default-exports an object:

```js
export default {
  name: "my-app",
  install: ["pnpm install --frozen-lockfile --prefer-offline"],
  setup: [
    {
      command: "node_modules/.bin/prisma",
      args: ["migrate", "deploy"],
      cwd: "packages/api",
      env: { DATABASE_URL: "postgres://localhost:5432/${id}" },
    },
  ],
  services: {
    api: {
      cwd: "packages/api",
      command: "node_modules/.bin/tsx",
      args: ["watch", "src/main.ts"],
      env: { PORT: "${port}", FRONTEND_URL: "${web.origin}" },
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

| Key              | Type             | Description                                                                                                                     |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string, required | Lowercase letters, digits and `-`, starting with a letter. Prefix of the env id and part of browser hostnames.                  |
| `install`        | step[]           | Run by `worker up` before starting, from the checkout root, logged to `.worker/install.log`. Skipped when the env already runs. |
| `setup`          | step[]           | Run by the supervisor in order once ports are assigned, before services start, logged to `.worker/setup.log`.                   |
| `services`       | object, required | Service name (lowercase letters, digits, `-`) to service. Services start together.                                              |
| `startTimeoutMs` | integer          | Time every service has to answer its health path. Default `180000`.                                                             |

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

A service must listen on `127.0.0.1` at the port it receives. Start servers through their binary (`node_modules/.bin/vite`) rather than a package-manager script: pnpm runs scripts in a process group of its own, which teardown cannot reach.

### Interpolation

`command`, `args`, `cwd`, `env` values and `health` accept `${variable}`:

| Variable                         | Value                                                  | Available in             |
| -------------------------------- | ------------------------------------------------------ | ------------------------ |
| `${id}`                          | Env id                                                 | setup, services          |
| `${name}`                        | Config `name`                                          | setup, services          |
| `${root}`                        | Absolute checkout root                                 | install, setup, services |
| `${<service>.port}`              | That service's port                                    | setup, services          |
| `${<service>.url}`               | `http://127.0.0.1:<port>`                              | setup, services          |
| `${<service>.origin}`            | Browser origin when `browser: true`, its URL otherwise | setup, services          |
| `${port}`, `${url}`, `${origin}` | The same values for the service itself                 | services                 |

An unknown variable fails validation. Shell variables in string steps use the `$NAME` form.

## Development

```sh
npm test   # node --test, against the fixture app in fixture/
```

Releases are published to npm by semantic-release from conventional commits on `main`.
