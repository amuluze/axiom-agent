#[cfg(feature = "e2e")]
use std::io::Write;
#[cfg(feature = "e2e")]
use std::sync::atomic::{AtomicUsize, Ordering};

const CHECKPOINTS: [&str; 18] = [
    "queue_consuming",
    "queue_recovered",
    "tool_execution_started",
    "tool_execution_finished",
    "tool_result_committed",
    "workspace_audit_persisted",
    "workspace_change_step_applied",
    "workspace_trash_restore_step_applied",
    "mutation_batch_committed",
    "compaction_checkpoint_committed",
    "provider_response_received",
    "agent_end_before_settled",
    "intent_fsynced",
    "profile_committed",
    // H1-4 测试运行窗口：动作/响应/证据已发生、状态未结算。
    "test_step_action_applied",
    "test_api_response_received",
    "test_evidence_written",
    "test_step_awaiting_approval",
];

/// 触发前需要命中几次（`AXIOM_E2E_FAULT_HIT`，缺省 1；非法/0 一律按 1）。
///
/// 为什么需要「第 N 次」：有些窗口要看的不是第一次命中时发生的事，而是**第 N 次命中时正在发生什么**。
/// 例如套件运行窗口——必须先让环境探针与第一个文件各完成一次请求（第一个 run 已终态），
/// 再在第二个文件的请求上强杀，才可能断言「各 run 各自 interrupted、batch_id 不丢」。
/// 缺省 1 时行为与以往逐字一致。
#[cfg(feature = "e2e")]
fn fault_hit_target() -> usize {
    std::env::var("AXIOM_E2E_FAULT_HIT")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|target| *target > 0)
        .unwrap_or(1)
}

/// 已命中次数：只在**被武装的那个** checkpoint 上自增（别的 checkpoint 连计数都不碰）。
#[cfg(feature = "e2e")]
static FAULT_HITS: AtomicUsize = AtomicUsize::new(0);

fn validate_checkpoint(checkpoint: &str) -> Result<(), String> {
    if CHECKPOINTS.contains(&checkpoint) {
        Ok(())
    } else {
        Err("unknown E2E runtime fault checkpoint".to_string())
    }
}

#[cfg(feature = "e2e")]
fn terminate_at_checkpoint(checkpoint: &str) -> Result<(), String> {
    let marker = std::env::var("AXIOM_E2E_FAULT_MARKER")
        .map_err(|_| "AXIOM_E2E_FAULT_MARKER is missing".to_string())?;
    let marker_path = std::path::Path::new(&marker);
    if !marker_path.is_absolute() {
        return Err("AXIOM_E2E_FAULT_MARKER must be absolute".to_string());
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path)
        .map_err(|error| format!("failed to create E2E fault marker: {error}"))?;
    file.write_all(checkpoint.as_bytes())
        .map_err(|error| format!("failed to write E2E fault marker: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync E2E fault marker: {error}"))?;
    let marker_parent = marker_path
        .parent()
        .ok_or_else(|| "AXIOM_E2E_FAULT_MARKER has no parent".to_string())?;
    crate::storage_paths::sync_directory(marker_parent)
        .map_err(|error| format!("failed to sync E2E fault marker directory: {error}"))?;
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(std::process::id() as i32, libc::SIGKILL) };
        if result != 0 {
            return Err("failed to SIGKILL the E2E process".to_string());
        }
        std::thread::park();
    }
    #[cfg(not(unix))]
    std::process::abort();
    #[allow(unreachable_code)]
    Ok(())
}

pub(crate) fn checkpoint_if_configured(checkpoint: &str) -> Result<(), String> {
    validate_checkpoint(checkpoint)?;
    #[cfg(not(feature = "e2e"))]
    {
        Ok(())
    }
    #[cfg(feature = "e2e")]
    {
        if std::env::var("AXIOM_E2E_FAULT_CHECKPOINT").as_deref() != Ok(checkpoint) {
            return Ok(());
        }
        let hit = FAULT_HITS.fetch_add(1, Ordering::SeqCst) + 1;
        if hit < fault_hit_target() {
            return Ok(());
        }
        terminate_at_checkpoint(checkpoint)
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub(crate) fn e2e_automation_log(line: String) -> Result<(), String> {
    let Some(path) = std::env::var("AXIOM_E2E_AUTOMATION_LOG").ok() else {
        return Ok(());
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open E2E automation log: {error}"))?;
    file.write_all(line.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|error| format!("failed to write E2E automation log: {error}"))?;
    Ok(())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub(crate) fn e2e_runtime_fault_checkpoint(checkpoint: String) -> Result<(), String> {
    validate_checkpoint(&checkpoint)?;
    let expected = std::env::var("AXIOM_E2E_FAULT_CHECKPOINT")
        .map_err(|_| "AXIOM_E2E_FAULT_CHECKPOINT is missing".to_string())?;
    if checkpoint != expected {
        return Err("E2E runtime fault checkpoint mismatch".to_string());
    }
    terminate_at_checkpoint(&checkpoint)
}
