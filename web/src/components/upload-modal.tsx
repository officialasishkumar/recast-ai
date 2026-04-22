"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileVideo,
  Loader2,
  Mic2,
  Pause,
  Play,
  Upload as UploadIcon,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  createJob,
  getVoices,
  type Voice as ApiVoice,
} from "@/lib/api";

type ExtendedVoice = ApiVoice & {
  gender?: string;
  accent?: string;
  provider?: string;
  sample_url?: string;
};

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

type Step = 0 | 1 | 2;

type StyleOption = "formal" | "casual";

const ACCEPT_EXTENSIONS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
const ACCEPT_MIME = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/x-matroska",
];
const ACCEPT_ATTR = [...ACCEPT_EXTENSIONS, ...ACCEPT_MIME].join(",");

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
  { value: "hi", label: "Hindi" },
  { value: "pt", label: "Portuguese" },
  { value: "zh", label: "Chinese" },
  { value: "it", label: "Italian" },
  { value: "ko", label: "Korean" },
];

const SAMPLE_PREVIEW_TEXT =
  "Here is how your narration will sound with this voice.";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSeconds(sec: number | null): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "–:––";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (ACCEPT_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  if (file.type && file.type.startsWith("video/")) return true;
  return false;
}

async function captureFirstFrame(file: File): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<string | null>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = objectUrl;
      const cleanup = () => {
        video.removeAttribute("src");
        video.load();
      };
      video.onloadeddata = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            cleanup();
            resolve(null);
            return;
          }
          // Seek slightly into the video so we don't get a blank frame.
          const target = Math.min(0.1, (video.duration || 1) * 0.05);
          video.currentTime = target;
          const onSeeked = () => {
            try {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL("image/jpeg", 0.75));
            } catch {
              resolve(null);
            } finally {
              cleanup();
            }
          };
          video.onseeked = onSeeked;
        } catch {
          cleanup();
          resolve(null);
        }
      };
      video.onerror = () => {
        cleanup();
        resolve(null);
      };
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function readMetadata(file: File): Promise<number | null> {
  if (typeof window === "undefined") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = objectUrl;
      video.onloadedmetadata = () => {
        const d = video.duration;
        resolve(Number.isFinite(d) ? d : null);
      };
      video.onerror = () => resolve(null);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

interface LibApiShape {
  uploadChunks?: (
    file: File,
    onProgress: (pct: number) => void
  ) => Promise<{ upload_id: string }>;
  completeUpload?: (
    uploadId: string,
    params: { voice_id: string; style: string; language: string; name?: string }
  ) => Promise<unknown>;
  previewVoice?: (voiceId: string, sampleText: string) => Promise<{ url: string }>;
}

async function getApi(): Promise<LibApiShape> {
  return (await import("@/lib/api")) as unknown as LibApiShape;
}

export function UploadModal({ open, onClose, onCreated }: UploadModalProps) {
  const [step, setStep] = useState<Step>(0);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [voices, setVoices] = useState<ExtendedVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceId, setVoiceId] = useState<string>("");
  const [style, setStyle] = useState<StyleOption>("formal");
  const [language, setLanguage] = useState("en");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [languageOpen, setLanguageOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId) ?? null,
    [voices, voiceId]
  );

  const resetState = useCallback(() => {
    setStep(0);
    setFile(null);
    setDuration(null);
    setThumbnail(null);
    setDragOver(false);
    setVoiceId("");
    setStyle("formal");
    setLanguage("en");
    setPreviewUrl(null);
    setPreviewPlaying(false);
    setPreviewLoading(false);
    setUploading(false);
    setProgress(0);
    setError(null);
    setLanguageOpen(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, []);

  // Fetch voices when opening.
  useEffect(() => {
    if (!open) return;
    setVoicesLoading(true);
    getVoices()
      .then((list) => {
        const v = list as ExtendedVoice[];
        setVoices(v);
        if (v.length > 0 && !voiceId) setVoiceId(v[0].id);
      })
      .catch(() => setVoices([]))
      .finally(() => setVoicesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus close button on open (focus trap entry point).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 10);
    return () => window.clearTimeout(t);
  }, [open]);

  // Body scroll lock + Esc / Tab trap.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
        );
        const list = Array.from(focusables).filter(
          (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1
        );
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When file changes, probe metadata and first-frame.
  useEffect(() => {
    if (!file) {
      setDuration(null);
      setThumbnail(null);
      return;
    }
    let cancelled = false;
    readMetadata(file).then((d) => {
      if (!cancelled) setDuration(d);
    });
    captureFirstFrame(file).then((t) => {
      if (!cancelled) setThumbnail(t);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Close inline audio when voice or url changes.
  useEffect(() => {
    setPreviewUrl(null);
    setPreviewPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, [voiceId]);

  function handleClose() {
    if (uploading) return;
    onClose();
    // Give the consumer a tick before we tear down local state.
    window.setTimeout(resetState, 50);
  }

  function acceptFile(f: File) {
    if (!isAcceptedFile(f)) {
      setError("Unsupported file. Upload .mp4, .mov, .webm, .avi, or .mkv.");
      return;
    }
    setError(null);
    setFile(f);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    e.target.value = "";
  }

  function onDropZoneKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  async function handlePreviewVoice() {
    if (!selectedVoice) return;
    try {
      setPreviewLoading(true);
      const api = await getApi();
      let url: string | null = null;
      if (typeof api.previewVoice === "function") {
        const res = await api.previewVoice(selectedVoice.id, SAMPLE_PREVIEW_TEXT);
        url = res?.url ?? null;
      } else if (selectedVoice.sample_url) {
        url = selectedVoice.sample_url;
      } else if (selectedVoice.preview_url) {
        url = selectedVoice.preview_url;
      }
      if (url && audioRef.current) {
        audioRef.current.src = url;
        setPreviewUrl(url);
        await audioRef.current.play();
        setPreviewPlaying(true);
      }
    } catch {
      setError("Could not load voice preview.");
    } finally {
      setPreviewLoading(false);
    }
  }

  function togglePreviewPlayback() {
    if (!audioRef.current || !previewUrl) {
      void handlePreviewVoice();
      return;
    }
    if (audioRef.current.paused) {
      audioRef.current.play().catch(() => undefined);
      setPreviewPlaying(true);
    } else {
      audioRef.current.pause();
      setPreviewPlaying(false);
    }
  }

  async function handleCreate() {
    if (!file || !voiceId) return;
    setUploading(true);
    setError(null);
    setProgress(0);
    try {
      const api = await getApi();
      if (
        typeof api.uploadChunks === "function" &&
        typeof api.completeUpload === "function"
      ) {
        const { upload_id } = await api.uploadChunks(file, (pct) => {
          setProgress(Math.min(95, Math.round(pct)));
        });
        await api.completeUpload(upload_id, {
          voice_id: voiceId,
          style,
          language,
          name: file.name.replace(/\.[^.]+$/, ""),
        });
      } else {
        // Fallback to the existing createJob while A-fe-share-api wires the
        // new /v1/upload/chunk + /v1/upload/complete helpers.
        const fd = new FormData();
        fd.append("file", file);
        fd.append("voice_id", voiceId);
        fd.append("style", style);
        fd.append("language", language);
        const interval = window.setInterval(() => {
          setProgress((p) => Math.min(90, p + 6));
        }, 250);
        try {
          await createJob(fd);
        } finally {
          window.clearInterval(interval);
        }
      }
      setProgress(100);
      window.setTimeout(() => {
        onCreated();
        resetState();
      }, 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setUploading(false);
      setProgress(0);
    }
  }

  function goBack() {
    if (step === 0) return;
    setStep((s) => ((s - 1) as Step));
  }

  function goNext() {
    if (step === 0) {
      if (!file) {
        setError("Please select a video file first.");
        return;
      }
      setStep(1);
      return;
    }
    if (step === 1) {
      if (!voiceId) {
        setError("Please pick a voice.");
        return;
      }
      setStep(2);
      return;
    }
  }

  const step0Valid = !!file;
  const step1Valid = !!voiceId;
  const canAdvance =
    (step === 0 && step0Valid) || (step === 1 && step1Valid) || step === 2;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
        className={cn(
          "relative w-full max-w-2xl overflow-hidden rounded-2xl glass",
          "shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)] animate-fade-in"
        )}
      >
        <audio
          ref={audioRef}
          onEnded={() => setPreviewPlaying(false)}
          hidden
        />

        {/* Header */}
        <header className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 id="upload-modal-title" className="type-h3 text-text">
              New project
            </h2>
            <StepIndicator step={step} />
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={handleClose}
            disabled={uploading}
            className={cn(
              "focus-ring flex h-9 w-9 items-center justify-center rounded-lg",
              "text-text-muted transition-colors hover:bg-bg-elev hover:text-text",
              "disabled:opacity-50"
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-6">
          {step === 0 ? (
            <UploadStep
              file={file}
              duration={duration}
              thumbnail={thumbnail}
              dragOver={dragOver}
              dropZoneRef={dropZoneRef}
              fileInputRef={fileInputRef}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onPick={() => fileInputRef.current?.click()}
              onKeyDown={onDropZoneKeyDown}
              onFileChange={onFileInputChange}
              onClear={() => setFile(null)}
            />
          ) : null}

          {step === 1 ? (
            <ConfigureStep
              voices={voices}
              voicesLoading={voicesLoading}
              voiceId={voiceId}
              onSelectVoice={setVoiceId}
              style={style}
              onStyleChange={setStyle}
              language={language}
              onLanguageChange={setLanguage}
              languageOpen={languageOpen}
              onLanguageOpenChange={setLanguageOpen}
              previewPlaying={previewPlaying}
              previewLoading={previewLoading}
              onTogglePreview={togglePreviewPlayback}
            />
          ) : null}

          {step === 2 ? (
            <ReviewStep
              file={file}
              duration={duration}
              thumbnail={thumbnail}
              voice={selectedVoice}
              style={style}
              language={language}
              uploading={uploading}
              progress={progress}
            />
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
            >
              {error}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={handleClose}
            disabled={uploading}
          >
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={goBack}
                disabled={uploading}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
            ) : null}
            {step < 2 ? (
              <Button
                type="button"
                size="md"
                onClick={goNext}
                disabled={!canAdvance}
              >
                Next
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                size="md"
                onClick={handleCreate}
                disabled={uploading || !file || !voiceId}
              >
                {uploading ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    Uploading…
                  </>
                ) : (
                  <>
                    Create project
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const labels = ["Upload", "Configure", "Review"];
  return (
    <ol className="mt-2 flex items-center gap-2" aria-label="Progress">
      {labels.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li
            key={label}
            className={cn(
              "flex items-center gap-2 text-xs",
              current ? "text-text" : done ? "text-accent" : "text-text-dim"
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold",
                current
                  ? "border-accent text-accent"
                  : done
                    ? "border-accent bg-accent text-[#0a0a0c]"
                    : "border-border"
              )}
              aria-current={current ? "step" : undefined}
            >
              {done ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                i + 1
              )}
            </span>
            <span className="font-medium">{label}</span>
            {i < labels.length - 1 ? (
              <span
                className={cn(
                  "mx-1 h-px w-6",
                  done ? "bg-accent" : "bg-border"
                )}
                aria-hidden="true"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

interface UploadStepProps {
  file: File | null;
  duration: number | null;
  thumbnail: string | null;
  dragOver: boolean;
  dropZoneRef: React.RefObject<HTMLDivElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onPick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}

function UploadStep({
  file,
  duration,
  thumbnail,
  dragOver,
  dropZoneRef,
  fileInputRef,
  onDrop,
  onDragOver,
  onDragLeave,
  onPick,
  onKeyDown,
  onFileChange,
  onClear,
}: UploadStepProps) {
  return (
    <div className="flex flex-col gap-5">
      <div
        ref={dropZoneRef}
        role="button"
        tabIndex={0}
        aria-label="Upload video"
        onClick={onPick}
        onKeyDown={onKeyDown}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={cn(
          "focus-ring flex cursor-pointer flex-col items-center justify-center rounded-2xl",
          "border-2 border-dashed px-6 py-12 text-center transition-colors",
          dragOver
            ? "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]"
            : file
              ? "border-success/60 bg-[color-mix(in_oklab,var(--success)_6%,transparent)]"
              : "border-border bg-bg-elev hover:border-border-hover"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={onFileChange}
        />
        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-2xl",
            dragOver
              ? "bg-accent text-[#0a0a0c]"
              : file
                ? "bg-[color-mix(in_oklab,var(--success)_20%,transparent)] text-success"
                : "bg-bg-card text-text-muted"
          )}
        >
          {file ? (
            <FileVideo className="h-6 w-6" aria-hidden="true" />
          ) : (
            <UploadIcon className="h-6 w-6" aria-hidden="true" />
          )}
        </div>
        <p className="mt-4 type-body font-semibold text-text">
          {file ? "File ready" : "Drop your video here"}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {file
            ? "Or click to choose another file"
            : "or click to browse"}
        </p>
        <p className="mt-3 text-xs text-text-dim">
          Accepts {ACCEPT_EXTENSIONS.join(", ")}
        </p>
      </div>

      {file ? (
        <div className="surface flex items-center gap-4 rounded-xl p-4">
          <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-bg-elev">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbnail}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-text-muted">
                <FileVideo className="h-5 w-5" aria-hidden="true" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">
              {file.name}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {formatBytes(file.size)} &middot; {formatSeconds(duration)}
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            aria-label="Remove file"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ConfigureStepProps {
  voices: ExtendedVoice[];
  voicesLoading: boolean;
  voiceId: string;
  onSelectVoice: (id: string) => void;
  style: StyleOption;
  onStyleChange: (next: StyleOption) => void;
  language: string;
  onLanguageChange: (next: string) => void;
  languageOpen: boolean;
  onLanguageOpenChange: (open: boolean) => void;
  previewPlaying: boolean;
  previewLoading: boolean;
  onTogglePreview: () => void;
}

function ConfigureStep({
  voices,
  voicesLoading,
  voiceId,
  onSelectVoice,
  style,
  onStyleChange,
  language,
  onLanguageChange,
  languageOpen,
  onLanguageOpenChange,
  previewPlaying,
  previewLoading,
  onTogglePreview,
}: ConfigureStepProps) {
  const selected = voices.find((v) => v.id === voiceId);
  return (
    <div className="flex flex-col gap-6">
      {/* Voice picker */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text">Voice</label>
        {voicesLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[72px] rounded-xl bg-bg-elev [animation:shimmer_1.8s_linear_infinite] bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--border)_70%,transparent),transparent)] bg-[length:200%_100%]"
              />
            ))}
          </div>
        ) : voices.length === 0 ? (
          <p className="rounded-lg border border-border bg-bg-elev p-4 text-sm text-text-muted">
            No voices are available right now.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {voices.map((v) => {
              const isSelected = v.id === voiceId;
              return (
                <button
                  type="button"
                  key={v.id}
                  onClick={() => onSelectVoice(v.id)}
                  aria-pressed={isSelected}
                  className={cn(
                    "focus-ring flex items-center gap-3 rounded-xl border p-3 text-left transition-all",
                    isSelected
                      ? "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] ring-2 ring-accent/40"
                      : "border-border bg-bg-card hover:border-border-hover"
                  )}
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-full",
                      isSelected
                        ? "bg-accent text-[#0a0a0c]"
                        : "bg-bg-elev text-text-muted"
                    )}
                  >
                    <Mic2 className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text">
                      {v.name}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {[v.accent, v.gender, v.language]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {selected ? (
          <button
            type="button"
            onClick={onTogglePreview}
            disabled={previewLoading}
            className={cn(
              "focus-ring mt-3 inline-flex items-center gap-2 rounded-lg border border-border bg-bg-card px-3 py-1.5 text-sm",
              "text-text transition-colors hover:border-border-hover disabled:opacity-50"
            )}
          >
            {previewLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : previewPlaying ? (
              <Pause className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {previewPlaying ? "Pause preview" : "Preview voice"}
            <Volume2
              className="ml-1 h-3.5 w-3.5 text-text-muted"
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>

      {/* Style */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text">Style</label>
        <div
          role="radiogroup"
          aria-label="Narration style"
          className="inline-flex rounded-full border border-border bg-bg-card p-1"
        >
          {(["formal", "casual"] as StyleOption[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={style === s}
              onClick={() => onStyleChange(s)}
              className={cn(
                "focus-ring rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                style === s
                  ? "bg-accent text-[#0a0a0c]"
                  : "text-text-muted hover:text-text"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Language */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text">
          Language
        </label>
        <LanguageSelect
          value={language}
          onChange={onLanguageChange}
          open={languageOpen}
          onOpenChange={onLanguageOpenChange}
        />
      </div>
    </div>
  );
}

interface LanguageSelectProps {
  value: string;
  onChange: (next: string) => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function LanguageSelect({
  value,
  onChange,
  open,
  onOpenChange,
}: LanguageSelectProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active =
    LANGUAGES.find((l) => l.value === value) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    }
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative w-full max-w-xs">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "focus-ring flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-card",
          "px-3.5 text-sm text-text transition-colors hover:border-border-hover"
        )}
      >
        <span>{active.label}</span>
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          className={cn(
            "absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-xl py-1",
            "surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)] animate-fade-in"
          )}
        >
          {LANGUAGES.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  onChange(opt.value);
                  onOpenChange(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3.5 py-2 text-sm transition-colors",
                  opt.value === value
                    ? "bg-bg-elev text-text"
                    : "text-text-muted hover:bg-bg-elev hover:text-text"
                )}
              >
                {opt.label}
                {opt.value === value ? (
                  <Check className="h-4 w-4 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface ReviewStepProps {
  file: File | null;
  duration: number | null;
  thumbnail: string | null;
  voice: ExtendedVoice | null;
  style: StyleOption;
  language: string;
  uploading: boolean;
  progress: number;
}

function ReviewStep({
  file,
  duration,
  thumbnail,
  voice,
  style,
  language,
  uploading,
  progress,
}: ReviewStepProps) {
  const langLabel =
    LANGUAGES.find((l) => l.value === language)?.label ?? language;

  return (
    <div className="flex flex-col gap-5">
      <div className="surface flex items-center gap-4 rounded-xl p-4">
        <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-lg bg-bg-elev">
          {thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnail}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-text-muted">
              <FileVideo className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
          {duration ? (
            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
              {formatSeconds(duration)}
            </span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text">
            {file?.name ?? "Untitled"}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {file ? formatBytes(file.size) : null}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4">
        <SummaryRow label="Voice" value={voice?.name ?? "–"} />
        <SummaryRow
          label="Accent"
          value={voice?.accent ?? voice?.language ?? "–"}
        />
        <SummaryRow label="Style" value={style} capitalize />
        <SummaryRow label="Language" value={langLabel} />
      </dl>

      {uploading ? (
        <div className="rounded-xl border border-border bg-bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">Uploading</span>
            <span className="text-sm tabular-nums text-text-muted">
              {progress}%
            </span>
          </div>
          <div className="mt-3">
            <Progress value={progress} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  capitalize,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-bg-card p-3">
      <dt className="text-xs uppercase tracking-wide text-text-dim">{label}</dt>
      <dd
        className={cn(
          "truncate text-sm font-medium text-text",
          capitalize && "capitalize"
        )}
      >
        {value}
      </dd>
    </div>
  );
}
