import { loadProjectComponentCatalog } from '@/agent/design/projectComponentCatalog'
import { isTauriRuntime } from './environment'
import { listWorkspace, readWorkspaceText } from './workspace'

export const loadDesignComponentCatalog = (workspacePath?: string) => {
  if (!workspacePath || !isTauriRuntime()) return Promise.resolve(null)
  return loadProjectComponentCatalog({
    list: (path, limit) => listWorkspace(path, limit, workspacePath),
    readText: (path, offset, limit) => readWorkspaceText(path, offset, limit, workspacePath),
  })
}
