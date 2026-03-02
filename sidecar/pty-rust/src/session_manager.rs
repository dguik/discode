use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_COLS: u16 = 140;
const DEFAULT_ROWS: u16 = 40;
const DEFAULT_MAX_BUFFER_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub struct WindowSnapshot {
    pub session_name: String,
    pub window_name: String,
    pub status: String,
    pub pid: Option<u32>,
    pub started_at: Option<i64>,
    pub exited_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

impl WindowSnapshot {
    pub fn idle(session_name: String, window_name: String) -> Self {
        Self {
            session_name,
            window_name,
            status: "idle".to_string(),
            pid: None,
            started_at: None,
            exited_at: None,
            exit_code: None,
            signal: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }
}

pub struct WindowState {
    pub snapshot: WindowSnapshot,
    pub buffer: String,
    pub writer: Option<Box<dyn Write + Send>>,
    pub master: Option<Box<dyn MasterPty + Send>>,
    pub child: Option<Box<dyn Child + Send>>,
}

pub fn idle_window_state(session_name: String, window_name: String) -> WindowState {
    WindowState {
        snapshot: WindowSnapshot::idle(session_name, window_name),
        buffer: String::new(),
        writer: None,
        master: None,
        child: None,
    }
}

pub type SessionEnv = HashMap<String, String>;
pub type SessionRegistry = HashMap<String, SessionEnv>;
pub type SharedWindowState = Arc<Mutex<WindowState>>;
pub type WindowRegistry = HashMap<String, SharedWindowState>;

pub struct RpcMethodMetrics {
    pub requests: u64,
    pub errors: u64,
    pub total_latency_ms: u64,
    pub max_latency_ms: u64,
    pub last_latency_ms: u64,
    pub last_error_code: Option<String>,
}

impl RpcMethodMetrics {
    fn new() -> Self {
        Self {
            requests: 0,
            errors: 0,
            total_latency_ms: 0,
            max_latency_ms: 0,
            last_latency_ms: 0,
            last_error_code: None,
        }
    }
}

pub struct RpcObservability {
    pub requests_total: u64,
    pub errors_total: u64,
    pub methods: HashMap<String, RpcMethodMetrics>,
}

impl RpcObservability {
    fn new() -> Self {
        Self {
            requests_total: 0,
            errors_total: 0,
            methods: HashMap::new(),
        }
    }
}

pub struct SidecarState {
    pub sessions: SessionRegistry,
    pub windows: WindowRegistry,
    pub max_buffer_bytes: usize,
    pub started_at_unix_ms: u64,
    pub rpc_observability: RpcObservability,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            windows: HashMap::new(),
            max_buffer_bytes: DEFAULT_MAX_BUFFER_BYTES,
            started_at_unix_ms: now_unix_millis(),
            rpc_observability: RpcObservability::new(),
        }
    }
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

pub type SharedSidecarState = Arc<Mutex<SidecarState>>;

pub fn new_shared_state() -> SharedSidecarState {
    Arc::new(Mutex::new(SidecarState::new()))
}

pub fn window_key(session_name: &str, window_name: &str) -> String {
    format!("{session_name}:{window_name}")
}

pub fn with_window<T>(
    state: &SharedSidecarState,
    session_name: &str,
    window_name: &str,
    mut f: impl FnMut(&mut WindowState) -> Result<T, String>,
) -> Result<T, String> {
    let key = window_key(session_name, window_name);
    let window = {
        let guard = lock_state(state);
        guard
            .windows
            .get(&key)
            .cloned()
            .ok_or_else(|| format!("window not found: {key}"))?
    };
    let mut guard = lock_window(&window);
    f(&mut guard)
}

pub fn record_rpc_observation(
    state: &SharedSidecarState,
    method: &str,
    latency_ms: u64,
    error_code: Option<&str>,
) {
    let mut guard = lock_state(state);
    let observability = &mut guard.rpc_observability;
    observability.requests_total = observability.requests_total.saturating_add(1);

    let method_metrics = observability
        .methods
        .entry(method.to_string())
        .or_insert_with(RpcMethodMetrics::new);
    method_metrics.requests = method_metrics.requests.saturating_add(1);
    method_metrics.total_latency_ms = method_metrics.total_latency_ms.saturating_add(latency_ms);
    method_metrics.last_latency_ms = latency_ms;
    if latency_ms > method_metrics.max_latency_ms {
        method_metrics.max_latency_ms = latency_ms;
    }

    if let Some(code) = error_code {
        observability.errors_total = observability.errors_total.saturating_add(1);
        method_metrics.errors = method_metrics.errors.saturating_add(1);
        method_metrics.last_error_code = Some(code.to_string());
    }
}

pub fn lock_state<'a>(state: &'a SharedSidecarState) -> MutexGuard<'a, SidecarState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn lock_window<'a>(window: &'a SharedWindowState) -> MutexGuard<'a, WindowState> {
    window
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_per_method_rpc_observability() {
        let state = new_shared_state();

        record_rpc_observation(&state, "hello", 3, None);
        record_rpc_observation(&state, "hello", 5, Some("INTERNAL"));

        let guard = lock_state(&state);
        assert_eq!(guard.rpc_observability.requests_total, 2);
        assert_eq!(guard.rpc_observability.errors_total, 1);

        let hello = guard
            .rpc_observability
            .methods
            .get("hello")
            .expect("expected hello metrics");
        assert_eq!(hello.requests, 2);
        assert_eq!(hello.errors, 1);
        assert_eq!(hello.last_latency_ms, 5);
        assert_eq!(hello.max_latency_ms, 5);
        assert_eq!(hello.total_latency_ms, 8);
        assert_eq!(hello.last_error_code.as_deref(), Some("INTERNAL"));
    }
}
