import { describe, expect, it } from 'vitest'
import { classifyProviderError } from './providerError'

describe('classifyProviderError', () => {
  it('distinguishes overflow from retryable throttling and authentication failures', () => {
    expect(classifyProviderError({
      message: 'maximum context length exceeded',
      code: 'context_length_exceeded',
    })).toMatchObject({ kind: 'context_overflow', retryable: false })
    expect(classifyProviderError({
      message: 'too many requests',
      status: 429,
    })).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(classifyProviderError({
      message: 'invalid API key',
      status: 401,
    })).toMatchObject({ kind: 'authentication', retryable: false })
  })

  it('exposes a friendly userMessage while keeping the technical message intact', () => {
    const server = classifyProviderError({
      message: 'HTTP 503: Service is too busy. Please retry later.',
      status: 503,
    })
    expect(server.message).toBe('HTTP 503: Service is too busy. Please retry later.')
    expect(server.userMessage).toContain('HTTP 503')
    expect(server.userMessage).toContain('模型服务暂时不可用')

    const rateLimited = classifyProviderError({ message: 'too many requests', status: 429 })
    expect(rateLimited.userMessage).toContain('已自动重试仍被限流')

    const overflow = classifyProviderError({ message: 'maximum context length exceeded' })
    expect(overflow.userMessage).toContain('上下文上限')
    expect(overflow.retryable).toBe(false)
  })

  it('classifies overloaded engine responses as rate-limited even without an HTTP prefix', () => {
    expect(classifyProviderError({ message: 'The engine is currently overloaded, please try again later' }))
      .toMatchObject({
        kind: 'rate_limit',
        retryable: true,
        userMessage: expect.stringContaining('已自动重试仍被限流'),
      })
    expect(classifyProviderError({ type: 'overloaded_error', status: 529 } as Parameters<typeof classifyProviderError>[0]))
      .toMatchObject({ kind: 'rate_limit', retryable: true })
  })

  it('surfaces Kimi platform-specific auth hints without breaking generic classification', () => {
    const coding = classifyProviderError({
      message: 'HTTP 401: Invalid Authentication',
      status: 401,
      providerId: 'kimi-coding',
    })
    expect(coding.kind).toBe('authentication')
    expect(coding.userMessage).toContain('Kimi Coding Plan')

    const open = classifyProviderError({
      message: 'HTTP 401: Invalid Authentication',
      status: 401,
      providerId: 'kimi',
    })
    expect(open.userMessage).toContain('Kimi 开放平台')

    // 无 providerId 或未覆盖的 provider 仍回退到通用认证文案。
    const generic = classifyProviderError({ message: 'invalid api key', status: 401 })
    expect(generic.userMessage).toContain('API Key')
    const other = classifyProviderError({ message: 'invalid api key', status: 401, providerId: 'openai' })
    expect(other.userMessage).toContain('API Key')
  })
})
