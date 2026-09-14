// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageLightbox } from './ImageLightbox'
import { useUiStore } from '@/stores/uiStore'

describe('ImageLightbox', () => {
  afterEach(() => {
    useUiStore.getState().closeImageLightbox()
  })

  it('renders nothing until an image is opened', () => {
    const { container } = render(<ImageLightbox />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the opened image and closes on overlay click', () => {
    const { container } = render(<ImageLightbox />)
    act(() => {
      useUiStore.getState().openImageLightbox('data:image/png;base64,cG5n', '会话图片')
    })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByAltText('会话图片')).toHaveAttribute('src', 'data:image/png;base64,cG5n')

    fireEvent.click(screen.getByRole('dialog'))
    expect(container).toBeEmptyDOMElement()
  })

  it('closes on Escape', () => {
    const { container } = render(<ImageLightbox />)
    act(() => {
      useUiStore.getState().openImageLightbox('data:image/png;base64,cG5n', '会话图片')
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(container).toBeEmptyDOMElement()
  })

  it('stays open when clicking the image itself', () => {
    render(<ImageLightbox />)
    act(() => {
      useUiStore.getState().openImageLightbox('data:image/png;base64,cG5n', '会话图片')
    })

    fireEvent.click(screen.getByAltText('会话图片'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    act(() => {
      useUiStore.getState().closeImageLightbox()
    })
  })

  it('closes via the close button', () => {
    const { container } = render(<ImageLightbox />)
    act(() => {
      useUiStore.getState().openImageLightbox('data:image/png;base64,cG5n', '会话图片')
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭原图预览' }))
    expect(container).toBeEmptyDOMElement()
  })
})
