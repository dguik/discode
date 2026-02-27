#[cfg(unix)]
mod vt_lite;

#[cfg(not(unix))]
fn main() {
    eprintln!("discode-pty-sidecar currently supports unix domain sockets only");
    std::process::exit(1);
}

#[cfg(unix)]
mod unix_main {
    use crate::vt_lite::build_styled_frame;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Deserialize)]
    struct RpcRequest {
        method: String,
        #[serde(default)]
        params: Value,
    }

    #[derive(Serialize)]
    struct RpcResponse {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    #[derive(Clone)]
    struct WindowSnapshot {
        session_name: String,
        window_name: String,
        status: String,
        pid: Option<u32>,
        started_at: Option<i64>,
        exited_at: Option<i64>,
        exit_code: Option<i32>,
        signal: Option<String>,
        cols: u16,
        rows: u16,
    }

    struct WindowState {
        snapshot: WindowSnapshot,
        buffer: String,
        writer: Option<Box<dyn Write + Send>>,
        master: Option<Box<dyn portable_pty::MasterPty + Send>>,
        child: Option<Box<dyn portable_pty::Child + Send>>,
    }

    struct SidecarState {
        sessions: HashMap<String, HashMap<String, String>>,
        windows: HashMap<String, Arc<Mutex<WindowState>>>,
        max_buffer_bytes: usize,
    }

    impl SidecarState {
        fn new() -> Self {
            Self {
                sessions: HashMap::new(),
                windows: HashMap::new(),
                max_buffer_bytes: 512 * 1024,
            }
        }
    }

    pub fn main() {
        let args = std::env::args().collect::<Vec<_>>();
        if args.len() < 2 {
            eprintln!("usage: discode-pty-sidecar <server|request> ...");
            std::process::exit(1);
        }

        match args[1].as_str() {
            "server" => {
                let socket = parse_flag(&args, "--socket").unwrap_or_else(|| {
                    eprintln!("missing --socket");
                    std::process::exit(1);
                });
                if let Err(err) = run_server(PathBuf::from(socket)) {
                    eprintln!("server error: {err}");
                    std::process::exit(1);
                }
            }
            "request" => {
                let socket = parse_flag(&args, "--socket").unwrap_or_else(|| {
                    eprintln!("missing --socket");
                    std::process::exit(1);
                });
                let method = parse_flag(&args, "--method").unwrap_or_else(|| {
                    eprintln!("missing --method");
                    std::process::exit(1);
                });
                let params = parse_flag(&args, "--params")
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or_else(|| json!({}));
                let req = RpcRequest { method, params };

                match send_request(Path::new(&socket), &req) {
                    Ok(value) => {
                        print!("{value}");
                    }
                    Err(err) => {
                        eprintln!("request error: {err}");
                        std::process::exit(1);
                    }
                }
            }
            _ => {
                eprintln!("unknown command: {}", args[1]);
                std::process::exit(1);
            }
        }
    }

    fn parse_flag(args: &[String], name: &str) -> Option<String> {
        let idx = args.iter().position(|it| it == name)?;
        args.get(idx + 1).cloned()
    }

    fn send_request(socket_path: &Path, req: &RpcRequest) -> Result<String, String> {
        let mut stream = UnixStream::connect(socket_path)
            .map_err(|e| format!("connect {}: {e}", socket_path.display()))?;

        let payload = serde_json::to_vec(req).map_err(|e| format!("encode request: {e}"))?;
        stream
            .write_all(&payload)
            .map_err(|e| format!("write request: {e}"))?;
        let _ = stream.shutdown(std::net::Shutdown::Write);

        let mut out = String::new();
        stream
            .read_to_string(&mut out)
            .map_err(|e| format!("read response: {e}"))?;
        Ok(out)
    }

    fn run_server(socket_path: PathBuf) -> Result<(), String> {
        if socket_path.exists() {
            let _ = fs::remove_file(&socket_path);
        }
        if let Some(parent) = socket_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create socket parent {}: {e}", parent.display()))?;
        }

        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("bind {}: {e}", socket_path.display()))?;
        let state = Arc::new(Mutex::new(SidecarState::new()));
        let running = Arc::new(AtomicBool::new(true));

        while running.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(tuple) => tuple,
                Err(err) => return Err(format!("accept failed: {err}")),
            };

            let mut raw = String::new();
            if let Err(err) = stream.read_to_string(&mut raw) {
                let _ = write_response(
                    &mut stream,
                    &RpcResponse {
                        ok: false,
                        result: None,
                        error: Some(format!("failed to read request: {err}")),
                    },
                );
                continue;
            }

            let req = match serde_json::from_str::<RpcRequest>(&raw) {
                Ok(req) => req,
                Err(err) => {
                    let _ = write_response(
                        &mut stream,
                        &RpcResponse {
                            ok: false,
                            result: None,
                            error: Some(format!("invalid request JSON: {err}")),
                        },
                    );
                    continue;
                }
            };

            let mut should_shutdown = false;
            let response = match handle_request(&state, req, &mut should_shutdown) {
                Ok(value) => RpcResponse {
                    ok: true,
                    result: Some(value),
                    error: None,
                },
                Err(err) => RpcResponse {
                    ok: false,
                    result: None,
                    error: Some(err),
                },
            };

            let _ = write_response(&mut stream, &response);
            if should_shutdown {
                running.store(false, Ordering::SeqCst);
            }
        }

        let _ = fs::remove_file(&socket_path);
        Ok(())
    }

    fn write_response(stream: &mut UnixStream, response: &RpcResponse) -> Result<(), String> {
        let payload = serde_json::to_vec(response).map_err(|e| format!("encode response: {e}"))?;
        stream
            .write_all(&payload)
            .map_err(|e| format!("write response: {e}"))
    }

    fn handle_request(
        state: &Arc<Mutex<SidecarState>>,
        req: RpcRequest,
        should_shutdown: &mut bool,
    ) -> Result<Value, String> {
        match req.method.as_str() {
            "hello" => Ok(json!({ "version": 1 })),
            "get_or_create_session" => {
                let project_name = get_str(&req.params, "projectName")?;
                let first_window_name = get_opt_str(&req.params, "firstWindowName");

                let mut guard = state
                    .lock()
                    .map_err(|_| "state lock poisoned".to_string())?;
                guard
                    .sessions
                    .entry(project_name.clone())
                    .or_insert_with(HashMap::new);

                if let Some(window_name) = first_window_name {
                    let key = window_key(&project_name, &window_name);
                    guard.windows.entry(key).or_insert_with(|| {
                        Arc::new(Mutex::new(WindowState {
                            snapshot: WindowSnapshot {
                                session_name: project_name.clone(),
                                window_name,
                                status: "idle".to_string(),
                                pid: None,
                                started_at: None,
                                exited_at: None,
                                exit_code: None,
                                signal: None,
                                cols: 140,
                                rows: 40,
                            },
                            buffer: String::new(),
                            writer: None,
                            master: None,
                            child: None,
                        }))
                    });
                }

                Ok(json!({ "sessionName": project_name }))
            }
            "set_session_env" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let key = get_str(&req.params, "key")?;
                let value = get_str(&req.params, "value")?;

                let mut guard = state
                    .lock()
                    .map_err(|_| "state lock poisoned".to_string())?;
                let env = guard
                    .sessions
                    .entry(session_name)
                    .or_insert_with(HashMap::new);
                env.insert(key, value);
                Ok(json!({ "ok": true }))
            }
            "window_exists" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;
                let key = window_key(&session_name, &window_name);

                let guard = state
                    .lock()
                    .map_err(|_| "state lock poisoned".to_string())?;
                Ok(json!({ "exists": guard.windows.contains_key(&key) }))
            }
            "start_window" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;
                let command = get_str(&req.params, "command")?;

                start_window(state, session_name, window_name, command)?;
                Ok(json!({ "ok": true }))
            }
            "type_keys" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;
                let keys = get_str(&req.params, "keys")?;
                with_window(state, &session_name, &window_name, |window| {
                    let writer = window
                        .writer
                        .as_mut()
                        .ok_or_else(|| "window writer unavailable".to_string())?;
                    writer
                        .write_all(keys.as_bytes())
                        .map_err(|e| format!("write keys failed: {e}"))?;
                    writer.flush().map_err(|e| format!("flush failed: {e}"))?;
                    Ok(())
                })?;
                Ok(json!({ "ok": true }))
            }
            "send_enter" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;
                with_window(state, &session_name, &window_name, |window| {
                    let writer = window
                        .writer
                        .as_mut()
                        .ok_or_else(|| "window writer unavailable".to_string())?;
                    writer
                        .write_all(b"\r")
                        .map_err(|e| format!("write enter failed: {e}"))?;
                    writer.flush().map_err(|e| format!("flush failed: {e}"))?;
                    Ok(())
                })?;
                Ok(json!({ "ok": true }))
            }
            "resize_window" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;
                let cols = get_u16(&req.params, "cols", 140);
                let rows = get_u16(&req.params, "rows", 40);

                with_window(state, &session_name, &window_name, |window| {
                    if let Some(master) = window.master.as_mut() {
                        let _ = master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    window.snapshot.cols = cols;
                    window.snapshot.rows = rows;
                    Ok(())
                })?;
                Ok(json!({ "ok": true }))
            }
            "list_windows" => {
                let session_filter = get_opt_str(&req.params, "sessionName");
                let windows = {
                    let guard = state
                        .lock()
                        .map_err(|_| "state lock poisoned".to_string())?;
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
                })?;
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
                })?;
                Ok(frame)
            }
            "stop_window" => {
                let session_name = get_str(&req.params, "sessionName")?;
                let window_name = get_str(&req.params, "windowName")?;

                let stopped = with_window(state, &session_name, &window_name, |window| {
                    if let Some(child) = window.child.as_mut() {
                        child.kill().map_err(|e| format!("kill failed: {e}"))?;
                        window.snapshot.status = "exited".to_string();
                        window.snapshot.exited_at = Some(now_unix_seconds());
                        window.snapshot.signal = Some("SIGTERM".to_string());
                        window.child = None;
                        window.master = None;
                        window.writer = None;
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                })?;

                Ok(json!({ "stopped": stopped }))
            }
            "dispose" => {
                let windows = {
                    let guard = state
                        .lock()
                        .map_err(|_| "state lock poisoned".to_string())?;
                    guard.windows.values().cloned().collect::<Vec<_>>()
                };

                for window in windows {
                    if let Ok(mut window) = window.lock() {
                        if let Some(child) = window.child.as_mut() {
                            let _ = child.kill();
                        }
                        window.child = None;
                        window.writer = None;
                        window.master = None;
                        window.snapshot.status = "exited".to_string();
                        window.snapshot.exited_at = Some(now_unix_seconds());
                    }
                }

                *should_shutdown = true;
                Ok(json!({ "ok": true }))
            }
            _ => Err(format!("unknown method: {}", req.method)),
        }
    }

    fn get_str(params: &Value, key: &str) -> Result<String, String> {
        params
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .ok_or_else(|| format!("missing or invalid '{key}'"))
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

    fn window_key(session_name: &str, window_name: &str) -> String {
        format!("{session_name}:{window_name}")
    }

    fn with_window<T>(
        state: &Arc<Mutex<SidecarState>>,
        session_name: &str,
        window_name: &str,
        mut f: impl FnMut(&mut WindowState) -> Result<T, String>,
    ) -> Result<T, String> {
        let key = window_key(session_name, window_name);
        let window = {
            let guard = state
                .lock()
                .map_err(|_| "state lock poisoned".to_string())?;
            guard
                .windows
                .get(&key)
                .cloned()
                .ok_or_else(|| format!("window not found: {key}"))?
        };
        let mut guard = window
            .lock()
            .map_err(|_| "window lock poisoned".to_string())?;
        f(&mut guard)
    }

    fn start_window(
        state: &Arc<Mutex<SidecarState>>,
        session_name: String,
        window_name: String,
        command: String,
    ) -> Result<(), String> {
        let key = window_key(&session_name, &window_name);
        let env = {
            let guard = state
                .lock()
                .map_err(|_| "state lock poisoned".to_string())?;
            guard
                .sessions
                .get(&session_name)
                .cloned()
                .unwrap_or_default()
        };

        let window = {
            let mut guard = state
                .lock()
                .map_err(|_| "state lock poisoned".to_string())?;
            guard
                .windows
                .entry(key)
                .or_insert_with(|| {
                    Arc::new(Mutex::new(WindowState {
                        snapshot: WindowSnapshot {
                            session_name: session_name.clone(),
                            window_name: window_name.clone(),
                            status: "idle".to_string(),
                            pid: None,
                            started_at: None,
                            exited_at: None,
                            exit_code: None,
                            signal: None,
                            cols: 140,
                            rows: 40,
                        },
                        buffer: String::new(),
                        writer: None,
                        master: None,
                        child: None,
                    }))
                })
                .clone()
        };

        let (cols, rows) = {
            let mut w = window
                .lock()
                .map_err(|_| "window lock poisoned".to_string())?;
            if w.child.is_some() && w.snapshot.status == "running" {
                return Ok(());
            }
            w.snapshot.status = "starting".to_string();
            w.snapshot.started_at = Some(now_unix_seconds());
            w.snapshot.exited_at = None;
            w.snapshot.exit_code = None;
            w.snapshot.signal = None;
            w.buffer.clear();
            (w.snapshot.cols, w.snapshot.rows)
        };

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-lc");
        cmd.arg(command);
        cmd.cwd(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        cmd.env(
            "TERM",
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
        );
        cmd.env(
            "COLORTERM",
            std::env::var("COLORTERM").unwrap_or_else(|_| "truecolor".to_string()),
        );
        cmd.env("COLUMNS", cols.to_string());
        cmd.env("LINES", rows.to_string());
        for (k, v) in env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer failed: {e}"))?;

        {
            let mut w = window
                .lock()
                .map_err(|_| "window lock poisoned".to_string())?;
            w.snapshot.status = "running".to_string();
            w.snapshot.pid = pid;
            w.master = Some(pair.master);
            w.child = Some(child);
            w.writer = Some(writer);
            w.buffer.push_str(&format!(
                "[runtime] process started (pid={})\n",
                pid.unwrap_or(0)
            ));
        }

        let max_buffer = {
            let guard = state
                .lock()
                .map_err(|_| "state lock poisoned".to_string())?;
            guard.max_buffer_bytes
        };

        let read_window = window.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        if let Ok(mut w) = read_window.lock() {
                            if w.snapshot.status == "running" || w.snapshot.status == "starting" {
                                w.snapshot.status = "exited".to_string();
                                w.snapshot.exited_at = Some(now_unix_seconds());
                            }
                        }
                        break;
                    }
                    Ok(n) => {
                        if let Ok(mut w) = read_window.lock() {
                            let text = String::from_utf8_lossy(&buf[..n]);
                            w.buffer.push_str(&text);
                            if w.buffer.len() > max_buffer {
                                let keep = w.buffer.len() - max_buffer;
                                w.buffer = w.buffer[keep..].to_string();
                            }
                        }
                    }
                    Err(_) => {
                        if let Ok(mut w) = read_window.lock() {
                            w.snapshot.status = "error".to_string();
                            w.snapshot.exited_at = Some(now_unix_seconds());
                        }
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    fn now_unix_seconds() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default()
    }
}

#[cfg(unix)]
fn main() {
    unix_main::main();
}
