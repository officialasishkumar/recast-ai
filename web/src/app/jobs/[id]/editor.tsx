"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CornerDownLeft,
  Loader2,
  Play,
  RefreshCw,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  regenerateSegment,
  updateTranscript,
  type TranscriptSegment,
} from "@/lib/api";

interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

interface ExtendedSegment extends Omit<TranscriptSegment, "words_json"> {
  words_json?: WordTiming[] | string;
}

interface EditorProps {
  jobId: string;
  segments: TranscriptSegment[];
  activeMs?: number;
  onSegmentsUpdate: (segments: TranscriptSegment[]) => void;
  onSeek?: (ms: number) => void;
  onDirtyChange?: (count: number) => void;
  /** When the parent triggers a save via the sticky bar. */
  saveSignal?: number;
  /** When the parent triggers a revert via the sticky bar. */
  revertSignal?: number;
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")
    .slice(0, 2)}`;
}

function confidenceVariant(
  c: number
): "success" | "warning" | "danger" {
  if (c >= 0.85) return "success";
  if (c >= 0.6) return "warning";
  return "danger";
}

function parseWordTimings(seg: ExtendedSegment): WordTiming[] {
  const raw = seg.words_json;
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((w) => {
        const record = w as Record<string, unknown>;
        const text =
          (record.text as string) ||
          (record.word as string) ||
          (record.w as string);
        const startMs =
          (record.startMs as number) ??
          (record.start_ms as number) ??
          (typeof record.start === "number"
            ? (record.start as number) * 1000
            : undefined);
        const endMs =
          (record.endMs as number) ??
          (record.end_ms as number) ??
          (typeof record.end === "number"
            ? (record.end as number) * 1000
            : undefined);
        if (!text || startMs === undefined || endMs === undefined) return null;
        return { text, startMs, endMs };
      })
      .filter((x): x is WordTiming => !!x);
  } catch {
    return [];
  }
}

function AutoSizingTextarea({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      className={cn(
        "w-full resize-none rounded-lg border border-border bg-bg-elev px-3 py-2.5",
        "text-[15px] leading-relaxed text-text placeholder:text-text-dim",
        "focus-ring focus:border-accent focus:outline-none"
      )}
    />
  );
}

export function TranscriptEditor({
  jobId,
  segments,
  activeMs = 0,
  onSegmentsUpdate,
  onSeek,
  onDirtyChange,
  saveSignal,
  revertSignal,
}: EditorProps) {
  const [localSegments, setLocalSegments] =
    useState<TranscriptSegment[]>(segments);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baselineRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    setLocalSegments(segments);
    baselineRef.current = new Map(segments.map((s) => [s.id, s.text]));
    setSavedAt(null);
  }, [segments]);

  const dirtyIds = useMemo(() => {
    const ids: string[] = [];
    for (const seg of localSegments) {
      const baseline = baselineRef.current.get(seg.id);
      if (baseline !== undefined && baseline !== seg.text) ids.push(seg.id);
    }
    return ids;
  }, [localSegments]);

  useEffect(() => {
    onDirtyChange?.(dirtyIds.length);
  }, [dirtyIds.length, onDirtyChange]);

  const activeSegmentId = useMemo(() => {
    const active = localSegments.find(
      (seg) =>
        activeMs >= seg.start_ms - 10 && activeMs <= seg.end_ms + 10
    );
    return active?.id ?? null;
  }, [activeMs, localSegments]);

  useEffect(() => {
    if (!activeSegmentId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-segment-id="${activeSegmentId}"]`
    );
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const parentRect = listRef.current.getBoundingClientRect();
    if (rect.top < parentRect.top || rect.bottom > parentRect.bottom) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeSegmentId]);

  function updateText(id: string, text: string) {
    setLocalSegments((prev) =>
      prev.map((seg) => (seg.id === id ? { ...seg, text } : seg))
    );
  }

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await updateTranscript(jobId, localSegments);
      onSegmentsUpdate(result.segments);
      setLocalSegments(result.segments);
      baselineRef.current = new Map(
        result.segments.map((s) => [s.id, s.text])
      );
      setSavedAt(Date.now());
    } catch {
      // handled by api client
    } finally {
      setSaving(false);
    }
  }, [jobId, localSegments, onSegmentsUpdate, saving]);

  const handleRevert = useCallback(() => {
    setLocalSegments((prev) =>
      prev.map((seg) => ({
        ...seg,
        text: baselineRef.current.get(seg.id) ?? seg.text,
      }))
    );
    setSavedAt(null);
  }, []);

  useEffect(() => {
    if (saveSignal === undefined) return;
    handleSave();
  }, [saveSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (revertSignal === undefined) return;
    handleRevert();
  }, [revertSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRegenerate(segmentId: string) {
    setRegenerating(segmentId);
    try {
      await regenerateSegment(jobId, segmentId);
    } catch {
      // handled by api client
    } finally {
      setRegenerating(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="type-h3 text-text">Transcript</h3>
          <p className="type-meta">
            {localSegments.length} segments
            {dirtyIds.length > 0 && (
              <>
                {" · "}
                <span className="text-warn">
                  {dirtyIds.length} unsaved change
                  {dirtyIds.length === 1 ? "" : "s"}
                </span>
              </>
            )}
            {savedAt && dirtyIds.length === 0 && (
              <>
                {" · "}
                <span className="text-success">Saved</span>
              </>
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleSave}
          disabled={saving || dirtyIds.length === 0}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving" : "Save all changes"}
        </Button>
      </header>

      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto pr-1"
        style={{ maxHeight: "70vh" }}
      >
        {localSegments.length === 0 && (
          <p className="rounded-xl border border-dashed border-border bg-bg-card px-5 py-12 text-center text-sm text-text-dim">
            Transcript not ready yet. It will appear here once the analyzer
            finishes.
          </p>
        )}

        {localSegments.map((seg) => {
          const dirty = dirtyIds.includes(seg.id);
          const active = activeSegmentId === seg.id;
          const words = parseWordTimings(seg as unknown as ExtendedSegment);

          return (
            <article
              key={seg.id}
              data-segment-id={seg.id}
              className={cn(
                "surface relative rounded-xl px-4 py-3.5",
                "transition-colors hover:border-border-hover",
                active &&
                  "bg-bg-elev border-border-hover"
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent"
                />
              )}
              {seg.flagged && (
                <div
                  role="status"
                  className={cn(
                    "mb-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                    "border-[color-mix(in_oklab,var(--warn)_35%,transparent)]",
                    "bg-[color-mix(in_oklab,var(--warn)_12%,transparent)] text-warn"
                  )}
                >
                  <AlertTriangle
                    className="h-3.5 w-3.5 flex-none"
                    strokeWidth={2.25}
                  />
                  <span className="leading-snug">
                    Flagged for review — double-check tone and accuracy before
                    regenerating.
                  </span>
                </div>
              )}

              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSeek?.(Math.floor(seg.start_ms))}
                  className={cn(
                    "num-tab rounded-md border border-border bg-bg-elev px-2 py-0.5 text-[11px]",
                    "text-text-muted transition-colors hover:border-border-hover hover:text-text focus-ring"
                  )}
                  aria-label={`Jump to ${formatTimecode(seg.start_ms / 1000)}`}
                >
                  {formatTimecode(seg.start_ms / 1000)}
                </button>
                <span aria-hidden="true" className="text-text-dim">
                  <CornerDownLeft className="h-3 w-3 rotate-180" />
                </span>
                <button
                  type="button"
                  onClick={() => onSeek?.(Math.floor(seg.end_ms))}
                  className={cn(
                    "num-tab rounded-md border border-border bg-bg-elev px-2 py-0.5 text-[11px]",
                    "text-text-muted transition-colors hover:border-border-hover hover:text-text focus-ring"
                  )}
                  aria-label={`Jump to ${formatTimecode(seg.end_ms / 1000)}`}
                >
                  {formatTimecode(seg.end_ms / 1000)}
                </button>
                {dirty && (
                  <Badge variant="warning" className="ml-1">
                    Unsaved
                  </Badge>
                )}
                <Badge
                  variant={confidenceVariant(seg.confidence)}
                  className="ml-auto"
                >
                  {Math.round(seg.confidence * 100)}%
                </Badge>
              </div>

              {words.length > 0 && (
                <div className="mb-2.5 flex flex-wrap gap-x-1.5 gap-y-1 text-[13px] leading-snug">
                  {words.map((w, i) => {
                    const activeWord =
                      activeMs >= w.startMs - 10 &&
                      activeMs <= w.endMs + 10;
                    return (
                      <button
                        key={`${seg.id}-w-${i}`}
                        type="button"
                        onClick={() => onSeek?.(w.startMs)}
                        className={cn(
                          "focus-ring rounded px-0.5 transition-colors",
                          activeWord
                            ? "bg-accent/30 text-text"
                            : "text-text-muted hover:text-text"
                        )}
                      >
                        {w.text}
                      </button>
                    );
                  })}
                </div>
              )}

              <AutoSizingTextarea
                value={seg.text}
                onChange={(next) => updateText(seg.id, next)}
                label={`Edit segment ${formatTimecode(seg.start_ms / 1000)}`}
              />

              <div className="mt-2.5 flex items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSeek?.(Math.floor(seg.start_ms))}
                >
                  <Play className="h-3.5 w-3.5" strokeWidth={2.25} />
                  Play segment
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleRegenerate(seg.id)}
                  disabled={regenerating === seg.id}
                >
                  {regenerating === seg.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.25} />
                  )}
                  {regenerating === seg.id
                    ? "Regenerating"
                    : "Regenerate voice"}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
