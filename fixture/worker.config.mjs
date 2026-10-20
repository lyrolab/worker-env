const node = process.execPath

export default {
  name: "my-app",
  install: ["echo installed >> install.txt"],
  setup: [
    {
      command: node,
      args: ["setup.mjs"],
      env: { ENV_ID: "${id}", API_URL: "${api.url}" },
    },
  ],
  startTimeoutMs: 20_000,
  services: {
    api: {
      command: node,
      args: ["server.mjs"],
      env: { PORT: "${port}", FAIL: process.env.FIXTURE_FAIL ?? "" },
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
