import type { AuthorizedReadFile } from '@/platform/authorizedFiles'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import {
  activateWorkspace as activateWorkspaceAction,
  addWorkspace as addWorkspaceAction,
  authorizeDirectory as authorizeDirectoryAction,
  authorizeFile as authorizeFileAction,
  authorizeWorkspace as authorizeWorkspaceAction,
  refreshWorkspaceBranchInfo as refreshWorkspaceBranchInfoAction,
  revokeFile as revokeFileAction,
  revokeWorkspace as revokeWorkspaceAction,
} from '../workspaceActions'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from '../sessionActions'

/**
 * 工作区/授权文件切片：授权根目录、工作区列表与授权管理动作。
 * 方法全部转发到 workspaceActions 的显式 action 函数。
 */
export interface AgentWorkspaceSlice {
  authorizedFiles: AuthorizedReadFile[]
  authorizedWorkspace: AuthorizedWorkspace | null
  authorizedWorkspaces: AuthorizedWorkspace[]
  authorizeWorkspace: () => Promise<boolean>
  addWorkspace: () => Promise<boolean>
  activateWorkspace: (path: string) => Promise<boolean>
  revokeWorkspace: (path?: string) => Promise<boolean>
  authorizeFile: () => Promise<boolean>
  authorizeDirectory: () => Promise<boolean>
  revokeFile: (path: string) => Promise<boolean>
  refreshWorkspaceBranchInfo: () => Promise<void>
}

export const createAgentWorkspaceSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentWorkspaceSlice => ({
  authorizedFiles: [],
  authorizedWorkspace: null,
  authorizedWorkspaces: [],
  authorizeWorkspace: () => authorizeWorkspaceAction(set, get, deps),
  addWorkspace: () => addWorkspaceAction(set, get, deps),
  activateWorkspace: (path) => activateWorkspaceAction(set, get, deps, path),
  revokeWorkspace: (path) => revokeWorkspaceAction(set, get, deps, path),
  authorizeFile: () => authorizeFileAction(set, get, deps),
  authorizeDirectory: () => authorizeDirectoryAction(set, get, deps),
  revokeFile: (path) => revokeFileAction(set, get, deps, path),
  refreshWorkspaceBranchInfo: () => refreshWorkspaceBranchInfoAction(set, get, deps),
})
