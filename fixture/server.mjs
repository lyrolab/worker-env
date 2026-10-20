import { createHash } from "node:crypto"
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

const server = createServer(async (request, response) => {
  const route = routes[new URL(request.url, "http://x").pathname]
  response.writeHead(route ? 200 : 404, { "content-type": "application/json" })
  response.end(JSON.stringify(route ? await route() : { error: "not found" }))
})

// A WebSocket that stays open until the client closes it, like an HMR socket.
server.on("upgrade", (request, socket) => {
  const accept = createHash("sha1")
    .update(
      `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64")
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.on("error", () => {})
  socket.on("data", (frame) => {
    if ((frame[0] & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0]))
  })
})

server.listen(Number(PORT), "127.0.0.1")
