import { createServer } from "node:http"

const { PORT, SELF_ORIGIN, API_URL, FAIL } = process.env

if (FAIL === "start") process.exit(1)
if (FAIL === "later") setTimeout(() => process.exit(1), 3_000)

const probe = async (url) => {
  try {
    const response = await fetch(url)
    return { ok: response.ok, body: await response.text() }
  } catch (error) {
    return { ok: false, error: error.cause?.code ?? error.message }
  }
}

const routes = {
  "/": async () => ({ app: "fixture", pid: process.pid }),
  "/health": async () => ({ ok: true }),
  "/self": async () => probe(`${SELF_ORIGIN}/health`),
  "/api": async () => probe(`${API_URL}/health`),
}

createServer(async (request, response) => {
  const route = routes[new URL(request.url, "http://x").pathname]
  response.writeHead(route ? 200 : 404, { "content-type": "application/json" })
  response.end(JSON.stringify(route ? await route() : { error: "not found" }))
}).listen(Number(PORT), "127.0.0.1")
