export type RuntimeWindowRef = {
  sessionName: string;
  windowName: string;
};

export function parseRuntimeWindowId(windowId: string): RuntimeWindowRef | null {
  if (!windowId || typeof windowId !== 'string') return null;
  const idx = windowId.indexOf(':');
  if (idx <= 0 || idx >= windowId.length - 1) return null;

  const sessionName = windowId.slice(0, idx);
  const windowName = windowId.slice(idx + 1);
  if (!sessionName || !windowName) return null;

  return { sessionName, windowName };
}

export function toRuntimeWindowId(ref: RuntimeWindowRef): string {
  return `${ref.sessionName}:${ref.windowName}`;
}
