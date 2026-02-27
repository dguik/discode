import { PtyRuntime } from './pty-runtime.js';

export class PtyRustRuntime extends PtyRuntime {
  constructor() {
    super();
    console.warn('[runtime] pty-rust mode enabled (PoC); using TS fallback implementation');
  }
}
