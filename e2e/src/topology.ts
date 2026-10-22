import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { getEnv } from './env'

const TopologySchema = z.object({
  name: z.string().min(1),
  app: z.object({ base_url: z.string().url() }),
  host: z.object({ bind: z.string().min(1), loopback_only: z.boolean() }),
})

export type Topology = z.infer<typeof TopologySchema>

let cached: Topology | undefined

export function getTopology(): Topology {
  if (cached) return cached
  const env = getEnv()
  const path = resolve(import.meta.dirname, '..', 'topology', `${env.E2E_TOPOLOGY}.yaml`)
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (env.E2E_APP_BASE) {
    raw.app = { ...(raw.app as Record<string, unknown>), base_url: env.E2E_APP_BASE }
  }
  const parsed = TopologySchema.safeParse(raw)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`topology 校验失败（${path}）：\n${lines.join('\n')}`)
  }
  cached = parsed.data
  return cached
}
