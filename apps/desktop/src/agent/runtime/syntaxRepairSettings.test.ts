import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNTAX_REPAIR_SETTINGS,
  resolveSyntaxRepairSettings,
} from './syntaxRepairSettings'

describe('resolveSyntaxRepairSettings', () => {
  it('defaults to the current session model', () => {
    expect(resolveSyntaxRepairSettings(null)).toEqual(DEFAULT_SYNTAX_REPAIR_SETTINGS)
  })

  it('normalizes a saved provider profile id', () => {
    expect(resolveSyntaxRepairSettings('{"profileId":"  repair-profile  "}')).toEqual({
      profileId: 'repair-profile',
    })
  })

  it('falls back for malformed or empty values', () => {
    expect(resolveSyntaxRepairSettings('{')).toEqual(DEFAULT_SYNTAX_REPAIR_SETTINGS)
    expect(resolveSyntaxRepairSettings('{"profileId":"  "}')).toEqual(DEFAULT_SYNTAX_REPAIR_SETTINGS)
  })
})
