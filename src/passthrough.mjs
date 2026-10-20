import { connect, createServer } from "node:net"

// Fronts a service port with a plain TCP relay, so the supervisor sees every
// connection the browser or an agent opens, WebSockets included, without
// parsing what goes through. `onChange` receives the open connection count.
export function passThrough(targetPort, onChange) {
  const clients = new Set()
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({
      host: "127.0.0.1",
      port: targetPort,
      allowHalfOpen: true,
    })
    clients.add(client)
    onChange(clients.size)
    client.once("close", () => {
      clients.delete(client)
      upstream.destroy()
      onChange(clients.size)
    })
    client.on("error", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
    client.pipe(upstream)
    upstream.pipe(client)
  })
  return new Promise((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () =>
      done({
        port: server.address().port,
        connections: () => clients.size,
        close: () => server.close(),
      }),
    )
  })
}
