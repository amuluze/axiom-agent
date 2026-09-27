// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { parsePenDocument, type PenNode } from '@/agent/design/penParser'
import { WORKER_PARSE_THRESHOLD_CHARS, __resetParseWorkerForTests, parsePenDocumentAsync } from './penParseAsync'

const smallSource = JSON.stringify({
  version: '2.18',
  children: [{ type: 'frame', id: 'page-1', name: '首页' }],
})

/** 构造超过 worker 阈值的文档：少量节点 + 长文案，避免测试自身耗时。 */
const bigSource = JSON.stringify({
  children: [{
    type: 'frame',
    id: 'page-big',
    name: '大稿',
    children: Array.from({ length: 4000 }, (_, index) => ({
      type: 'text',
      id: `t-${index}`,
      content: '长文案'.repeat(200),
    })),
  }],
})

afterEach(() => {
  __resetParseWorkerForTests()
})

describe('parsePenDocumentAsync', () => {
  it('小文档走主线程同步解析，结果与 parsePenDocument 一致', async () => {
    const result = await parsePenDocumentAsync(smallSource, 'small.pen')
    expect(result).toEqual(parsePenDocument(smallSource, 'small.pen'))
    const firstPage = result.document?.pages[0]
    expect(firstPage && 'name' in firstPage ? firstPage.name : undefined).toBe('首页')
  })

  it('超过阈值但无 Worker 环境时回退同步解析（正确性不依赖 worker）', async () => {
    expect(bigSource.length).toBeGreaterThan(WORKER_PARSE_THRESHOLD_CHARS)
    // node/jsdom 均无全局 Worker：ensureWorker 返回 null，走同步回退。
    expect(typeof Worker).toBe('undefined')
    const result = await parsePenDocumentAsync(bigSource, 'big.pen')
    expect(result.error).toBeNull()
    expect(result.document?.pages).toHaveLength(1)
    const page = result.document?.pages[0] as PenNode | undefined
    expect(page?.children).toHaveLength(4000)
  })
})
