export const PROJECT_CONTEXT_HEADING = '# 项目上下文'

export interface SystemPromptLayout {
  stablePrefix: string
  projectContextTail: string | null
}

export const splitSystemPromptLayout = (prompt: string): SystemPromptLayout => {
  const marker = `${PROJECT_CONTEXT_HEADING}\n`
  const index = prompt.indexOf(marker)
  if (index < 0) return { stablePrefix: prompt, projectContextTail: null }
  if (index === 0) return { stablePrefix: '', projectContextTail: prompt }
  if (prompt.slice(index - 2, index) !== '\n\n') {
    return { stablePrefix: prompt, projectContextTail: null }
  }
  return {
    stablePrefix: prompt.slice(0, index - 2),
    projectContextTail: prompt.slice(index),
  }
}

export const insertBeforeProjectContextTail = (
  prompt: string,
  section: string,
): string => {
  if (!section) return prompt
  const layout = splitSystemPromptLayout(prompt)
  return [layout.stablePrefix, section, layout.projectContextTail]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n')
}
