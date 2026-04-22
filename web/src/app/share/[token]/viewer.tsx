"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { PublicShare, TranscriptSegment } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ShareViewerProps {
  share: PublicShare;
}

/** Read-only share playback UI with synchronized transcript scroll. */
export function ShareViewer({ share }: ShareViewerProps) {
  const { job, transcript, output_url } = share;
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMs] = useState(0);

  const sortedSegments = useMemo<TranscriptSegment[]>(
    () => [...transcript].sort((a, b) => a.start_ms - b.start_ms),
    [transcript]
  );

  const activeIdx = useMemo(() => {
    const idx = sortedSegments.findIndex(
      (s) => currentMs >= s.start_ms && currentMs < s.end_ms
    );
    if (idx !== -1) return idx;
    // after the last segment, keep it highlighted
    for (let i = sortedSegments.length - 1; i >= 0; i--) {
      if (currentMs >= sortedSegments[i].start_ms) return i;
    }
    return -1;
  }, [currentMs, sortedSegments]);

  const seekToMs = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, ms / 1000);
    if (v.paused) {
      v.play().catch(() => {});
    }
  }, []);

  // Sync video time into React state (throttled via native timeupdate).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tick = () => setCurrentMs(Math.floor(v.currentTime * 1000));
    v.addEventListener("timeupdate", tick);
    return () => v.removeEventListener("timeupdate", tick);
  }, []);

  // Scroll the active segment into view.
  useEffect(() => {
    if (activeIdx < 0) return;
    const container = transcriptRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-segment-idx="${activeIdx}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeIdx]);

  // Keyboard shortcuts: space = play/pause, arrows = seek 5s.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min((v.duration || Infinity), v.currentTime + 5);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const videoSrc = output_url || job.output_url || job.video_url || "";
  const durationLabel = formatMs(
    sortedSegments.length > 0
      ? sortedSegments[sortedSegments.length - 1].end_ms
      : (job.duration || 0) * 1000
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-8 sm:px-6 sm:py-12 lg:py-16">
      {/* Header */}
      <header className="mb-8 flex items-start justify-between gap-4 sm:mb-10">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-text-dim">
            Shared recording
          </p>
          <h1 className="type-h2 mt-2 break-words text-text">{job.name}</h1>
          <p className="mt-1 text-sm text-text-muted num-tab">
            {durationLabel} · {sortedSegments.length} segments
          </p>
        </div>
        <Link
          href="/"
          className="group inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-bg-card px-3.5 py-1.5 text-xs font-medium text-text-muted transition hover:border-border-hover hover:text-text focus-ring"
        >
          <Sparkles className="h-3.5 w-3.5 text-accent transition group-hover:scale-110" />
          Made with Recast AI
        </Link>
      </header>

      {/* Video */}
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-black shadow-[0_30px_60px_-25px_rgba(0,0,0,0.6)]">
        <video
          ref={videoRef}
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          className="aspect-video w-full"
        />
      </div>

      {/* Transcript */}
      {sortedSegments.length > 0 && (
        <section className="mt-10 sm:mt-14" aria-label="Transcript">
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="type-h3 text-text">Transcript</h2>
            <span className="text-xs text-text-dim num-tab">
              Synced with playback
            </span>
          </div>

          <div
            ref={transcriptRef}
            className="space-y-1.5 rounded-[var(--radius-lg)] border border-border bg-bg-card/60 p-3 sm:p-5"
          >
            {sortedSegments.map((seg, idx) => {
              const active = idx === activeIdx;
              return (
                <button
                  key={seg.id}
                  type="button"
                  data-segment-idx={idx}
                  onClick={() => seekToMs(seg.start_ms)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "group grid w-full grid-cols-[72px_1fr] items-start gap-4 rounded-[var(--radius)] px-3 py-3 text-left transition focus-ring sm:px-4 sm:py-4",
                    active
                      ? "bg-accent/10 text-text"
                      : "text-text-muted hover:bg-bg-elev hover:text-text"
                  )}
                >
                  <span
                    className={cn(
                      "num-tab mt-0.5 inline-flex rounded-md px-2 py-0.5 text-xs font-medium tabular-nums",
                      active
                        ? "bg-accent/25 text-accent"
                        : "bg-bg-elev text-text-dim group-hover:text-text-muted"
                    )}
                  >
                    {formatMs(seg.start_ms)}
                  </span>
                  <span
                    className={cn(
                      "text-[17px] leading-[1.55] transition-colors",
                      active ? "font-medium" : "opacity-75 group-hover:opacity-100"
                    )}
                  >
                    {seg.text}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-14 flex flex-col items-center justify-between gap-3 border-t border-border pt-6 text-xs text-text-dim sm:flex-row">
        <span>Space to play/pause. Arrow keys to skip 5 seconds.</span>
        <Link
          href="/"
          className="text-text-muted transition hover:text-text focus-ring"
        >
          recast.ai
        </Link>
      </footer>
    </div>
  );
}
