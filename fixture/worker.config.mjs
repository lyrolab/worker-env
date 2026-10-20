const node = process.execPath
const { FIXTURE_FAIL, FIXTURE_POSTGRES } = process.env

export default {
  name: "my-app",
  install: ["echo installed >> install.txt"],
  setup: [
    {
      command: node,
      args: ["setup.mjs"],
      env: {
        ENV_ID: "${id}",
        API_URL: "${api.url}",
        ...(FIXTURE_POSTGRES && { DATABASE_URL: "${db.url}" }),
      },
    },
  ],
  ...(FIXTURE_POSTGRES && {
    resources: {
      db: {
        type: "postgres",
        container: FIXTURE_POSTGRES,
        url: "postgres://postgres:postgres@localhost:5432",
      },
    },
  }),
  startTimeoutMs: 20_000,
  services: {
    api: {
      command: node,
      args: ["server.mjs"],
      env: { PORT: "${port}", FAIL: FIXTURE_FAIL ?? "" },
      health: "/health",
    },
    web: {
      command: node,
      args: ["server.mjs"],
      env: { PORT: "${port}", SELF_ORIGIN: "${origin}", API_URL: "${api.url}" },
      browser: true,
    },
  },
}
