import { Composer } from '@/components/composer/Composer'
import { WindowActions } from '@/components/session/WindowActions'
import { useT } from '@/i18n'

export const NewTaskView = () => {
  const { t } = useT()
  return (
    <section className="new-task" aria-label={t('app.newTask.aria')}>
      <div className="new-task__drag-region" data-tauri-drag-region aria-hidden="true" />
      {/* 新会话顶部右侧常驻窗口操作图标（帮助 + 终端 + 运行时面板开关） */}
      <div className="new-task__window-bar">
        <WindowActions />
      </div>
      <div className="new-task__heading">
        <h1 className="new-task__title">{t('app.newTask.title')}</h1>
      </div>
      <Composer variant="new-task" />
    </section>
  )
}
