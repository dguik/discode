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
    use crate::rpc::{handle_request, RpcRequest, RpcResponse};
    use crate::session_manager::new_shared_state;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

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
        let state = new_shared_state();
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
}

#[cfg(unix)]
fn main() {
    unix_main::main();
}
