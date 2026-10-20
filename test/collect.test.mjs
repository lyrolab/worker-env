import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planCollection } from "../src/collect.mjs"
import { leadsGroupIn, sleep } from "../src/process.mjs"

const HOST = "this-host"
const DEAD = 101
const LIVE = 202
const isLive = (pid) => pid === LIVE
const owner = (pid, extra = {}) => ({
  host: HOST,
  pid,
  root: "/checkout",
  groups: [],
  ...extra,
})

test("collects envs whose recorded supervisor is dead on this host", () => {
  const plan = planCollection({
    host: HOST,
    isLive,
    records: [
      {
        resource: "db",
        id: "app_worker_000000000001",
        owner: owner(DEAD, { groups: [11, 12] }),
      },
      {
        resource: "cache",
        id: "app_worker_000000000001",
        owner: owner(DEAD, { groups: [11, 12] }),
      },
      { resource: "db", id: "app_worker_000000000002", owner: owner(LIVE) },
    ],
  })
  assert.deepEqual(plan, [
    {
      id: "app_worker_000000000001",
      pid: DEAD,
      resources: ["db", "cache"],
      groups: [
        { pgid: 11, root: "/checkout" },
        { pgid: 12, root: "/checkout" },
      ],
    },
  ])
})

test("leaves live, foreign, ownerless and malformed owners alone", () => {
  const plan = planCollection({
    host: HOST,
    isLive,
    records: [
      { resource: "db", id: "app_worker_000000000002", owner: owner(LIVE) },
      {
        resource: "db",
        id: "app_worker_000000000003",
        owner: owner(DEAD, { host: "other-host" }),
      },
      { resource: "db", id: "app_worker_000000000004", owner: undefined },
      {
        resource: "db",
        id: "app_worker_000000000005",
        owner: { host: HOST, pid: "101", root: "/checkout" },
      },
    ],
  })
  assert.deepEqual(plan, [])
})

test("keeps an env when one of its owner records names a live supervisor", () => {
  const plan = planCollection({
    host: HOST,
    isLive,
    records: [
      { resource: "db", id: "app_worker_000000000006", owner: owner(DEAD) },
      { resource: "cache", id: "app_worker_000000000006", owner: owner(LIVE) },
    ],
  })
  assert.deepEqual(plan, [])
})

test("a process group counts as the checkout's only while its leader runs from it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-env-group-")))
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  })
  try {
    assert.equal(leadsGroupIn(child.pid, root), true)
    assert.equal(
      leadsGroupIn(child.pid, join(root, "sub")),
      false,
      "another directory",
    )
    assert.equal(
      leadsGroupIn(process.pid, root),
      false,
      "not from the checkout",
    )
  } finally {
    process.kill(-child.pid, "SIGKILL")
    await sleep(100)
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(leadsGroupIn(child.pid, root), false, "a dead leader")
})
