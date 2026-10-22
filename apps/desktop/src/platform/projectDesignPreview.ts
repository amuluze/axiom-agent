import { browserCommand } from './browserSession'
import {
	projectPreviewIdentity,
	validateProjectPreviewUrl,
} from '@/agent/design/projectPreview'
import type {
	DesignPageRenderFailure,
	DesignPageRenderResult,
} from '@/agent/design/designRenderHost'
import type { AxPage } from '@/agent/design/axSchema'
import type { ProjectDesignPreview } from '@/agent/design/projectPreview'

export type ProjectPreviewBrowserCommand = typeof browserCommand

export const renderProjectDesignPreview = async (input: {
	command?: ProjectPreviewBrowserCommand
	workspacePath?: string
	preview?: ProjectDesignPreview
	file: string
	source: string
	page: AxPage
	theme: 'light' | 'dark'
	maxBytes: number
}): Promise<DesignPageRenderResult | DesignPageRenderFailure> => {
	const command = input.command ?? browserCommand
	let tabId: string | undefined
	try {
		if (!input.workspacePath) throw new Error('项目预览必须绑定当前授权工作区')
		if (!input.preview)
			throw new Error(
				'项目目录未声明 preview.url，请配置并启动 design:preview 服务',
			)
		const { width, height } = input.page
		if (
			!width ||
			!height ||
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width < 1 ||
			height < 1 ||
			width > 4096 ||
			height > 4096
		)
			throw new Error('项目预览页面需要 1–4096 的整数尺寸')
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(input.source),
		)
		const sha256 = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('')
		const workspaceDigest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(input.workspacePath),
		)
		const workspaceSha256 = Array.from(
			new Uint8Array(workspaceDigest),
			(byte) => byte.toString(16).padStart(2, '0'),
		).join('')
		const url = new URL(validateProjectPreviewUrl(input.preview.url))
		for (const [key, value] of Object.entries({
			file: input.file,
			page: input.page.id,
			sha: sha256,
			catalog: input.preview.catalogSha256,
			theme: input.theme,
			workspace: workspaceSha256,
		}))
			url.searchParams.set(key, value)
		const opened = await command({ action: 'newTab' })
		if (opened.type !== 'tabOpened')
			throw new Error('隔离浏览器未返回预览标签页')
		tabId = opened.tab.tabId
		await command({ action: 'setViewport', tabId, width, height })
		await command({ action: 'navigate', tabId, url: url.href })
		const expected = projectPreviewIdentity(
			sha256,
			input.preview.catalogSha256,
			input.page.id,
			width,
			height,
			input.theme,
			workspaceSha256,
		)
		let ready = false
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const snapshot = await command({ action: 'snapshot', tabId })
			if (snapshot.type !== 'snapshot' || snapshot.url !== url.href)
				throw new Error('预览页面发生重定向或响应无效')
			if (snapshot.title === expected) {
				ready = true
				break
			}
			if (snapshot.title === 'AXIOM_PREVIEW_FAILED')
				throw new Error('项目组件运行失败，请检查隔离浏览器控制台')
			await command({ action: 'wait', tabId, durationMs: 250 })
		}
		if (!ready)
			throw new Error(
				'项目预览未完成稿件、目录、页面、主题与尺寸校验，请检查服务或组件错误',
			)
		const screenshot = await command({ action: 'screenshot', tabId })
		if (
			screenshot.type !== 'screenshot' ||
			screenshot.mimeType !== 'image/png' ||
			screenshot.resized ||
			screenshot.width < width ||
			screenshot.width / width !== screenshot.height / height ||
			screenshot.width / width > 3
		)
			throw new Error('项目预览截图尺寸不一致，无法验证此设计页')
		if (screenshot.imageBase64.length > input.maxBytes)
			throw new Error('项目预览截图超过图片预算，请调大 imageMaxBytes')
		const confirmed = await command({ action: 'snapshot', tabId })
		if (
			confirmed.type !== 'snapshot' ||
			confirmed.title !== expected ||
			confirmed.url !== url.href
		)
			throw new Error('截图期间预览状态发生变更，请重试')
		return {
			base64: screenshot.imageBase64,
			mediaType: 'image/png',
			width: screenshot.width,
			height: screenshot.height,
			scale: screenshot.width / width,
			pageName: input.page.name ?? input.page.id,
		}
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		}
	} finally {
		if (tabId)
			await command({ action: 'closeTab', tabId }).catch(() => undefined)
	}
}
