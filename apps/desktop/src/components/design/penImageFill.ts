/**
 * 图片填充的资产加载（docs/design-canvas.md §7 v0.2 图片资产渲染）。
 *
 * .pen 同目录相对路径经 read_design_document_asset 取回并转 data URL；
 * 远程 URL 一律拒绝（§8 防外链泄密面）——解析期已记诊断，这里返回
 * rejected 供渲染层画占位纹理。模块级缓存避免轮询重解析后重复拉取同一资产。
 */
import { useEffect, useState } from 'react'
import type { PenPaintImage } from '@/agent/design/penParser'
import { isRemoteImageUrl } from '@/agent/design/penParser'
import { readDesignDocumentAsset } from '@/platform/designDocument'

// 资产内容变化没有独立监听（watch 只挂 .pen 本体），缓存与 .pen 引用变化同生命周期；
// 上限防长会话无限增长，满了整体清空重建（未命中即重拉，代价一次 IPC）。
const assetCache = new Map<string, Promise<string | null>>()
const ASSET_CACHE_LIMIT = 128

const loadAsset = (penPath: string, url: string): Promise<string | null> => {
  const key = `${penPath}::${url}`
  const cached = assetCache.get(key)
  if (cached) return cached
  if (assetCache.size >= ASSET_CACHE_LIMIT) assetCache.clear()
  const promise = readDesignDocumentAsset(penPath, url)
    .then((asset) => `data:${asset.mediaType};base64,${asset.contentBase64}`)
    // 资产缺失/超限/魔数不符都归一为 null：渲染层按无填充处理，不抛错。
    .catch(() => null)
  assetCache.set(key, promise)
  return promise
}

/**
 * 设计稿内容换代（sha256 变化）时清空资产缓存：资产文件通常与 .pen 同批被
 * Agent 改写，而 watch 只挂 .pen 本体。未触发清空时缓存不失效（已知取舍：
 * 单独改资产不重取）。
 */
export const invalidatePenAssetCache = (): void => {
  assetCache.clear()
}

export interface PenImageFillResult {
  /** 已加载的 data URL；未加载完成或加载失败为 null。 */
  dataUrl: string | null
  /** 远程 URL 被拒绝（渲染占位纹理，不发起任何请求）。 */
  rejected: boolean
}

export const usePenImageFill = (
  penPath: string,
  paint: PenPaintImage | undefined,
): PenImageFillResult => {
  const url = paint?.url
  const remote = url !== undefined && isRemoteImageUrl(url)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!url || remote) {
      setDataUrl(null)
      return undefined
    }
    let cancelled = false
    void loadAsset(penPath, url).then((loaded) => {
      if (!cancelled) setDataUrl(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [penPath, url, remote])
  return { dataUrl, rejected: remote }
}
