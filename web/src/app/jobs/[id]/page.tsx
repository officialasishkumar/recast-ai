"use client";

import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  Clock,
  Copy,
  Download,
  Loader2,
  Mic,
  Globe2,
  Share2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PipelineProgress } from "@/components/pipeline-progress";
import { cn } from "@/lib/utils";
import {
  deleteJob,
  exportJob,
  getJob,
  getTranscript,
  shareJob,
  type Job,
  type JobStage,
  type TranscriptSegment,
} from "@/lib/api";
import { connectJobWS } from "@/lib/ws";
import { TranscriptEditor } from "./editor";
import { VideoPlayer, type VideoPlayerHandle } from "./video-player";

interface ExtendedJob extends Job {
  voice_name?: string;
  language?: string;
}

const TRANSCRIPT_STAGES: JobStage[] = [
  "transcribed",
  "synthesizing",
  "muxing",
  "completed",
];

const STATUS_LABEL: Record<JobStage, string> = {
  uploaded: "Uploaded",
  analyzing: "Analyzing",
  transcribed: "Transcribed",
  synthesizing: "Synthesizing",
  muxing: "Muxing",
  completed: "Ready",
  failed: "Failed",
};

function statusVariant(status: JobStage) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  return "info" as const;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "--";
  }
}

function formatRelative(iso?: string): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "never";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [job, setJob] = useState<ExtendedJob | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [dirtyCount, setDirtyCount] = useState(0);
  const [saveTick, setSaveTick] = useState(0);
  const [revertTick, setRevertTick] = useState(0);

  const [activeMs, setActiveMs] = useState(0);

  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCreating, setShareCreating] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const playerRef = useRef<VideoPlayerHandle>(null);

  const loadJob = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await getJob(id)) as ExtendedJob;
      setJob(data);
      if (TRANSCRIPT_STAGES.includes(data.status)) {
        const transcript = await getTranscript(id);
        setSegments(transcript.segments);
      }
    } catch {
      // handled by api client
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.push("/login");
      return;
    }
    loadJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobStatus) return;
    if (jobStatus === "completed" || jobStatus === "failed") return;

    const cleanup = connectJobWS(id, (event) => {
      if (event.stage) {
        const nextStage = event.stage as JobStage;
        setJob((prev) =>
          prev
            ? { ...prev, status: nextStage, updated_at: new Date().toISOString() }
            : prev
        );
        if (TRANSCRIPT_STAGES.includes(nextStage)) {
          getTranscript(id)
            .then((t) => setSegments(t.segments))
            .catch(() => {});
        }
      }
    });

    return cleanup;
  }, [id, jobStatus]);

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seek(ms);
    playerRef.current?.play();
  }, []);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportJob(id);
      window.open(result.url, "_blank");
    } catch {
      // handled
    } finally {
      setExporting(false);
    }
  }, [exporting, id]);

  const handleConfirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteJob(id);
      router.push("/dashboard");
    } catch {
      setDeleting(false);
    }
  }, [id, router]);

  const handleShare = useCallback(async () => {
    setShareOpen(true);
    setShareCopied(false);
    if (shareUrl || shareCreating) return;
    setShareCreating(true);
    try {
      const res = await shareJob(id);
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const url = res.url.startsWith("http")
        ? res.url
        : `${origin}${res.url.startsWith("/") ? "" : "/"}${res.url}`;
      setShareUrl(url);
    } catch {
      // handled
    } finally {
      setShareCreating(false);
    }
  }, [id, shareCreating, shareUrl]);

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // clipboard may be blocked; ignore
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirtyCount > 0) setSaveTick((t) => t + 1);
        return;
      }

      if (isEditable) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        playerRef.current?.toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = playerRef.current?.getCurrentMs() ?? 0;
        playerRef.current?.seek(Math.max(0, cur - 5_000));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const cur = playerRef.current?.getCurrentMs() ?? 0;
        playerRef.current?.seek(cur + 5_000);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirtyCount]);

  const showTranscript = !!job && TRANSCRIPT_STAGES.includes(job.status);
  const videoSrc = useMemo(() => {
    if (!job) return "";
    return job.output_url || job.video_url || "";
  }, [job]);

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-text-dim" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <p className="text-sm text-text-muted">Job not found.</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto min-h-[calc(100vh-4rem)] max-w-[1400px] px-5 pt-8 sm:px-8",
        dirtyCount > 0 ? "pb-28" : "pb-10"
      )}
    >
      <Link
        href="/dashboard"
        className={cn(
          "focus-ring mb-6 inline-flex items-center gap-1.5 rounded-md text-sm text-text-muted",
          "transition-colors hover:text-text"
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <section
        className={cn(
          "surface flex flex-col gap-5 rounded-2xl px-6 py-5",
          "sm:flex-row sm:items-start sm:justify-between sm:gap-6"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="type-h2 truncate text-text">{job.name}</h2>
            <Badge variant={statusVariant(job.status)}>
              {STATUS_LABEL[job.status] ?? job.status}
            </Badge>
          </div>
          <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-text-muted">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <span className="num-tab">{formatDuration(job.duration)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-dim">Created</span>
              <span className="text-text">{formatDate(job.created_at)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-text-dim">Updated</span>
              <span className="text-text">
                {formatRelative(job.updated_at)}
              </span>
            </div>
            {job.voice_name && (
              <div className="flex items-center gap-1.5">
                <Mic className="h-3.5 w-3.5" />
                <span className="text-text">{job.voice_name}</span>
              </div>
            )}
            {job.language && (
              <div className="flex items-center gap-1.5">
                <Globe2 className="h-3.5 w-3.5" />
                <span className="text-text">
                  {job.language.toUpperCase()}
                </span>
              </div>
            )}
          </dl>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleShare}>
            <Share2 className="h-4 w-4" />
            Share
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={exporting || job.status !== "completed"}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowDeleteConfirm(true)}
            aria-label="Delete project"
            className="text-danger hover:text-danger"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </section>

      <section className="surface mt-5 overflow-hidden rounded-2xl">
        <button
          type="button"
          onClick={() => setPipelineOpen((o) => !o)}
          className={cn(
            "focus-ring flex w-full items-center justify-between gap-3 px-6 py-3.5",
            "transition-colors hover:bg-bg-elev"
          )}
          aria-expanded={pipelineOpen}
          aria-controls="pipeline-panel"
        >
          <span className="flex items-center gap-2.5 text-sm font-medium text-text">
            <Sparkles className="h-4 w-4 text-accent" />
            Pipeline progress
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-text-muted transition-transform",
              pipelineOpen && "rotate-180"
            )}
          />
        </button>
        {pipelineOpen && (
          <div id="pipeline-panel" className="border-t border-border px-6 py-5">
            <PipelineProgress currentStage={job.status} />
          </div>
        )}
      </section>

      <section className="mt-5 grid gap-5 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-3">
          <VideoPlayer
            ref={playerRef}
            src={videoSrc}
            segments={segments}
            onTimeUpdate={setActiveMs}
            className="w-full"
          />
        </div>
        <div className="lg:col-span-2">
          {showTranscript ? (
            <TranscriptEditor
              jobId={id}
              segments={segments}
              activeMs={activeMs}
              onSegmentsUpdate={setSegments}
              onSeek={handleSeek}
              onDirtyChange={setDirtyCount}
              saveSignal={saveTick}
              revertSignal={revertTick}
            />
          ) : (
            <div className="surface flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-2xl px-6 py-10 text-center">
              <Sparkles className="h-6 w-6 text-accent" />
              <p className="text-sm font-medium text-text">
                Transcript is still being prepared.
              </p>
              <p className="type-meta">
                This panel will light up once the analyzer finishes.
              </p>
            </div>
          )}
        </div>
      </section>

      {dirtyCount > 0 && (
        <div
          className={cn(
            "fixed inset-x-0 bottom-0 z-40 flex justify-center",
            "px-4 pb-5"
          )}
        >
          <div
            role="region"
            aria-label="Unsaved changes"
            className={cn(
              "glass surface flex w-full max-w-[1100px] items-center justify-between gap-4 rounded-2xl",
              "px-5 py-3 shadow-[0_20px_60px_-25px_rgba(0,0,0,0.65)]"
            )}
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--warn)_18%,transparent)] text-warn">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-medium text-text">
                  {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
                </p>
                <p className="text-xs text-text-muted">
                  Re-synthesize modified segments or revert to the last saved
                  transcript.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRevertTick((t) => t + 1)}
              >
                Revert
              </Button>
              <Button size="sm" onClick={() => setSaveTick((t) => t + 1)}>
                <Sparkles className="h-4 w-4" />
                Save & regenerate
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5"
          onClick={() => !deleting && setShowDeleteConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="surface w-full max-w-md rounded-2xl px-6 py-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="delete-title" className="type-h3 text-text">
                  Delete this project?
                </h3>
                <p className="mt-1 text-sm text-text-muted">
                  This permanently removes the video, transcript, and any
                  exports. The action cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                aria-label="Close"
                className="focus-ring rounded-md p-1 text-text-muted hover:bg-bg-elev hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete project
              </Button>
            </div>
          </div>
        </div>
      )}

      {shareOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5"
          onClick={() => setShareOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="surface w-full max-w-md rounded-2xl px-6 py-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="share-title" className="type-h3 text-text">
                  Share this project
                </h3>
                <p className="mt-1 text-sm text-text-muted">
                  Anyone with the link can watch the narrated video and read
                  the transcript.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                aria-label="Close"
                className="focus-ring rounded-md p-1 text-text-muted hover:bg-bg-elev hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-bg-elev px-3 py-2">
              <input
                readOnly
                value={
                  shareCreating
                    ? "Generating link..."
                    : shareUrl ?? "Unable to create link"
                }
                aria-label="Public share URL"
                className="num-tab w-full bg-transparent text-sm text-text outline-none"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={copyShareLink}
                disabled={!shareUrl}
              >
                <Copy className="h-3.5 w-3.5" />
                {shareCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
