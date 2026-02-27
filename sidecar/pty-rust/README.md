# discode PTY Rust sidecar (PoC)

This crate is a Phase 4 PoC runtime sidecar.

## What it does

- Runs a single binary (`discode-pty-sidecar`) in `server` mode
- Accepts request/response RPC over a unix domain socket
- Manages PTY windows with `portable-pty`
- Returns a text-based frame payload compatible with `TerminalStyledFrame`

## Build

```bash
cd sidecar/pty-rust
cargo build --release
```

Binary path:

`sidecar/pty-rust/target/release/discode-pty-sidecar`

## Local wiring

Set runtime mode + sidecar binary path:

```bash
discode config --runtime-mode pty-rust
export DISCODE_PTY_RUST_SIDECAR_BIN="/absolute/path/to/sidecar/pty-rust/target/release/discode-pty-sidecar"
```

If sidecar startup fails, runtime falls back to TS `PtyRuntime` automatically.
