"use client";

import { useState, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { updateTranscript, type TranscriptSegment } from "@/lib/api";
import { Save, AlertTriangle } from "lucide-react";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

function confidenceVariant(c: number): "green" | "yellow" | "red" {
  if (c >= 0.9) return "green";
  if (c >= 0.7) return "yellow";
  return "red";
}

interface EditorProps {
  jobId: string;
  videoUrl: string;
  segments: TranscriptSegment[];
  onSegmentsUpdate: (segments: TranscriptSegment[]) => void;
}

export function TranscriptEditor({
  jobId,
  videoUrl,
  segments,
  onSegmentsUpdate,
}: EditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [localSegments, setLocalSegments] = useState<TranscriptSegment[]>(segments);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  }, []);

  function updateSegmentText(id: string, text: string) {
    setLocalSegments((prev) =>
      prev.map((seg) => (seg.id === id ? { ...seg, text } : seg))
    );
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const result = await updateTranscript(jobId, localSegments);
      onSegmentsUpdate(result.segments);
      setLocalSegments(result.segments);
      setSaved(true);
    } catch {
      // error handled by API client
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid h-full gap-4 lg:grid-cols-2">
      {/* Left: Video player */}
      <div className="flex flex-col">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-black">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="aspect-video w-full"
          />
        </div>
      </div>

      {/* Right: Transcript segments */}
      <div className="flex flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">
            Transcript Segments
          </h3>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving..." : saved ? "Saved" : "Save changes"}
          </Button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: "60vh" }}>
          {localSegments.map((seg) => (
            <div
              key={seg.id}
              className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"
            >
              {/* Flagged warning */}
              {seg.flagged && (
                <div className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-900/30 px-2.5 py-1.5 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  This segment has been flagged for review
                </div>
              )}

              {/* Time range + confidence */}
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={() => seekTo(seg.start)}
                  className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                >
                  {formatTime(seg.start)}
                </button>
                <span className="text-xs text-slate-600">-</span>
                <button
                  onClick={() => seekTo(seg.end)}
                  className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                >
                  {formatTime(seg.end)}
                </button>
                <Badge variant={confidenceVariant(seg.confidence)} className="ml-auto">
                  {Math.round(seg.confidence * 100)}%
                </Badge>
              </div>

              {/* Editable text */}
              <textarea
                value={seg.text}
                onChange={(e) => updateSegmentText(seg.id, e.target.value)}
                rows={2}
                className="w-full resize-none rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
