#[cfg(unix)]
mod grid_scrollback;

#[cfg(unix)]
mod pty_bus;

#[cfg(unix)]
mod renderer;

#[cfg(unix)]
mod rpc;

#[cfg(unix)]
mod screen;

#[cfg(unix)]
mod session_manager;

#[cfg(unix)]
mod terminal_pane;

#[cfg(unix)]
mod vt_lite;

#[cfg(not(unix))]
fn main() {
    eprintln!("discode-pty-sidecar currently supports unix domain sockets only");
    std::process::exit(1);
}

#[cfg(unix)]
mod unix_main {
    use crate::rpc::{
        handle_request, invalid_request, request_timeout, RpcError, RpcRequest, RpcResponse,
    };
    use crate::session_manager::{new_shared_state, record_rpc_observation};
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub fn main() {
        let args = std::env::args().collect::<Vec<_>>();
        if args.len() < 2 {
            eprintln!("usage: discode-pty-sidecar <server|request|client> ...");
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
                let id = parse_flag_u64(&args, "--id");
                let timeout_ms = parse_flag_u64(&args, "--timeout-ms");
                let params = parse_flag(&args, "--params")
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or_else(|| json!({}));
                let req = RpcRequest {
                    id,
                    method,
                    params,
                    timeout_ms,
                };

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
            "client" => {
                let socket = parse_flag(&args, "--socket").unwrap_or_else(|| {
                    eprintln!("missing --socket");
                    std::process::exit(1);
                });
                if let Err(err) = run_client(PathBuf::from(socket)) {
                    eprintln!("client error: {err}");
                    std::process::exit(1);
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

    fn parse_flag_u64(args: &[String], name: &str) -> Option<u64> {
        parse_flag(args, name).and_then(|raw| raw.parse::<u64>().ok())
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
        let state = new_shared_state();
        let running = Arc::new(AtomicBool::new(true));

        while running.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(tuple) => tuple,
                Err(err) => return Err(format!("accept failed: {err}")),
            };

            if let Err(err) = handle_connection(&mut stream, &state, &running) {
                let _ = write_response(
                    &mut stream,
                    &RpcResponse {
                        ok: false,
                        id: None,
                        result: None,
                        error: Some(RpcError::new("INTERNAL", err)),
                    },
                );
            }
        }

        let _ = fs::remove_file(&socket_path);
        Ok(())
    }

    fn write_response(stream: &mut UnixStream, response: &RpcResponse) -> Result<(), String> {
        let mut payload =
            serde_json::to_vec(response).map_err(|e| format!("encode response: {e}"))?;
        payload.push(b'\n');
        stream
            .write_all(&payload)
            .map_err(|e| format!("write response: {e}"))
    }

    fn handle_connection(
        stream: &mut UnixStream,
        state: &crate::session_manager::SharedSidecarState,
        running: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let reader_stream = stream
            .try_clone()
            .map_err(|e| format!("clone stream for read failed: {e}"))?;
        let mut reader = BufReader::new(reader_stream);

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            let mut raw = String::new();
            let read = reader
                .read_line(&mut raw)
                .map_err(|e| format!("failed to read request: {e}"))?;

            if read == 0 {
                break;
            }

            let req = match serde_json::from_str::<RpcRequest>(raw.trim()) {
                Ok(req) => req,
                Err(err) => {
                    let response = RpcResponse {
                        ok: false,
                        id: None,
                        result: None,
                        error: Some(invalid_request(format!("invalid request JSON: {err}"))),
                    };
                    write_response(stream, &response)?;
                    continue;
                }
            };

            let request_id = req.id;
            let timeout_ms = req.timeout_ms;
            let method_name = req.method.clone();
            let started_at = Instant::now();

            let mut should_shutdown = false;
            let mut response = match handle_request(state, req, &mut should_shutdown) {
                Ok(value) => RpcResponse {
                    ok: true,
                    id: request_id,
                    result: Some(value),
                    error: None,
                },
                Err(err) => RpcResponse {
                    ok: false,
                    id: request_id,
                    result: None,
                    error: Some(err),
                },
            };

            if let Some(limit_ms) = timeout_ms {
                let elapsed_ms = started_at.elapsed().as_millis();
                if elapsed_ms > u128::from(limit_ms) {
                    response = RpcResponse {
                        ok: false,
                        id: request_id,
                        result: None,
                        error: Some(request_timeout(&method_name, limit_ms, elapsed_ms)),
                    };
                }
            }

            let observed_latency_ms =
                started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            record_rpc_observation(
                state,
                &method_name,
                observed_latency_ms,
                response.error.as_ref().map(|error| error.code.as_str()),
            );

            write_response(stream, &response)?;
            if should_shutdown {
                running.store(false, Ordering::SeqCst);
                break;
            }
        }

        Ok(())
    }

    fn run_client(socket_path: PathBuf) -> Result<(), String> {
        let mut stream = UnixStream::connect(&socket_path)
            .map_err(|e| format!("connect {}: {e}", socket_path.display()))?;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(5000)));

        let reader_stream = stream
            .try_clone()
            .map_err(|e| format!("clone stream for client read failed: {e}"))?;
        let mut socket_reader = BufReader::new(reader_stream);

        let stdin = std::io::stdin();
        let mut stdin_reader = BufReader::new(stdin.lock());
        let mut stdout = std::io::stdout();

        loop {
            let mut inbound = String::new();
            let read = stdin_reader
                .read_line(&mut inbound)
                .map_err(|e| format!("read stdin failed: {e}"))?;
            if read == 0 {
                break;
            }

            if inbound.trim().is_empty() {
                continue;
            }

            stream
                .write_all(inbound.as_bytes())
                .map_err(|e| format!("write to sidecar failed: {e}"))?;

            let mut outbound = String::new();
            let received = socket_reader
                .read_line(&mut outbound)
                .map_err(|e| format!("read from sidecar failed: {e}"))?;
            if received == 0 {
                return Err("sidecar closed connection".to_string());
            }

            stdout
                .write_all(outbound.as_bytes())
                .map_err(|e| format!("write stdout failed: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("flush stdout failed: {e}"))?;
        }

        Ok(())
    }
}

#[cfg(unix)]
fn main() {
    unix_main::main();
}
