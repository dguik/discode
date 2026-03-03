# discode PTY Rust sidecar

This crate provides the `pty-rust` runtime sidecar.

## What it does

- Runs a single binary (`discode-pty-sidecar`) in `server` mode
- Accepts request/response RPC over a unix domain socket
- Manages PTY windows with `portable-pty`
- Returns a text-based frame payload compatible with `TerminalStyledFrame`

Current support target for `pty-rust`: macOS/Linux.

## Build

```bash
cd sidecar/pty-rust
cargo build --release
```

Binary path:

`sidecar/pty-rust/target/release/discode-pty-sidecar`

## Package host binary (release artifact)

```bash
npm run sidecar:package
```

Output path shape:

`dist/release/sidecar/discode-pty-sidecar-<os>-<arch>/bin/discode-pty-sidecar`

Runtime binary discovery order:

1. explicit option (`sidecarBinary`)
2. `DISCODE_PTY_RUST_SIDECAR_BIN`
3. local build output (`sidecar/pty-rust/target/release/...`)
4. packaged release output (`dist/release/sidecar/discode-pty-sidecar-<os>-<arch>/bin/...`)
5. home install paths (`~/.discode/bin/...`)

Runtime regression suite (Node side):

```bash
npm run test:runtime:pty-rust
```

## Local wiring

Set runtime mode + sidecar binary path:

```bash
discode config --runtime-mode pty-rust
export DISCODE_PTY_RUST_SIDECAR_BIN="/absolute/path/to/sidecar/pty-rust/target/release/discode-pty-sidecar"
```

`pty-rust` runtime requires a working sidecar connection.
