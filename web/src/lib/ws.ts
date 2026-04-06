export interface JobEvent {
  type: string;
  stage?: string;
  progress?: number;
  message?: string;
  error?: string;
}

const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080/v1";

export function connectJobWS(
  jobId: string,
  onEvent: (event: JobEvent) => void
): () => void {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const url = `${WS_BASE}/ws/jobs/${jobId}${token ? `?token=${token}` : ""}`;

  const ws = new WebSocket(url);

  ws.onmessage = (msg) => {
    try {
      const event: JobEvent = JSON.parse(msg.data as string);
      onEvent(event);
    } catch {
      // ignore non-JSON messages
    }
  };

  ws.onerror = () => {
    // connection error — caller can reconnect if needed
  };

  return () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
}
