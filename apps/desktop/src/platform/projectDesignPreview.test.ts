import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { renderProjectDesignPreview } from './projectDesignPreview'
import { browserCommand } from './browserSession'
import { projectPreviewIdentity } from '@/agent/design/projectPreview'

vi.mock('./browserSession', () => ({ browserCommand: vi.fn() }))
const source = '{}'
const input = {
	workspacePath: '/project',
	preview: {
		url: 'http://127.0.0.1:4189/__axiom_design_preview',
		catalogSha256: 'c'.repeat(64),
	},
	file: '.pen/a.ax',
	source,
	page: { id: 'p1', width: 400, height: 300, tree: [] },
	theme: 'dark' as const,
	maxBytes: 1024,
}
beforeEach(() => {
	vi.stubGlobal('crypto', webcrypto)
	vi.mocked(browserCommand).mockReset()
})
const browser = async (override?: 'identity' | 'geometry' | 'capture') => {
	const digest = await webcrypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(source),
	)
	const sha = Array.from(new Uint8Array(digest), (value) =>
		value.toString(16).padStart(2, '0'),
	).join('')
	const workspaceDigest = await webcrypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(input.workspacePath),
	)
	const workspaceSha = Array.from(new Uint8Array(workspaceDigest), (value) =>
		value.toString(16).padStart(2, '0'),
	).join('')
	let url = ''
	vi.mocked(browserCommand).mockImplementation(async (request) => {
		if (request.action === 'newTab')
			return {
				type: 'tabOpened',
				tab: {
					tabId: 'preview',
					url: '',
					title: '',
					active: true,
					hasDialog: false,
				},
			}
		if (request.action === 'navigate') {
			url = request.url
			return { type: 'navigated', url, title: '' }
		}
		if (request.action === 'snapshot')
			return {
				type: 'snapshot',
				url,
				title:
					override === 'identity'
						? 'AXIOM_PREVIEW_FAILED'
						: projectPreviewIdentity(
								sha,
								input.preview.catalogSha256,
								'p1',
								400,
								300,
								'dark',
								workspaceSha,
							),
				text: '',
				truncated: false,
			}
		if (request.action === 'screenshot') {
			if (override === 'capture') throw new Error('capture failed')
			return {
				type: 'screenshot',
				imageBase64: 'PNG',
				mimeType: 'image/png',
				width: 800,
				height: override === 'geometry' ? 599 : 600,
				resized: false,
			}
		}
		return { type: 'done' }
	})
}
it('完整校验后返回真实截图与 DPR 比例，并关闭独立标签页', async () => {
	await browser()
	expect(await renderProjectDesignPreview(input)).toMatchObject({
		base64: 'PNG',
		width: 800,
		height: 600,
		scale: 2,
	})
	expect(browserCommand).toHaveBeenLastCalledWith({
		action: 'closeTab',
		tabId: 'preview',
	})
})
it('运行失败、尺寸漂移和截图错误不返回成功图片，仍关闭标签页', async () => {
	for (const failure of ['identity', 'geometry', 'capture'] as const) {
		await browser(failure)
		expect(await renderProjectDesignPreview(input)).toMatchObject({ ok: false })
		expect(browserCommand).toHaveBeenLastCalledWith({
			action: 'closeTab',
			tabId: 'preview',
		})
	}
})
it('外网地址与缺失配置在打开浏览器前被拒绝', async () => {
	expect(
		await renderProjectDesignPreview({ ...input, preview: undefined }),
	).toMatchObject({ ok: false })
	expect(
		await renderProjectDesignPreview({
			...input,
			preview: {
				...input.preview,
				url: 'http://example.com/__axiom_design_preview',
			},
		}),
	).toMatchObject({ ok: false })
	expect(browserCommand).not.toHaveBeenCalled()
})

it('Agent 的 scoped 浏览器拒绝会透传，不回退到 UI 浏览器通道', async () => {
	const command = vi.fn(async () => {
		throw new Error('readonly child browser denied')
	})
	expect(await renderProjectDesignPreview({ ...input, command })).toMatchObject(
		{ ok: false, reason: 'readonly child browser denied' },
	)
	expect(command).toHaveBeenCalledOnce()
	expect(browserCommand).not.toHaveBeenCalled()
})
