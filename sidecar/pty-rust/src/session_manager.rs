use portable_pty::{Child, MasterPty};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_COLS: u16 = 140;
const DEFAULT_ROWS: u16 = 40;
const DEFAULT_MAX_BUFFER_BYTES: usize = 512 * 1024;
pub const FRAME_COALESCE_WINDOW_MS: u64 = 24;
const MAX_LIFECYCLE_EVENTS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowLifecycleState {
    Idle,
    Starting,
    Running,
    Exited,
    Error,
}

impl WindowLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Error => "error",
        }
    }

    pub fn from_str(status: &str) -> Self {
        match status {
            "starting" => Self::Starting,
            "running" => Self::Running,
            "exited" => Self::Exited,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }

    pub fn allows_transition(self, next: Self) -> bool {
        use WindowLifecycleState::{Error, Exited, Idle, Running, Starting};

        if self == next {
            return true;
        }

        matches!(
            (self, next),
            (Idle, Starting)
                | (Idle, Exited)
                | (Starting, Running)
                | (Starting, Exited)
                | (Starting, Error)
                | (Running, Exited)
                | (Running, Error)
                | (Exited, Starting)
                | (Error, Exited)
                | (Error, Starting)
        )
    }
}

#[derive(Clone)]
#[allow(dead_code)]
pub struct WindowLifecycleEvent {
    pub from: String,
    pub to: String,
    pub reason: String,
    pub at_unix_ms: u64,
}

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
    pub query_carry: String,
    pub private_modes: HashMap<i32, bool>,
    pub launch_env: HashMap<String, String>,
    pub lifecycle_events: Vec<WindowLifecycleEvent>,
    pub lifecycle_generation: u64,
    pub output_revision: u64,
    pub frame_cache: Option<FrameRenderCache>,
    pub writer: Option<Box<dyn Write + Send>>,
    pub master: Option<Box<dyn MasterPty + Send>>,
    pub child: Option<Box<dyn Child + Send>>,
}

pub struct FrameRenderCache {
    pub cols: u16,
    pub rows: u16,
    pub source_revision: u64,
    pub rendered_at_unix_ms: u64,
    pub frame: Value,
}

pub fn idle_window_state(session_name: String, window_name: String) -> WindowState {
    WindowState {
        snapshot: WindowSnapshot::idle(session_name, window_name),
        buffer: String::new(),
        query_carry: String::new(),
        private_modes: HashMap::new(),
        launch_env: HashMap::new(),
        lifecycle_events: Vec::new(),
        lifecycle_generation: 0,
        output_revision: 0,
        frame_cache: None,
        writer: None,
        master: None,
        child: None,
    }
}

pub fn mark_output_mutation(window: &mut WindowState) {
    window.output_revision = window.output_revision.saturating_add(1);
}

pub fn transition_window_state(
    window: &mut WindowState,
    next: WindowLifecycleState,
    reason: &str,
) -> Result<(), String> {
    let current = WindowLifecycleState::from_str(&window.snapshot.status);
    if !current.allows_transition(next) {
        return Err(format!(
            "invalid window lifecycle transition: {} -> {}",
            current.as_str(),
            next.as_str()
        ));
    }

    if current != next {
        window.lifecycle_events.push(WindowLifecycleEvent {
            from: current.as_str().to_string(),
            to: next.as_str().to_string(),
            reason: reason.to_string(),
            at_unix_ms: now_unix_millis(),
        });
        if window.lifecycle_events.len() > MAX_LIFECYCLE_EVENTS {
            let overflow = window.lifecycle_events.len() - MAX_LIFECYCLE_EVENTS;
            window.lifecycle_events.drain(..overflow);
        }
    }

    window.snapshot.status = next.as_str().to_string();
    Ok(())
}

pub fn should_coalesce_frame(
    cache: &FrameRenderCache,
    cols: u16,
    rows: u16,
    source_revision: u64,
    now_unix_ms: u64,
) -> bool {
    if cache.cols != cols || cache.rows != rows {
        return false;
    }
    if source_revision <= cache.source_revision {
        return false;
    }

    now_unix_ms.saturating_sub(cache.rendered_at_unix_ms) < FRAME_COALESCE_WINDOW_MS
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

    #[test]
    fn coalesces_frames_only_within_window_and_same_size() {
        let cache = FrameRenderCache {
            cols: 80,
            rows: 24,
            source_revision: 10,
            rendered_at_unix_ms: 1_000,
            frame: Value::Null,
        };

        assert!(should_coalesce_frame(&cache, 80, 24, 11, 1_010));
        assert!(!should_coalesce_frame(&cache, 100, 24, 11, 1_010));
        assert!(!should_coalesce_frame(&cache, 80, 24, 10, 1_010));
        assert!(!should_coalesce_frame(
            &cache,
            80,
            24,
            11,
            1_000 + FRAME_COALESCE_WINDOW_MS + 1
        ));
    }

    #[test]
    fn validates_lifecycle_transition_rules() {
        let mut window = idle_window_state("s".to_string(), "w".to_string());

        transition_window_state(&mut window, WindowLifecycleState::Starting, "start")
            .expect("idle -> starting should work");
        transition_window_state(&mut window, WindowLifecycleState::Running, "spawn")
            .expect("starting -> running should work");
        transition_window_state(&mut window, WindowLifecycleState::Exited, "stop")
            .expect("running -> exited should work");
        transition_window_state(&mut window, WindowLifecycleState::Starting, "restart")
            .expect("exited -> starting should work");
        transition_window_state(&mut window, WindowLifecycleState::Error, "spawn-failed")
            .expect("starting -> error should work");

        let invalid = transition_window_state(&mut window, WindowLifecycleState::Idle, "invalid");
        assert!(invalid.is_err());
        assert_eq!(window.snapshot.status, "error");
        assert!(!window.lifecycle_events.is_empty());
    }
}
