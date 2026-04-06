"use client";

import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import type { JobStage } from "@/lib/api";

const STAGES: { key: JobStage; label: string }[] = [
  { key: "uploaded", label: "Upload" },
  { key: "analyzing", label: "Analyze" },
  { key: "transcribed", label: "Transcript" },
  { key: "synthesizing", label: "Synthesize" },
  { key: "muxing", label: "Mux" },
  { key: "completed", label: "Done" },
];

function stageIndex(stage: JobStage): number {
  const idx = STAGES.findIndex((s) => s.key === stage);
  return idx === -1 ? -1 : idx;
}

interface PipelineProgressProps {
  currentStage: JobStage;
}

export function PipelineProgress({ currentStage }: PipelineProgressProps) {
  const currentIdx = stageIndex(currentStage);
  const failed = currentStage === "failed";

  return (
    <div className="flex items-center justify-between gap-0">
      {STAGES.map((stage, i) => {
        const completed = currentIdx > i;
        const active = currentIdx === i;

        return (
          <div key={stage.key} className="flex items-center">
            {/* Node */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-bold transition-all",
                  completed
                    ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                    : active && !failed
                      ? "animate-pulse border-indigo-500 bg-indigo-500/20 text-indigo-400"
                      : active && failed
                        ? "border-red-500 bg-red-500/20 text-red-400"
                        : "border-slate-700 bg-slate-800 text-slate-500"
                )}
              >
                {completed ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span>{i + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  "text-xs font-medium",
                  completed
                    ? "text-emerald-400"
                    : active
                      ? failed
                        ? "text-red-400"
                        : "text-indigo-400"
                      : "text-slate-500"
                )}
              >
                {stage.label}
              </span>
            </div>

            {/* Connector line */}
            {i < STAGES.length - 1 && (
              <div
                className={cn(
                  "mx-1 h-0.5 w-6 sm:w-10 md:w-14",
                  currentIdx > i ? "bg-emerald-500" : "bg-slate-700"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
