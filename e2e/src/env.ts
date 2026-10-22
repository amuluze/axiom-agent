import 'dotenv/config'
import { z } from 'zod'

/** e2e 环境契约：秘密与覆盖走 .env，结构事实走 topology/*.yaml。 */
const EnvSchema = z.object({
  E2E_TOPOLOGY: z.string().min(1).default('local'),
  E2E_APP_BASE: z.string().url().optional(),
  E2E_WORKERS: z.coerce.number().int().positive().default(1),
  E2E_TEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  E2E_EXPECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  E2E_RETRIES: z.coerce.number().int().nonnegative().default(0),
  E2E_HEADLESS: z
    .string()
    .default('1')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),
  /** 宿主签发审批租约的策略：hold（用例显式允许/拒绝）/ auto / deny。 */
  E2E_APPROVAL_POLICY: z.enum(['hold', 'auto', 'deny']).default('hold'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

export function getEnv(): Env {
  if (cached) return cached
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  )
  const parsed = EnvSchema.safeParse(raw)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`e2e environment validation failed:\n${lines.join('\n')}`)
  }
  cached = parsed.data
  return cached
}
