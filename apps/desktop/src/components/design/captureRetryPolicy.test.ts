import { describe, expect, it } from 'vitest'
import {
  CAPTURE_RETRY_BASE_DELAY_MS,
  captureRetryDelayMs,
  classifyCaptureFailure,
} from './captureRetryPolicy'

describe('原生截图重试策略', () => {
  it('永久失败不再重试：重试只会白等一整轮 15s 超时', () => {
    // 这两条是能确定识别出的永久失败：调用方给错了，或能力探测与实际不一致。
    expect(classifyCaptureFailure('截图矩形无效：x=NaN, y=0, width=0, height=10（须为有限值且宽高 > 0）')).toBe('permanent')
    expect(classifyCaptureFailure('当前平台不支持 WebView 截图')).toBe('permanent')
    expect(classifyCaptureFailure('native capture unsupported on this platform')).toBe('permanent')
  })

  it('瞬时失败仍重试：截图失败的多数成因确实是瞬时类，误判成永久等于丢掉恢复机会', () => {
    // Rust webview_capture.rs 的实际返回文案（超时 / 主线程 / 收结果失败 / 快照失败）。
    expect(classifyCaptureFailure('WebView 截图超时（15s）')).toBe('transient')
    expect(classifyCaptureFailure('无法访问 WebView 主线程：dispatch failed')).toBe('transient')
    expect(classifyCaptureFailure('截图任务失败：thread panicked')).toBe('transient')
    expect(classifyCaptureFailure('WebView 截图失败：snapshot configuration invalid')).toBe('transient')
    // 未知文案按瞬时处理：保持既有行为（原本就会重试一次）。
    expect(classifyCaptureFailure('完全没见过的错误')).toBe('transient')
  })

  it('重试间隔随尝试次数递增，并落在基准的 [0.5, 1.5) 倍带内', () => {
    const first = captureRetryDelayMs(1)
    const second = captureRetryDelayMs(2)
    expect(first).toBeGreaterThanOrEqual(CAPTURE_RETRY_BASE_DELAY_MS * 0.5)
    expect(first).toBeLessThan(CAPTURE_RETRY_BASE_DELAY_MS * 1.5)
    expect(second).toBeGreaterThanOrEqual(CAPTURE_RETRY_BASE_DELAY_MS)
    expect(second).toBeGreaterThan(first)
    // 抖动是确定性的：同一 step 反复调用不漂移，便于断言也让重试可复现。
    expect(captureRetryDelayMs(1)).toBe(first)
    expect(captureRetryDelayMs(2)).toBe(second)
  })

  it('并行重试不会落在同一瞬间：不同 attempt 的相位必须不同', () => {
    // 画布扫描一次并行 4 张截图，固定节奏会让它们在同一时刻重试、再次压上主线程。
    const delays = [1, 2, 3, 4, 5, 6].map(captureRetryDelayMs)
    expect(new Set(delays).size).toBe(delays.length)
  })

  it('非法 attempt 归一到第 1 步，不产生 0 或负的等待', () => {
    expect(captureRetryDelayMs(0)).toBe(captureRetryDelayMs(1))
    expect(captureRetryDelayMs(-5)).toBe(captureRetryDelayMs(1))
    expect(captureRetryDelayMs(1)).toBeGreaterThan(0)
  })
})