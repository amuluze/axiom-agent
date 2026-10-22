import type { ProjectPreviewBrowserCommand } from '@/platform/projectDesignPreview'

let provider: ProjectPreviewBrowserCommand | null = null

export const setDesignBrowserCommandProvider = (
  next: ProjectPreviewBrowserCommand | null,
): void => {
  provider = next
}

export const designBrowserCommand: ProjectPreviewBrowserCommand = (request) => {
  if (!provider) return Promise.reject(new Error('当前环境无浏览器控制能力（宿主接缝未注入）'))
  return provider(request)
}
