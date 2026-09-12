import { describe, expect, it } from 'vitest'
import { createRuntimePolicy } from './runtimePolicy'

describe('runtime policy', () => {
  it('keeps Demo provider available for browser development', () => {
    expect(createRuntimePolicy({ development: true, desktop: false })).toMatchObject({
      mode: 'development',
      allowDemoProvider: true,
      allowInitializationFallback: true,
      requireConfiguredProvider: false,
      toolCapabilities: [],
    })
  })

  it('enables secure file tools for desktop development', () => {
    expect(createRuntimePolicy({ development: true, desktop: true }).toolCapabilities).toEqual([
      'filesystem:read',
      'workspace:read',
      'workspace:write',
      'workspace:execute',
      'subagent:explore',
      'subagent:review',
      'web:read',
      'web:browser',
      'computer:control',
      'ssh:remote',
    ])
  })

  it('requires a real Provider and exposes only production file capabilities', () => {
    expect(createRuntimePolicy({ development: false, desktop: true })).toMatchObject({
      mode: 'production',
      allowDemoProvider: false,
      allowInitializationFallback: false,
      requireConfiguredProvider: true,
      toolCapabilities: [
        'filesystem:read',
        'workspace:read',
        'workspace:write',
        'workspace:execute',
        'subagent:explore',
        'subagent:review',
        'web:read',
        'web:browser',
        'computer:control',
        'ssh:remote',
      ],
    })
  })
})
