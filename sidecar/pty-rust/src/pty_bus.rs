use crate::query_policy::build_terminal_response;
use crate::session_manager::{
    lock_state, lock_window, mark_output_mutation, transition_window_state, SharedSidecarState,
    SharedWindowState, WindowLifecycleState, WindowState,
};
use crate::terminal_pane::build_styled_frame;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn write_input(window: &mut WindowState, input: &[u8]) -> Result<(), String> {
    let writer = window
        .writer
        .as_mut()
        .ok_or_else(|| "window writer unavailable".to_string())?;
    writer
        .write_all(input)
        .map_err(|e| format!("write input failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))
}

pub fn resize_window(window: &mut WindowState, cols: u16, rows: u16) {
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
    mark_output_mutation(window);
}

pub fn stop_window(window: &mut WindowState) -> Result<bool, String> {
    if let Some(child) = window.child.as_mut() {
        if let Err(err) = child.kill() {
            if err.kind() != ErrorKind::NotFound {
                return Err(format!("kill failed: {err}"));
            }
        }
        transition_window_state(window, WindowLifecycleState::Exited, "stop-request")?;
        window.snapshot.exited_at = Some(now_unix_seconds());
        window.snapshot.signal = Some("SIGTERM".to_string());
        window.snapshot.exit_code = None;
        window.child = None;
        window.master = None;
        window.writer = None;
        return Ok(true);
    }

    if matches!(
        window.snapshot.status.as_str(),
        "running" | "starting" | "error"
    ) {
        transition_window_state(window, WindowLifecycleState::Exited, "stop-request")?;
        window.snapshot.exited_at = Some(now_unix_seconds());
    }
    Ok(true)
}

pub fn dispose_window(window: &mut WindowState) {
    if let Some(child) = window.child.as_mut() {
        let _ = child.kill();
    }
    window.child = None;
    window.writer = None;
    window.master = None;
    let _ = transition_window_state(window, WindowLifecycleState::Exited, "dispose");
    window.snapshot.exited_at = Some(now_unix_seconds());
}

pub fn spawn_window_process(
    state: &SharedSidecarState,
    window: &SharedWindowState,
    session_name: &str,
    lifecycle_generation: u64,
    command: String,
) -> Result<(), String> {
    let session_env = {
        let guard = lock_state(state);
        guard
            .sessions
            .get(session_name)
            .cloned()
            .unwrap_or_default()
    };

    let (cols, rows) = {
        let w = lock_window(window);
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
    let launch_env = build_window_launch_env(&session_env, cols, rows);
    for (k, v) in &launch_env {
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
        let mut w = lock_window(window);
        transition_window_state(&mut w, WindowLifecycleState::Running, "spawned")?;
        w.snapshot.pid = pid;
        w.master = Some(pair.master);
        w.child = Some(child);
        w.writer = Some(writer);
        w.launch_env = launch_env.into_iter().collect();
        w.query_carry.clear();
        w.private_modes.clear();
        w.buffer.push_str(&format!(
            "[runtime] process started (pid={})\n",
            pid.unwrap_or(0)
        ));
        mark_output_mutation(&mut w);
    }

    let max_buffer = {
        let guard = lock_state(state);
        guard.max_buffer_bytes
    };

    let read_window = window.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if let Ok(mut w) = read_window.lock() {
                        if w.lifecycle_generation != lifecycle_generation {
                            break;
                        }
                        if w.snapshot.status == "running" || w.snapshot.status == "starting" {
                            let mut exit_code = None;
                            if let Some(child) = w.child.as_mut() {
                                match child.try_wait() {
                                    Ok(Some(status)) => {
                                        exit_code = Some(status.exit_code() as i32);
                                    }
                                    Ok(None) => {
                                        if let Ok(status) = child.wait() {
                                            exit_code = Some(status.exit_code() as i32);
                                        }
                                    }
                                    Err(_) => {}
                                }
                            }

                            let _ = transition_window_state(
                                &mut w,
                                WindowLifecycleState::Exited,
                                "process-exit",
                            );
                            w.snapshot.exited_at = Some(now_unix_seconds());
                            w.snapshot.exit_code = exit_code;
                            w.child = None;
                            w.master = None;
                            w.writer = None;
                            w.buffer.push_str(&format!(
                                "[runtime] process exited (code={}, signal={})\n",
                                exit_code
                                    .map(|code| code.to_string())
                                    .unwrap_or_else(|| "null".to_string()),
                                "null"
                            ));
                        }
                    }
                    break;
                }
                Ok(n) => {
                    if let Ok(mut w) = read_window.lock() {
                        if w.lifecycle_generation != lifecycle_generation {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]);
                        w.buffer.push_str(&text);
                        if w.buffer.len() > max_buffer {
                            trim_buffer_to_max_bytes(&mut w.buffer, max_buffer);
                        }
                        mark_output_mutation(&mut w);

                        if text.contains('\x1b') {
                            let cols = w.snapshot.cols;
                            let rows = w.snapshot.rows;
                            let frame = build_styled_frame(&w.buffer, cols, rows);
                            let cursor_row = frame["cursorRow"].as_u64().unwrap_or(0) as usize;
                            let cursor_col = frame["cursorCol"].as_u64().unwrap_or(0) as usize;
                            let mut query_carry = std::mem::take(&mut w.query_carry);
                            let mut private_modes = std::mem::take(&mut w.private_modes);

                            let response = build_terminal_response(
                                &mut query_carry,
                                &mut private_modes,
                                &text,
                                cols,
                                rows,
                                cursor_row,
                                cursor_col,
                            );
                            w.query_carry = query_carry;
                            w.private_modes = private_modes;
                            if !response.is_empty() {
                                if let Some(writer) = w.writer.as_mut() {
                                    let _ = writer.write_all(response.as_bytes());
                                    let _ = writer.flush();
                                }
                            }
                        }
                    }
                }
                Err(_) => {
                    if let Ok(mut w) = read_window.lock() {
                        if w.lifecycle_generation != lifecycle_generation {
                            break;
                        }
                        let _ = transition_window_state(
                            &mut w,
                            WindowLifecycleState::Error,
                            "pty-read-error",
                        );
                        w.snapshot.exited_at = Some(now_unix_seconds());
                        w.child = None;
                        w.master = None;
                        w.writer = None;
                        w.buffer
                            .push_str("[runtime] process error: pty read failed\n");
                    }
                    break;
                }
            }
        }
    });

    Ok(())
}

fn trim_buffer_to_max_bytes(buffer: &mut String, max_bytes: usize) {
    if buffer.len() <= max_bytes {
        return;
    }

    let overflow = buffer.len() - max_bytes;
    let mut start = overflow;
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }

    buffer.drain(..start);
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn build_window_launch_env(
    session_env: &std::collections::HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> BTreeMap<String, String> {
    let mut merged = BTreeMap::new();

    for (k, v) in std::env::vars() {
        merged.insert(k, v);
    }
    for (k, v) in session_env {
        merged.insert(k.clone(), v.clone());
    }

    merged.insert(
        "TERM".to_string(),
        std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
    );
    merged.insert(
        "COLORTERM".to_string(),
        std::env::var("COLORTERM").unwrap_or_else(|_| "truecolor".to_string()),
    );
    merged.insert("COLUMNS".to_string(), cols.to_string());
    merged.insert("LINES".to_string(), rows.to_string());

    merged
}
