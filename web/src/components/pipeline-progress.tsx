"use client";

import {
  Check,
  Upload,
  ScanSearch,
  FileText,
  AudioLines,
  Film,
  CheckCircle2,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { JobStage } from "@/lib/api";

interface Stage {
  key: JobStage;
  label: string;
  icon: LucideIcon;
}

const STAGES: Stage[] = [
  { key: "uploaded", label: "Upload", icon: Upload },
  { key: "analyzing", label: "Analyzing", icon: ScanSearch },
  { key: "transcribed", label: "Transcribing", icon: FileText },
  { key: "synthesizing", label: "Synthesizing", icon: AudioLines },
  { key: "muxing", label: "Muxing", icon: Film },
  { key: "completed", label: "Done", icon: CheckCircle2 },
];

function stageIndex(stage: JobStage): number {
  return STAGES.findIndex((s) => s.key === stage);
}

function formatEta(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

interface PipelineProgressProps {
  currentStage: JobStage;
  etaSeconds?: number;
}

export function PipelineProgress({
  currentStage,
  etaSeconds,
}: PipelineProgressProps) {
  const failed = currentStage === "failed";
  const currentIdx = failed
    ? Math.max(0, STAGES.findIndex((s) => s.key === "synthesizing"))
    : stageIndex(currentStage);

  return (
    <div className="w-full">
      <ol
        className="flex w-full items-stretch gap-2 overflow-x-auto"
        aria-label="Pipeline progress"
      >
        {STAGES.map((stage, i) => {
          const completed = !failed && currentIdx > i;
          const active = !failed && currentIdx === i;
          const Icon = failed && active ? AlertCircle : stage.icon;

          return (
            <li
              key={stage.key}
              className="flex flex-1 items-center gap-2"
              aria-current={active ? "step" : undefined}
            >
              <div
                className={cn(
                  "relative flex flex-1 items-center gap-2.5 rounded-full border px-3.5 py-2",
                  "transition-colors duration-200 ease-out",
                  "min-w-[8rem]",
                  completed &&
                    "border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-text",
                  active &&
                    !failed &&
                    "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-text overflow-hidden",
                  active &&
                    failed &&
                    "border-danger bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] text-text",
                  !completed &&
                    !active &&
                    "border-border bg-bg-elev text-text-dim"
                )}
              >
                {active && !failed && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-0 rounded-full",
                      "bg-[linear-gradient(90deg,transparent_0%,color-mix(in_oklab,var(--accent)_25%,transparent)_45%,color-mix(in_oklab,var(--accent)_45%,transparent)_50%,color-mix(in_oklab,var(--accent)_25%,transparent)_55%,transparent_100%)]",
                      "bg-[length:220%_100%] motion-safe:animate-[shimmer_2.2s_linear_infinite]"
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative flex h-6 w-6 flex-none items-center justify-center rounded-full",
                    completed && "bg-accent text-[#0a0a0c]",
                    active &&
                      !failed &&
                      "bg-accent text-[#0a0a0c] shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
                    active && failed && "bg-danger text-[#0a0a0c]",
                    !completed && !active && "bg-border text-text-dim"
                  )}
                >
                  {completed ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2.75} />
                  ) : (
                    <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
                  )}
                </span>
                <span
                  className={cn(
                    "relative text-[13px] font-medium tracking-tight truncate",
                    (completed || active) && "text-text",
                    !completed && !active && "text-text-dim"
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "hidden h-px flex-1 max-w-[2rem] sm:block",
                    completed ? "bg-accent/60" : "bg-border"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 flex items-center justify-between text-sm">
        <p className="type-meta">
          {failed
            ? "Pipeline halted — review logs for the failed stage."
            : currentStage === "completed"
              ? "All stages complete."
              : `Currently ${STAGES[currentIdx]?.label.toLowerCase() ?? "working"}...`}
        </p>
        {!failed &&
          currentStage !== "completed" &&
          typeof etaSeconds === "number" && (
            <p className="num-tab text-sm text-text-muted">
              ETA <span className="text-text">{formatEta(etaSeconds)}</span>
            </p>
          )}
      </div>
    </div>
  );
}
