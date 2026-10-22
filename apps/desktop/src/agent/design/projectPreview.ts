export interface ProjectDesignPreview {
	url: string
	catalogSha256: string
}

export const validateProjectPreviewUrl = (value: unknown): string => {
	if (typeof value !== 'string') throw new Error('项目预览 URL 必须是字符串')
	const url = new URL(value)
	if (
		url.protocol !== 'http:' ||
		!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/__axiom_design_preview'
	) {
		throw new Error('项目预览只接受本机 HTTP /__axiom_design_preview 路由')
	}
	return url.href
}

export const projectPreviewIdentity = (
	sha256: string,
	catalogSha256: string,
	pageId: string,
	width: number,
	height: number,
	theme: string,
	workspaceSha256: string,
): string =>
	`AXIOM_PREVIEW_READY ${JSON.stringify({ sha256, catalogSha256, pageId, width, height, theme, workspaceSha256 })}`

export const pageUsesProjectComponents = (
	tree: readonly import('./axSchema').AxNode[],
	components?: readonly import('./componentInventoryHost').DesignComponentDetail[],
): boolean => {
	const names = new Set(components?.map((entry) => entry.summary.name))
	const visit = (node: import('./axSchema').AxNode): boolean =>
		(node.kind === 'component' && typeof node.name === 'string' && names.has(node.name)) ||
		(node.children ?? []).some(visit) ||
		(node.slot ?? []).some(visit)
	return tree.some(visit)
}
