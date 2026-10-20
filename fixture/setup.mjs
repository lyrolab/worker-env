import { appendFileSync } from "node:fs"

appendFileSync("setup.txt", `${process.env.ENV_ID} ${process.env.API_URL}\n`)
