import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { writeImageArtifact, writeJsonArtifact } from './artifacts'

const PNG_BASE64 = 'iVBORw0KGgo='

describe('writeImageArtifact', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue({ id: 'artifact-1' })
  })

  it('sends base64 content with the image kind to the Rust write command', async () => {
    await writeImageArtifact({ contentBase64: PNG_BASE64, mediaType: 'image/png' })
    expect(mocks.invoke).toHaveBeenCalledWith('write_artifact', {
      request: expect.objectContaining({
        content: PNG_BASE64,
        encoding: 'base64',
        kind: 'image',
        mediaType: 'image/png',
      }),
    })
  })

  it('rejects non-raster media types such as SVG before reaching Rust', async () => {
    await expect(
      writeImageArtifact({ contentBase64: PNG_BASE64, mediaType: 'image/svg+xml' }),
    ).rejects.toThrow('不支持的图片类型')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('rejects malformed base64 without invoking the command', async () => {
    await expect(
      writeImageArtifact({ contentBase64: 'not base64!', mediaType: 'image/png' }),
    ).rejects.toThrow('图片内容不是合法的 Base64')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('rejects payloads above the 8 MiB artifact limit', async () => {
    const oversize = 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 3) / 3) * 4)
    await expect(
      writeImageArtifact({ contentBase64: oversize, mediaType: 'image/jpeg' }),
    ).rejects.toThrow('图片超过 8 MiB 安全上限')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('writes validated JSON as a JSON artifact', async () => {
    await writeJsonArtifact('{"kind":"axiom.test-plan"}')
    expect(mocks.invoke).toHaveBeenCalledWith('write_artifact', {
      request: expect.objectContaining({
        content: '{"kind":"axiom.test-plan"}',
        encoding: 'utf8',
        kind: 'json',
        mediaType: 'application/json',
      }),
    })
  })

  it('rejects malformed JSON before reaching Rust', async () => {
    await expect(writeJsonArtifact('{')).rejects.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
