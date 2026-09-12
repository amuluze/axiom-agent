import type { TFunction } from './index'

/**
 * 会话兜底标题的落库哨兵（agent/session/title.ts 产出，持久化层与激活链路
 * 以它判定「尚未命名」并触发首条用户消息自动改名）。哨兵值是数据契约，
 * 不能随界面语言变化，展示层一律经此函数取本地化文案。
 */
const NEW_SESSION_TITLE_SENTINEL = '新会话'

export const displaySessionTitle = (t: TFunction, title: string | null | undefined): string => {
  if (!title || title.trim().length === 0 || title === NEW_SESSION_TITLE_SENTINEL) {
    return t('app.sessionTitle.new')
  }
  return title
}
