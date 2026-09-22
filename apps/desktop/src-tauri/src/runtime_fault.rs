#[cfg(feature = "e2e")]
use std::io::Write;

const CHECKPOINTS: [&str; 14] = [
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
];

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
        terminate_at_checkpoint(checkpoint)
    }
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
