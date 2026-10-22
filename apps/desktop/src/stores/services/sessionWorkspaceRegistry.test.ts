import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindSessionWorkspace,
  forgetSessionWorkspace,
  forgetSessionsForWorkspace,
  sessionWorkspaceBindings,
  sessionWorkspacePath,
  sessionsForWorkspace,
  setProjectedWorkspacePathSource,
} from './sessionWorkspaceRegistry'

describe('sessionWorkspaceRegistry', () => {
  beforeEach(() => {
    for (const sessionId of [...sessionWorkspaceBindings().keys()]) {
      forgetSessionWorkspace(sessionId)
    }
  })

  // 空路径按解绑处理：写入无效条目会让审批拿到 workspacePath: undefined，
  // Rust 侧随即回落到当前 root——等于让会话在用户正在看的另一个目录里执行。
  it('treats an empty path as unbinding rather than storing an invalid entry', () => {
    bindSessionWorkspace('s1', '/ws/a')
    bindSessionWorkspace('s1', undefined)
    expect(sessionWorkspacePath('s1')).toBeUndefined()
    expect(sessionWorkspaceBindings().has('s1')).toBe(false)
  })

  it('rebinds a session to a different workspace', () => {
    bindSessionWorkspace('s1', '/ws/a')
    bindSessionWorkspace('s1', '/ws/b')
    expect(sessionWorkspacePath('s1')).toBe('/ws/b')
    expect(sessionWorkspaceBindings().size).toBe(1)
  })

  it('keeps sessions isolated', () => {
    bindSessionWorkspace('s1', '/ws/a')
    bindSessionWorkspace('s2', '/ws/b')
    expect(sessionWorkspacePath('s1')).toBe('/ws/a')
    expect(sessionWorkspacePath('s2')).toBe('/ws/b')
    forgetSessionWorkspace('s1')
    expect(sessionWorkspacePath('s1')).toBeUndefined()
    expect(sessionWorkspacePath('s2')).toBe('/ws/b')
  })

  // forget 必须幂等：删会话与 LRU 逐出可能对同一会话先后触发（红线 ① 的 ②③）。
  it('is idempotent on repeated forget', () => {
    bindSessionWorkspace('s1', '/ws/a')
    forgetSessionWorkspace('s1')
    expect(() => forgetSessionWorkspace('s1')).not.toThrow()
    expect(sessionWorkspacePath('s1')).toBeUndefined()
  })

  it('lists and forgets every session bound to a workspace, leaving others intact', () => {
    bindSessionWorkspace('s1', '/ws/a')
    bindSessionWorkspace('s2', '/ws/a')
    bindSessionWorkspace('s3', '/ws/b')

    expect(sessionsForWorkspace('/ws/a')).toEqual(['s1', 's2'])
    expect(forgetSessionsForWorkspace('/ws/a').sort()).toEqual(['s1', 's2'])

    expect(sessionWorkspacePath('s1')).toBeUndefined()
    expect(sessionWorkspacePath('s2')).toBeUndefined()
    expect(sessionWorkspacePath('s3')).toBe('/ws/b')
  })

  it('returns an empty list for a workspace with no bindings', () => {
    bindSessionWorkspace('s1', '/ws/a')
    expect(forgetSessionsForWorkspace('/ws/unknown')).toEqual([])
    expect(sessionWorkspacePath('s1')).toBe('/ws/a')
  })
})

// 不变量自检：运行时绑定与列表投影分叉时记诊断。分叉意味着 harness 未按会话
// 自己的工作区构造，工具调用会经 Rust authorized_root_for(None) 回落到当前活动
// 工作区——必须留下痕迹而非静默降级。
describe('sessionWorkspaceRegistry binding self-check', () => {
  const projected = new Map<string, string>()

  beforeEach(() => {
    for (const sessionId of [...sessionWorkspaceBindings().keys()]) {
      forgetSessionWorkspace(sessionId)
    }
    projected.clear()
    setProjectedWorkspacePathSource((sessionId) => projected.get(sessionId))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    // 复位来源，避免污染同进程内其它用例（模块级单例）。
    setProjectedWorkspacePathSource(() => undefined)
    vi.restoreAllMocks()
  })

  it('reports when the projection has a workspace but the runtime binding is empty', () => {
    projected.set('s1', '/ws/a')
    bindSessionWorkspace('s1', undefined)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('分叉'))
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('/ws/a')
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('无')
  })

  it('reports when the runtime binding points at a different workspace', () => {
    projected.set('s1', '/ws/a')
    bindSessionWorkspace('s1', '/ws/b')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('分叉'))
    // 绑定仍按实际挂载路径写入：租约与执行必须一致，不能改成投影值。
    expect(sessionWorkspacePath('s1')).toBe('/ws/b')
  })

  it('stays silent when the two agree', () => {
    projected.set('s1', '/ws/a')
    bindSessionWorkspace('s1', '/ws/a')
    expect(console.error).not.toHaveBeenCalled()
  })

  // 检查方向是「投影有值而绑定缺失/不同」；投影为空时不报——撤销工作区后两边
  // 同为 null 即属此情形（撤销不保留路径，本表与 DB 的 session.workspace 一并失效）。
  it('stays silent when the projection has no workspace', () => {
    bindSessionWorkspace('s1', '/ws/revoked')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('skips the check when no projection source is injected', () => {
    setProjectedWorkspacePathSource(() => undefined)
    bindSessionWorkspace('s1', undefined)
    expect(console.error).not.toHaveBeenCalled()
  })
})
