import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

/**
 * 会话截图灯箱：点击消息里的缩略图后全屏查看原图。图片按视口约束放大
 * （92vw/92vh 内保持宽高比），Esc 或点击遮罩/关闭按钮退出。挂在 App 根部
 * 单例渲染，state 在 uiStore——消息渲染层只负责打开。
 */
export const ImageLightbox = () => {
  const { t } = useT()
  const imageLightbox = useUiStore((state) => state.imageLightbox)
  const closeImageLightbox = useUiStore((state) => state.closeImageLightbox)

  useEffect(() => {
    if (!imageLightbox) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeImageLightbox()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [imageLightbox, closeImageLightbox])

  if (!imageLightbox) return null
  return (
    <div
      aria-label={t('app.imageLightbox.aria')}
      aria-modal="true"
      className="image-lightbox"
      onClick={closeImageLightbox}
      role="dialog"
    >
      <button
        aria-label={t('app.imageLightbox.closeAria')}
        className="image-lightbox__close"
        onClick={closeImageLightbox}
        type="button"
      >
        <X size={18} />
      </button>
      <img
        alt={imageLightbox.alt}
        className="image-lightbox__image"
        onClick={(event) => event.stopPropagation()}
        src={imageLightbox.src}
      />
    </div>
  )
}
