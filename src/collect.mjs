// Collects envs whose supervisor died without tearing down (kill -9, reboot,
// deleted checkout). An env id is collected only when every owner recorded on
// its resources names a dead supervisor on this host: live envs, envs of other
// hosts and resources without a readable owner (a supervisor still starting)
// stay. Orphaned services are stopped before their resources are dropped, or
// they would keep writing after the drop.
import { hostname } from "node:os"
import { killGroups, leadsGroupIn } from "./process.mjs"
import { provider } from "./resources.mjs"
import { isSupervisor, readRuntime } from "./state.mjs"

const DONE = ["stopped", "failed"]

// `records` are `{ resource, id, owner }` from every provider's `list`.
export function planCollection({ records, host, isLive }) {
  const envs = new Map()
  for (const { resource, id, owner } of records) {
    const env = envs.get(id) ?? { id, resources: [], owners: [] }
    env.resources.push(resource)
    if (owner) env.owners.push(owner)
    envs.set(id, env)
  }
  const dead = (owner) =>
    owner.host === host &&
    Number.isInteger(owner.pid) &&
    typeof owner.root === "string" &&
    !isLive(owner.pid, owner.root)
  return [...envs.values()]
    .filter(({ owners }) => owners.length && owners.every(dead))
    .map(({ id, resources, owners }) => ({
      id,
      pid: owners[0].pid,
      resources,
      groups: [
        ...new Map(
          owners.flatMap(({ root, groups }) =>
            (Array.isArray(groups) ? groups : []).map((pgid) => [
              `${pgid} ${root}`,
              { pgid, root },
            ]),
          ),
        ).values(),
      ],
    }))
}

// Services of this checkout's last env, when its supervisor died before
// recording them on a resource or the config declares none.
function localOrphans(root) {
  const runtime = readRuntime(root)
  if (!runtime?.pid || DONE.includes(runtime.status)) return []
  if (isSupervisor(runtime.pid, root)) return []
  return Object.values(runtime.services ?? {}).map(({ pid }) => ({
    pgid: pid,
    root,
  }))
}

export async function collectDeadEnvs(root, config, log = console.log) {
  const resources = []
  const records = []
  for (const [name, options] of Object.entries(config.resources)) {
    const resource = provider(options)
    try {
      await resource.check(`resources.${name}`)
      for (const record of await resource.list(config.name))
        records.push({ ...record, resource: name })
      resources.push([name, resource])
    } catch (error) {
      console.error(
        `Skipping collection on resources.${name}: ${error.message}`,
      )
    }
  }
  const byName = Object.fromEntries(resources)
  const plan = planCollection({
    records,
    host: hostname(),
    isLive: isSupervisor,
  })

  const groups = [
    ...localOrphans(root),
    ...plan.flatMap((env) => env.groups),
  ].filter(({ pgid, root: groupRoot }) => leadsGroupIn(pgid, groupRoot))
  for (const { pgid, root: groupRoot } of groups)
    log(`Stopping orphaned process group ${pgid} of ${groupRoot}`)
  await killGroups(groups.map(({ pgid }) => pgid))

  for (const env of plan) {
    log(`Collecting worker env ${env.id} (dead supervisor ${env.pid})`)
    for (const name of env.resources)
      await byName[name]
        .drop(env.id)
        .catch((error) =>
          console.error(
            `Could not drop ${env.id} from resources.${name}: ${error.message}`,
          ),
        )
  }
}
