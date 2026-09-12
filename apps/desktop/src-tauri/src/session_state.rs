use sqlx::pool::PoolConnection;
use sqlx::{Sqlite, SqlitePool};
use tokio::sync::Mutex;

/// 持有 Session Repository SQLite 连接池的共享状态。
///
/// 此类型放在中立模块,供 `session_repository` 与 `session_mutations`
/// 两个模块作为 Tauri `State` 共同引用,避免它们之间形成真实循环依赖。
///
/// 连接模型:WAL 单写多读的连接池(对齐多会话并行——池为空 Mutex 只在
/// 未初始化判定时短暂持有,稳态 acquire 不经过全局锁;写仍由 SQLite
/// 单写者串行,经 busy_timeout 排队,读与写、读与读并发)。每个池连接
/// 经 `create_options` 统一携带 busy_timeout / WAL / foreign_keys 选项
/// (foreign_keys 是 per-connection 开关,池化后不能只依赖 init 时的
/// 一次性 PRAGMA)。
#[derive(Default)]
pub struct SessionRepositoryState {
    pub(crate) pool: Mutex<Option<SqlitePool>>,
}

impl SessionRepositoryState {
    /// 从池中取一个连接。池未初始化(None)时与旧单连接模型同语义地报错。
    /// Mutex 守卫只在克隆池句柄期间持有,真正的 `acquire().await` 在锁外
    /// 进行——不会把全局初始化门变成新的串行点。
    pub(crate) async fn acquire(&self) -> Result<PoolConnection<Sqlite>, String> {
        let pool = self
            .pool
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "SessionRepository 尚未初始化".to_string())?;
        pool.acquire()
            .await
            .map_err(|error| format!("无法获取 Axiom SQLite 连接：{error}"))
    }
}
