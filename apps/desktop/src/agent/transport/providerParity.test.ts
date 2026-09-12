/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { referenceProviderProfileParser } from './providerProfile'

interface ParityFixture {
  name: string
  input: unknown
  expected: {
    profile?: Record<string, unknown>
    requiresPersistenceMigration?: boolean
    secretMigration?: { sourceSecretId: string; targetSecretId: string } | null
    expectError?: boolean
  }
}

// 与 Rust provider_profiles.rs 的 parity_fixtures_match_the_reference_contract
// 共享同一份黄金夹具（contracts/provider-parity-fixtures.json），锁死双实现漂移。
const fixtures = (JSON.parse(readFileSync(
  new URL('../../../contracts/provider-parity-fixtures.json', import.meta.url),
  'utf8',
)) as { fixtures: ParityFixture[] }).fixtures

describe('Provider parity 黄金夹具（与 Rust 权威解析对照）', () => {
  it.each(fixtures)('$name', async (fixture) => {
    if (fixture.expected.expectError) {
      await expect(referenceProviderProfileParser.decodeWithMetadata(fixture.input)).rejects.toThrow()
      return
    }
    const decoded = await referenceProviderProfileParser.decodeWithMetadata(fixture.input)
    expect(decoded.requiresPersistenceMigration).toBe(fixture.expected.requiresPersistenceMigration)
    expect(decoded.secretMigration ?? null).toEqual(fixture.expected.secretMigration ?? null)
    const profile = decoded.profile as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(fixture.expected.profile ?? {})) {
      expect(profile[key]).toEqual(value)
    }
  })
})
