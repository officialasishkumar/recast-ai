/**
 * API client for Recast AI.
 * Wraps every call in a typed http helper that normalizes auth and errors.
 */

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
  role: "user" | "admin";
  avatar_url?: string;
  created_at: string;
  updated_at: string;
}

export type JobStage =
  | "pending"
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
  voice_id?: string;
  language?: string;
  style?: string;
  output_url?: string;
  video_url?: string;
  share_token?: string | null;
  thumbnail_path?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface TranscriptSegment {
  id: string;
  job_id: string;
  segment_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  words_json: TranscriptWord[];
  confidence: number;
  audio_path: string;
  approved: boolean;
  flagged: boolean;
}

export interface Transcript {
  job_id: string;
  segments: TranscriptSegment[];
}

export interface Voice {
  id: string;
  name: string;
  gender: string;
  accent: string;
  provider: string;
  sample_url: string;
}

export interface PublicShare {
  job: Job;
  transcript: TranscriptSegment[];
  output_url: string;
  thumbnail_url?: string | null;
}

export interface UploadInitResponse {
  upload_id: string;
  chunk_size?: number;
}

export interface UploadParams {
  voice_id: string;
  style: string;
  language: string;
  name: string;
}

export interface ShareResponse {
  token: string;
  url: string;
}

export interface PreferencesPayload {
  name?: string;
  avatar_url?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  ApiError                                                           */
/* ------------------------------------------------------------------ */

/**
 * Typed error thrown by http<T> for non-2xx responses.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Return the stored auth token, or null on the server. */
function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

/** Build the Authorization header when a token is present. */
function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

interface HttpOptions extends RequestInit {
  /** Skip the 401 auto-redirect and auth header (for public endpoints). */
  publicCall?: boolean;
}

/**
 * Core fetch wrapper. Throws ApiError on non-2xx; handles 401 via redirect.
 */
async function http<T>(path: string, init: HttpOptions = {}): Promise<T> {
  const { publicCall, ...rest } = init;
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    ...(publicCall ? {} : authHeaders()),
    ...(rest.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, { ...rest, headers });

  if (res.status === 401 && !publicCall) {
    if (typeof window !== "undefined") {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }

  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed: ${res.status}`;
    try {
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        error?: string;
      };
      code = body.code || code;
      message = body.message || body.error || message;
    } catch {
      /* body is not JSON */
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as unknown as T;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return undefined as unknown as T;
  }
  const body = (await res.json()) as { data?: T } & Record<string, unknown>;
  if (body && typeof body === "object" && "data" in body && body.data !== undefined) {
    return body.data as T;
  }
  return body as unknown as T;
}

/* ------------------------------------------------------------------ */
/*  Auth                                                               */
/* ------------------------------------------------------------------ */

/** Exchange credentials for a token and a User. */
export async function login(
  email: string,
  password: string
): Promise<AuthResponse> {
  return http<AuthResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

/** Create a new account, returning a token and the fresh User. */
export async function register(
  email: string,
  password: string,
  name: string
): Promise<AuthResponse> {
  return http<AuthResponse>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
}

/** Invalidate the current session on the server, then clear the local token. */
export async function logout(): Promise<void> {
  try {
    await http<void>("/auth/logout", { method: "POST" });
  } catch {
    /* best effort */
  }
  if (typeof window !== "undefined") {
    localStorage.removeItem("token");
  }
}

/** Rotate the current token, returning a new AuthResponse. */
export async function refresh(): Promise<AuthResponse> {
  return http<AuthResponse>("/auth/refresh", { method: "POST" });
}

/** Fetch the currently authenticated user. */
export async function getMe(): Promise<User> {
  return http<User>("/auth/me");
}

/** Patch user preferences; falls back to localStorage on 404. */
export async function updatePreferences(
  payload: PreferencesPayload
): Promise<User | null> {
  try {
    return await http<User>("/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      if (typeof window !== "undefined") {
        localStorage.setItem("preferences", JSON.stringify(payload));
      }
      return null;
    }
    throw err;
  }
}

/** Delete the account; falls back to clearing tokens + redirect on 404. */
export async function deleteAccount(): Promise<void> {
  try {
    await http<void>("/auth/me", { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      throw err;
    }
  } finally {
    if (typeof window !== "undefined") {
      localStorage.removeItem("token");
      localStorage.removeItem("preferences");
      window.location.href = "/";
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Jobs                                                               */
/* ------------------------------------------------------------------ */

/** List the current user's jobs. */
export async function getJobs(): Promise<Job[]> {
  const res = await http<{ jobs: Job[] } | Job[]>("/jobs");
  return Array.isArray(res) ? res : (res?.jobs ?? []);
}

/** Fetch a single job by id. */
export async function getJob(id: string): Promise<Job> {
  return http<Job>(`/jobs/${id}`);
}

/** Delete a job and all its artifacts. */
export async function deleteJob(jobId: string): Promise<void> {
  return http<void>(`/jobs/${jobId}`, { method: "DELETE" });
}

/** Build a signed URL to the thumbnail without any async round-trip. */
export function getThumbnailUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/thumbnail`;
}

/** Trigger an export and receive a signed download URL. */
export async function exportJob(jobId: string): Promise<{ url: string }> {
  return http<{ url: string }>(`/jobs/${jobId}/export`, { method: "POST" });
}

/** Request re-synthesis of a single segment. */
export async function regenerateSegment(
  jobId: string,
  segmentId: string
): Promise<void> {
  return http<void>(`/jobs/${jobId}/segments/${segmentId}/regenerate`, {
    method: "POST",
  });
}

/** Publish a job and return its public URL. */
export async function shareJob(jobId: string): Promise<ShareResponse> {
  return http<ShareResponse>(`/jobs/${jobId}/share`, { method: "POST" });
}

/** Revoke the public share token for a job. */
export async function unshareJob(jobId: string): Promise<void> {
  return http<void>(`/jobs/${jobId}/share`, { method: "DELETE" });
}

/** Fetch a public share without auth headers. */
export async function getPublicShare(token: string): Promise<PublicShare> {
  return http<PublicShare>(`/public/shares/${token}`, { publicCall: true });
}

/* ------------------------------------------------------------------ */
/*  Chunked upload                                                     */
/* ------------------------------------------------------------------ */

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB

/**
 * Upload the file in 8MB chunks with XHR progress reporting.
 * Resolves when every chunk has been accepted.
 */
export async function uploadChunks(
  file: File,
  params: UploadParams,
  onProgress?: (pct: number) => void
): Promise<UploadInitResponse> {
  const init = await http<UploadInitResponse>("/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      mime_type: file.type,
      ...params,
    }),
  });

  const uploadId = init.upload_id;
  const chunkSize = init.chunk_size || CHUNK_SIZE;
  const total = Math.ceil(file.size / chunkSize);
  let uploadedBytes = 0;

  for (let idx = 0; idx < total; idx++) {
    const start = idx * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    await uploadChunkXhr(uploadId, idx, total, blob, (loaded) => {
      const pct = Math.min(
        100,
        Math.round(((uploadedBytes + loaded) / file.size) * 100)
      );
      onProgress?.(pct);
    });
    uploadedBytes += blob.size;
  }

  onProgress?.(100);
  return init;
}

/** XHR-backed chunk POST so we can surface per-chunk progress. */
function uploadChunkXhr(
  uploadId: string,
  idx: number,
  total: number,
  blob: Blob,
  onLoaded: (loaded: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${API_BASE}/upload/chunk?upload_id=${encodeURIComponent(
      uploadId
    )}&index=${idx}&total=${total}`;
    xhr.open("POST", url);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onLoaded(ev.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new ApiError(
            xhr.status,
            "chunk_failed",
            `Chunk ${idx} upload failed: ${xhr.status}`
          )
        );
      }
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "network_error", "Network error during chunk upload"));
    xhr.send(blob);
  });
}

/** Finalize a chunked upload and kick off the job. */
export async function completeUpload(
  uploadId: string,
  params: UploadParams
): Promise<Job> {
  return http<Job>("/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId, ...params }),
  });
}

/* ------------------------------------------------------------------ */
/*  Transcripts                                                        */
/* ------------------------------------------------------------------ */

/** Fetch the transcript for a job. */
export async function getTranscript(jobId: string): Promise<Transcript> {
  return http<Transcript>(`/jobs/${jobId}/transcript`);
}

/** Replace the transcript segments for a job. */
export async function updateTranscript(
  jobId: string,
  segments: TranscriptSegment[]
): Promise<Transcript> {
  return http<Transcript>(`/jobs/${jobId}/transcript`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments }),
  });
}

/* ------------------------------------------------------------------ */
/*  Voices                                                             */
/* ------------------------------------------------------------------ */

/** List all available voices. */
export async function getVoices(): Promise<Voice[]> {
  const res = await http<{ voices: Voice[] } | Voice[]>("/voices");
  return Array.isArray(res) ? res : (res?.voices ?? []);
}

/**
 * Fetch a 10-second preview clip for a voice. Returns a blob URL.
 * Falls back to a short silence blob so the UI never crashes.
 */
export async function previewVoice(
  voiceId: string,
  text: string
): Promise<string> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/voices/${voiceId}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new ApiError(res.status, "preview_failed", "Preview failed");
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return URL.createObjectURL(silenceBlob());
  }
}

/** 0.5-second silent WAV, used when preview endpoint is unavailable. */
function silenceBlob(): Blob {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * 0.5);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}
