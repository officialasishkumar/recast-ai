"use client";

import Link from "next/link";
import { Film, Clock, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Job, JobStage } from "@/lib/api";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const statusVariant: Record<
  JobStage,
  "green" | "blue" | "yellow" | "red" | "default" | "indigo"
> = {
  uploaded: "default",
  analyzing: "blue",
  transcribed: "yellow",
  synthesizing: "indigo",
  muxing: "blue",
  completed: "green",
  failed: "red",
};

const statusLabel: Record<JobStage, string> = {
  uploaded: "Uploaded",
  analyzing: "Processing",
  transcribed: "Transcribed",
  synthesizing: "Synthesizing",
  muxing: "Muxing",
  completed: "Completed",
  failed: "Failed",
};

interface JobCardProps {
  job: Job;
  onDelete: (id: string) => void;
}

export function JobCard({ job, onDelete }: JobCardProps) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="group flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4 transition-colors hover:border-slate-700 hover:bg-slate-900"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-400 group-hover:bg-indigo-600/20 group-hover:text-indigo-400">
        <Film className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-100">
          {job.name}
        </p>
        <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(job.duration)}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatDate(job.created_at)}
          </span>
        </div>
      </div>

      <Badge variant={statusVariant[job.status]}>
        {statusLabel[job.status]}
      </Badge>

      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete(job.id);
        }}
        className="rounded-lg p-1.5 text-slate-500 opacity-0 transition-opacity hover:bg-slate-800 hover:text-red-400 group-hover:opacity-100"
        aria-label="Delete job"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </button>
    </Link>
  );
}
