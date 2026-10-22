import { useEffect, useState } from 'react'
import type { AxPage } from '@/agent/design/axSchema'
import type { PenDocument } from '@/agent/design/penParser'
import { renderProjectDesignPreview } from '@/platform/projectDesignPreview'
import { useT } from '@/i18n'

const ProjectDesignPreview = ({
	document,
	page,
	theme,
}: {
	document: PenDocument
	page: AxPage
	theme: 'light' | 'dark'
}) => {
	const { t } = useT()
	const [image, setImage] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [revision, setRevision] = useState(1)
	useEffect(() => {
		let cancelled = false
		setImage(null)
		setMessage(null)
		setBusy(true)
		void renderProjectDesignPreview({
			workspacePath: document.workspacePath,
			preview: document.projectPreview,
			source: document.axSource ?? '',
			file: document.fileName,
			page,
			theme,
			maxBytes: 6 * 1024 * 1024,
		})
			.then((result) => {
				if (cancelled) return
				if ('ok' in result) setMessage(result.reason)
				else setImage(`data:image/png;base64,${result.base64}`)
			})
			.finally(() => {
				if (!cancelled) setBusy(false)
			})
		return () => {
			cancelled = true
		}
	}, [document, page, theme, revision])
	return (
		<div
			className="design-project-preview"
			data-pen-id={page.id}
			style={{ width: page.width, height: page.height }}
		>
			{image ? (
				<img
					src={image}
					alt={page.name ?? page.id}
					width={page.width}
					height={page.height}
					draggable={false}
				/>
			) : (
				<p>{t('app.design.projectPreview.hint')}</p>
			)}
			<button
				type="button"
				disabled={busy}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={() => setRevision((value) => value + 1)}
			>
				{t(busy ? 'app.design.loading' : 'app.design.projectPreview.refresh')}
			</button>
			{message && <p role="status">{message}</p>}
		</div>
	)
}

export default ProjectDesignPreview
