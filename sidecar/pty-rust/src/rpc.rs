use crate::pty_bus::{
    dispose_window, resize_window, spawn_window_process, stop_window, write_input,
};
use crate::session_manager::{
    idle_window_state, lock_state, lock_window, window_key, with_window, SharedSidecarState,
};
use crate::vt_lite::build_styled_frame;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ERROR_INVALID_REQUEST: &str = "INVALID_REQUEST";
pub const ERROR_INVALID_PARAMS: &str = "INVALID_PARAMS";
pub const ERROR_UNKNOWN_METHOD: &str = "UNKNOWN_METHOD";
pub const ERROR_WINDOW_NOT_FOUND: &str = "WINDOW_NOT_FOUND";
pub const ERROR_REQUEST_TIMEOUT: &str = "REQUEST_TIMEOUT";
pub const ERROR_INTERNAL: &str = "INTERNAL";

#[derive(Deserialize, Serialize)]
pub struct RpcRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default, rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub fn invalid_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ERROR_INVALID_REQUEST, message)
}

pub fn request_timeout(method: &str, timeout_ms: u64, elapsed_ms: u128) -> RpcError {
    RpcError::new(
        ERROR_REQUEST_TIMEOUT,
        format!(
            "request timed out for method '{method}' (timeout={}ms, elapsed={}ms)",
            timeout_ms, elapsed_ms
        ),
    )
}

pub fn map_runtime_error(error: String) -> RpcError {
    if error.starts_with("missing or invalid '") {
        return RpcError::new(ERROR_INVALID_PARAMS, error);
    }
    if error.starts_with("window not found:") {
        return RpcError::new(ERROR_WINDOW_NOT_FOUND, error);
    }
    if error.starts_with("unknown method:") {
        return RpcError::new(ERROR_UNKNOWN_METHOD, error);
    }
    RpcError::new(ERROR_INTERNAL, error)
}

pub fn handle_request(
    state: &SharedSidecarState,
    req: RpcRequest,
    should_shutdown: &mut bool,
) -> Result<Value, RpcError> {
    match req.method.as_str() {
        "hello" => Ok(json!({ "version": 1 })),
        "health" => {
            let guard = lock_state(state);
            let running_windows = guard
                .windows
                .values()
                .filter(|window| {
                    window
                        .lock()
                        .ok()
                        .map(|w| w.snapshot.status == "running")
                        .unwrap_or(false)
                })
                .count();
            let now_unix_ms = now_unix_millis();
            let method_metrics = guard
                .rpc_observability
                .methods
                .iter()
                .map(|(method, metrics)| {
                    let avg_latency_ms = if metrics.requests > 0 {
                        metrics.total_latency_ms / metrics.requests
                    } else {
                        0
                    };
                    (
                        method.clone(),
                        json!({
                            "requests": metrics.requests,
                            "errors": metrics.errors,
                            "lastLatencyMs": metrics.last_latency_ms,
                            "avgLatencyMs": avg_latency_ms,
                            "maxLatencyMs": metrics.max_latency_ms,
                            "lastErrorCode": metrics.last_error_code,
                        }),
                    )
                })
                .collect::<serde_json::Map<String, Value>>();
            Ok(json!({
                "status": "ok",
                "version": 1,
                "pid": std::process::id(),
                "startedAtUnixMs": guard.started_at_unix_ms,
                "uptimeMs": now_unix_ms.saturating_sub(guard.started_at_unix_ms),
                "sessions": guard.sessions.len(),
                "windows": guard.windows.len(),
                "runningWindows": running_windows,
                "rpc": {
                    "requestsTotal": guard.rpc_observability.requests_total,
                    "errorsTotal": guard.rpc_observability.errors_total,
                    "methods": method_metrics,
                },
            }))
        }
        "get_or_create_session" => {
            let project_name = get_str(&req.params, "projectName")?;
            let first_window_name = get_opt_str(&req.params, "firstWindowName");

            let mut guard = lock_state(state);
            guard.sessions.entry(project_name.clone()).or_default();

            if let Some(window_name) = first_window_name {
                let key = window_key(&project_name, &window_name);
                guard.windows.entry(key).or_insert_with(|| {
                    Arc::new(Mutex::new(idle_window_state(
                        project_name.clone(),
                        window_name,
                    )))
                });
            }

            Ok(json!({ "sessionName": project_name }))
        }
        "set_session_env" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let key = get_str(&req.params, "key")?;
            let value = get_str(&req.params, "value")?;

            let mut guard = lock_state(state);
            let env = guard.sessions.entry(session_name).or_default();
            env.insert(key, value);
            Ok(json!({ "ok": true }))
        }
        "window_exists" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let key = window_key(&session_name, &window_name);

            let guard = lock_state(state);
            Ok(json!({ "exists": guard.windows.contains_key(&key) }))
        }
        "start_window" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let command = get_str(&req.params, "command")?;

            start_window(state, session_name, window_name, command).map_err(map_runtime_error)?;
            Ok(json!({ "ok": true }))
        }
        "type_keys" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let keys = get_str(&req.params, "keys")?;
            with_window(state, &session_name, &window_name, |window| {
                write_input(window, keys.as_bytes())
            })
            .map_err(map_runtime_error)?;
            Ok(json!({ "ok": true }))
        }
        "send_enter" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            with_window(state, &session_name, &window_name, |window| {
                write_input(window, b"\r")
            })
            .map_err(map_runtime_error)?;
            Ok(json!({ "ok": true }))
        }
        "resize_window" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let cols = get_u16(&req.params, "cols", 140);
            let rows = get_u16(&req.params, "rows", 40);

            with_window(state, &session_name, &window_name, |window| {
                resize_window(window, cols, rows);
                Ok(())
            })
            .map_err(map_runtime_error)?;
            Ok(json!({ "ok": true }))
        }
        "list_windows" => {
            let session_filter = get_opt_str(&req.params, "sessionName");
            let windows = {
                let guard = lock_state(state);
                guard
                    .windows
                    .values()
                    .filter_map(|window| {
                        let w = window.lock().ok()?;
                        if let Some(ref session) = session_filter {
                            if &w.snapshot.session_name != session {
                                return None;
                            }
                        }
                        Some(json!({
                            "sessionName": w.snapshot.session_name,
                            "windowName": w.snapshot.window_name,
                            "status": w.snapshot.status,
                            "pid": w.snapshot.pid,
                            "startedAt": w.snapshot.started_at,
                            "exitedAt": w.snapshot.exited_at,
                            "exitCode": w.snapshot.exit_code,
                            "signal": w.snapshot.signal,
                        }))
                    })
                    .collect::<Vec<_>>()
            };
            Ok(json!({ "windows": windows }))
        }
        "get_window_buffer" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let buffer = with_window(state, &session_name, &window_name, |window| {
                Ok(window.buffer.clone())
            })
            .map_err(map_runtime_error)?;
            Ok(json!({ "buffer": buffer }))
        }
        "get_window_frame" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;
            let requested_cols = get_opt_u16(&req.params, "cols");
            let requested_rows = get_opt_u16(&req.params, "rows");

            let frame = with_window(state, &session_name, &window_name, |window| {
                let cols = requested_cols.unwrap_or(window.snapshot.cols);
                let rows = requested_rows.unwrap_or(window.snapshot.rows);
                Ok(build_styled_frame(&window.buffer, cols, rows))
            })
            .map_err(map_runtime_error)?;
            Ok(frame)
        }
        "stop_window" => {
            let session_name = get_str(&req.params, "sessionName")?;
            let window_name = get_str(&req.params, "windowName")?;

            let stopped = with_window(state, &session_name, &window_name, stop_window)
                .map_err(map_runtime_error)?;

            Ok(json!({ "stopped": stopped }))
        }
        "dispose" => {
            let windows = {
                let guard = lock_state(state);
                guard.windows.values().cloned().collect::<Vec<_>>()
            };

            for window in windows {
                if let Ok(mut window) = window.lock() {
                    dispose_window(&mut window);
                }
            }

            *should_shutdown = true;
            Ok(json!({ "ok": true }))
        }
        _ => Err(RpcError::new(
            ERROR_UNKNOWN_METHOD,
            format!("unknown method: {}", req.method),
        )),
    }
}

fn get_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| RpcError::new(ERROR_INVALID_PARAMS, format!("missing or invalid '{key}'")))
}

fn get_opt_str(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn get_opt_u16(params: &Value, key: &str) -> Option<u16> {
    let value = params.get(key)?.as_u64()?;
    Some(value.clamp(10, 400) as u16)
}

fn get_u16(params: &Value, key: &str, default: u16) -> u16 {
    get_opt_u16(params, key).unwrap_or(default)
}

fn start_window(
    state: &SharedSidecarState,
    session_name: String,
    window_name: String,
    command: String,
) -> Result<(), String> {
    let key = window_key(&session_name, &window_name);

    let window = {
        let mut guard = lock_state(state);
        guard
            .windows
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Mutex::new(idle_window_state(
                    session_name.clone(),
                    window_name.clone(),
                )))
            })
            .clone()
    };

    {
        let mut w = lock_window(&window);
        if w.child.is_some() && w.snapshot.status == "running" {
            return Ok(());
        }
        w.snapshot.status = "starting".to_string();
        w.snapshot.started_at = Some(now_unix_seconds());
        w.snapshot.exited_at = None;
        w.snapshot.exit_code = None;
        w.snapshot.signal = None;
        w.buffer.clear();
    }

    spawn_window_process(state, &window, &session_name, command)?;

    Ok(())
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::new_shared_state;
    use std::thread;
    use std::time::Duration;

    struct Cleanup(SharedSidecarState);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let mut should_shutdown = false;
            let _ = handle_request(
                &self.0,
                RpcRequest {
                    id: None,
                    method: "dispose".to_string(),
                    params: json!({}),
                    timeout_ms: None,
                },
                &mut should_shutdown,
            );
        }
    }

    fn call(state: &SharedSidecarState, method: &str, params: Value) -> Value {
        let mut should_shutdown = false;
        handle_request(
            state,
            RpcRequest {
                id: None,
                method: method.to_string(),
                params,
                timeout_ms: None,
            },
            &mut should_shutdown,
        )
        .unwrap_or_else(|err| panic!("{method} failed: {err}"))
    }

    #[test]
    fn preserves_session_and_window_registry_methods() {
        let state = new_shared_state();
        let _cleanup = Cleanup(state.clone());

        let created = call(
            &state,
            "get_or_create_session",
            json!({ "projectName": "proj-a", "firstWindowName": "win-a" }),
        );
        assert_eq!(created["sessionName"].as_str(), Some("proj-a"));

        let exists = call(
            &state,
            "window_exists",
            json!({ "sessionName": "proj-a", "windowName": "win-a" }),
        );
        assert_eq!(exists["exists"].as_bool(), Some(true));

        let listed = call(&state, "list_windows", json!({ "sessionName": "proj-a" }));
        let windows = listed["windows"]
            .as_array()
            .expect("windows should be array");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["status"].as_str(), Some("idle"));

        let health = call(&state, "health", json!({}));
        assert_eq!(health["status"].as_str(), Some("ok"));
        assert_eq!(health["version"].as_u64(), Some(1));
        assert_eq!(health["sessions"].as_u64(), Some(1));
        assert_eq!(health["windows"].as_u64(), Some(1));
        assert_eq!(health["rpc"]["requestsTotal"].as_u64(), Some(0));
        assert_eq!(health["rpc"]["errorsTotal"].as_u64(), Some(0));
    }

    #[test]
    fn preserves_window_io_methods_through_pty_bus() {
        let state = new_shared_state();
        let _cleanup = Cleanup(state.clone());

        call(
            &state,
            "get_or_create_session",
            json!({ "projectName": "proj-b", "firstWindowName": "win-b" }),
        );

        call(
            &state,
            "start_window",
            json!({
                "sessionName": "proj-b",
                "windowName": "win-b",
                "command": "cat"
            }),
        );

        call(
            &state,
            "type_keys",
            json!({
                "sessionName": "proj-b",
                "windowName": "win-b",
                "keys": "hello-rpc"
            }),
        );
        call(
            &state,
            "send_enter",
            json!({ "sessionName": "proj-b", "windowName": "win-b" }),
        );

        let mut saw_echo = false;
        for _ in 0..40 {
            let buffer = call(
                &state,
                "get_window_buffer",
                json!({ "sessionName": "proj-b", "windowName": "win-b" }),
            );
            if buffer["buffer"]
                .as_str()
                .map(|text| text.contains("hello-rpc"))
                .unwrap_or(false)
            {
                saw_echo = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(saw_echo, "expected echoed input in window buffer");

        call(
            &state,
            "resize_window",
            json!({
                "sessionName": "proj-b",
                "windowName": "win-b",
                "cols": 100,
                "rows": 30
            }),
        );

        let frame = call(
            &state,
            "get_window_frame",
            json!({ "sessionName": "proj-b", "windowName": "win-b" }),
        );
        assert_eq!(frame["cols"].as_u64(), Some(100));
        assert_eq!(frame["rows"].as_u64(), Some(30));

        let stopped = call(
            &state,
            "stop_window",
            json!({ "sessionName": "proj-b", "windowName": "win-b" }),
        );
        assert_eq!(stopped["stopped"].as_bool(), Some(true));
    }
}
