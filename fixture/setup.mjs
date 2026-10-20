import { appendFileSync } from "node:fs"

const { ENV_ID, API_URL, DATABASE_URL } = process.env
appendFileSync(
  "setup.txt",
  `${[ENV_ID, API_URL, DATABASE_URL].filter(Boolean).join(" ")}\n`,
)
