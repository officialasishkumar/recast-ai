/**
 * WebSocket client for per-job event streams.
 * Auto-reconnects with exponential backoff until the job is terminal.
 */

export interface JobEvent {
  type: string;
  stage?: string;
  progress?: number;
  message?: string;
  error?: string;
}

export interface JobWSOptions {
  /** Fired when the socket closes for any reason (including terminal stages). */
  onClose?: (ev: CloseEvent) => void;
  /** Fired when the underlying connection errors. */
  onError?: () => void;
  /** Hook before each reconnect attempt (1-indexed). */
  onReconnect?: (attempt: number) => void;
}

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080/v1";
const MAX_ATTEMPTS = 5;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * Open a WS to /ws/jobs/:id. Reconnects with exponential backoff up to 5 times.
 * Returns a cleanup function that tears the socket down and blocks reconnects.
 */
export function connectJobWS(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  opts: JobWSOptions = {}
): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStage = "";

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const url = `${WS_BASE}/ws/jobs/${jobId}${token ? `?token=${token}` : ""}`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as JobEvent;
        if (event.stage) lastStage = event.stage;
        onEvent(event);
      } catch {
        /* ignore non-JSON messages */
      }
    };

    ws.onerror = () => {
      opts.onError?.();
    };

    ws.onclose = (ev) => {
      opts.onClose?.(ev);
      if (closed) return;
      if (TERMINAL.has(lastStage)) return;
      if (attempt >= MAX_ATTEMPTS) return;
      attempt += 1;
      opts.onReconnect?.(attempt);
      const delay = Math.min(30_000, 500 * Math.pow(2, attempt - 1));
      reconnectTimer = setTimeout(open, delay);
    };
  };

  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close();
    }
  };
}
