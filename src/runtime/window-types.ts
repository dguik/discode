export type RuntimeWindowStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export type RuntimeWindowSnapshot = {
  sessionName: string;
  windowName: string;
  status: RuntimeWindowStatus;
  pid?: number;
  startedAt?: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};
