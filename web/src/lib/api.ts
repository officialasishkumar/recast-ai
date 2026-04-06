const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AuthResponse {
  token: string;
  user: User;
}

export interface User {
  id: string;
  email: string;
  name: string;
  plan: "free" | "pro";
  minutes_used: number;
  minutes_quota: number;
}

export type JobStage =
  | "uploaded"
  | "analyzing"
  | "transcribed"
  | "synthesizing"
  | "muxing"
  | "completed"
  | "failed";

export interface Job {
  id: string;
  name: string;
  status: JobStage;
  duration: number;
  created_at: string;
  updated_at: string;
  video_url?: string;
  output_url?: string;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
  flagged: boolean;
}

export interface Transcript {
  job_id: string;
  segments: TranscriptSegment[];
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  preview_url: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).message ||
        `Request failed: ${res.status}`
    );
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Auth                                                               */
/* ------------------------------------------------------------------ */

export async function login(
  email: string,
  password: string
): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export async function register(
  email: string,
  password: string,
  name: string
): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
}

/* ------------------------------------------------------------------ */
/*  Jobs                                                               */
/* ------------------------------------------------------------------ */

export async function getJobs(): Promise<Job[]> {
  return request<Job[]>("/jobs");
}

export async function getJob(id: string): Promise<Job> {
  return request<Job>(`/jobs/${id}`);
}

export async function createJob(formData: FormData): Promise<Job> {
  return request<Job>("/jobs", {
    method: "POST",
    body: formData,
  });
}

export async function deleteJob(jobId: string): Promise<void> {
  return request<void>(`/jobs/${jobId}`, { method: "DELETE" });
}

export async function exportJob(jobId: string): Promise<{ url: string }> {
  return request<{ url: string }>(`/jobs/${jobId}/export`, {
    method: "POST",
  });
}

/* ------------------------------------------------------------------ */
/*  Transcripts                                                        */
/* ------------------------------------------------------------------ */

export async function getTranscript(jobId: string): Promise<Transcript> {
  return request<Transcript>(`/jobs/${jobId}/transcript`);
}

export async function updateTranscript(
  jobId: string,
  segments: TranscriptSegment[]
): Promise<Transcript> {
  return request<Transcript>(`/jobs/${jobId}/transcript`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments }),
  });
}

/* ------------------------------------------------------------------ */
/*  Voices                                                             */
/* ------------------------------------------------------------------ */

export async function getVoices(): Promise<Voice[]> {
  return request<Voice[]>("/voices");
}
