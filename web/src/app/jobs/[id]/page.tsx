"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Download,
  Trash2,
  Clock,
  Calendar,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PipelineProgress } from "@/components/pipeline-progress";
import { TranscriptEditor } from "./editor";
import {
  getJob,
  getTranscript,
  exportJob,
  deleteJob,
  type Job,
  type JobStage,
  type TranscriptSegment,
} from "@/lib/api";
import { connectJobWS } from "@/lib/ws";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const TRANSCRIPT_STAGES: JobStage[] = [
  "transcribed",
  "synthesizing",
  "muxing",
  "completed",
];

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.push("/login");
      return;
    }
    loadJob();
  }, [id, router]);

  async function loadJob() {
    setLoading(true);
    try {
      const data = await getJob(id);
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
  }

  // WebSocket for real-time updates
  useEffect(() => {
    if (!job) return;
    if (job.status === "completed" || job.status === "failed") return;

    const cleanup = connectJobWS(id, (event) => {
      if (event.stage) {
        setJob((prev) =>
          prev ? { ...prev, status: event.stage as JobStage } : prev
        );
        // Fetch transcript when stage reaches transcribed
        if (TRANSCRIPT_STAGES.includes(event.stage as JobStage)) {
          getTranscript(id)
            .then((t) => setSegments(t.segments))
            .catch(() => {});
        }
      }
    });

    return cleanup;
  }, [id, job?.status]);

  async function handleExport() {
    setExporting(true);
    try {
      const result = await exportJob(id);
      window.open(result.url, "_blank");
    } catch {
      // handled by api client
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this project? This action cannot be undone.")) {
      return;
    }
    try {
      await deleteJob(id);
      router.push("/dashboard");
    } catch {
      // handled by api client
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-slate-500">Job not found.</p>
      </div>
    );
  }

  const showTranscript = TRANSCRIPT_STAGES.includes(job.status);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Back */}
      <Link
        href="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{job.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatDuration(job.duration)}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatDate(job.created_at)}
            </span>
            <Badge
              variant={
                job.status === "completed"
                  ? "green"
                  : job.status === "failed"
                    ? "red"
                    : "blue"
              }
            >
              {job.status}
            </Badge>
          </div>
        </div>

        <div className="flex gap-2">
          {job.status === "completed" && (
            <Button onClick={handleExport} disabled={exporting}>
              <Download className="h-4 w-4" />
              {exporting ? "Exporting..." : "Export"}
            </Button>
          )}
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Pipeline progress */}
      <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="mb-4 text-sm font-semibold text-slate-300">
          Pipeline Progress
        </h2>
        <PipelineProgress currentStage={job.status} />
      </div>

      {/* Transcript editor */}
      {showTranscript && (
        <div className="mt-8">
          <TranscriptEditor
            jobId={id}
            videoUrl={job.video_url || ""}
            segments={segments}
            onSegmentsUpdate={setSegments}
          />
        </div>
      )}

      {/* Completed state */}
      {job.status === "completed" && job.output_url && (
        <div className="mt-8 rounded-xl border border-emerald-800/50 bg-emerald-900/10 p-6 text-center">
          <p className="text-sm font-medium text-emerald-400">
            Your narrated video is ready!
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Button onClick={handleExport} disabled={exporting}>
              <Download className="h-4 w-4" />
              Download video
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
