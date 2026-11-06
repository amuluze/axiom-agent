import { describe, expect, it } from 'vitest'
import { normalizeTestOrigin, trustedScopeOrigins, withinTrustedScope } from './trustScope'

describe('normalizeTestOrigin', () => {
  it('normalizes the default port and lowercases the host', () => {
    expect(normalizeTestOrigin('https://Example.com/orders')).toBe('https://example.com:443')
    expect(normalizeTestOrigin('http://example.com:8080/api')).toBe('http://example.com:8080')
  })

  it('rejects credentials and non-http schemes', () => {
    expect(normalizeTestOrigin('https://user:pass@example.com')).toBeNull()
    expect(normalizeTestOrigin('ftp://example.com')).toBeNull()
    expect(normalizeTestOrigin('not a url')).toBeNull()
  })
})

describe('trustedScopeOrigins', () => {
  it('collects the origins the environment declares and ignores broken entries', () => {
    expect(trustedScopeOrigins({
      apiBaseUrl: 'https://10.9.35.5:1443',
      webBaseUrl: 'https://10.9.35.5:1443',
      secretOrigins: ['https://admin.example.com:8443', 'not a url'],
    })).toEqual(['https://10.9.35.5:1443', 'https://admin.example.com:8443'])
  })

  it('is empty when the environment declares nothing', () => {
    expect(trustedScopeOrigins({})).toEqual([])
  })
})

describe('withinTrustedScope', () => {
  const scope = {
    apiBaseUrl: 'https://10.9.35.5:1443',
    webBaseUrl: 'https://shop.example.com',
    secretOrigins: ['https://admin.example.com:8443'],
  }

  it('accepts targets inside the declared origins', () => {
    expect(withinTrustedScope(scope, 'https://10.9.35.5:1443/api/v1/agent/list')).toBe(true)
    expect(withinTrustedScope(scope, 'https://shop.example.com/login')).toBe(true)
    expect(withinTrustedScope(scope, 'https://admin.example.com:8443/console')).toBe(true)
  })

  it('rejects targets outside the declared origins', () => {
    expect(withinTrustedScope(scope, 'https://attacker.example/steal')).toBe(false)
    // 同 host 不同端口不算同一 origin。
    expect(withinTrustedScope(scope, 'https://10.9.35.5:8443/api')).toBe(false)
    // 明文 HTTP 与 HTTPS 是不同 origin。
    expect(withinTrustedScope(scope, 'http://10.9.35.5:1443/api')).toBe(false)
  })
})
