"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptSegment } from "@/lib/api";

export interface VideoPlayerHandle {
  seek: (ms: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  getCurrentMs: () => number;
}

interface VideoPlayerProps {
  src: string;
  poster?: string;
  segments?: TranscriptSegment[];
  onTimeUpdate?: (ms: number) => void;
  onPlayChange?: (playing: boolean) => void;
  className?: string;
}

function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function buildWaveformBars(
  segments: TranscriptSegment[] | undefined,
  count: number
): number[] {
  if (!segments || segments.length === 0) {
    return Array.from({ length: count }, (_, i) => {
      const x = i / count;
      return (
        0.35 +
        0.5 * Math.abs(Math.sin(x * Math.PI * 6)) +
        0.15 * Math.abs(Math.cos(x * Math.PI * 17))
      );
    });
  }

  const duration = Math.max(
    ...segments.map((seg) => seg.end * 1000),
    1
  );
  const bars: number[] = new Array(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    const barStart = (i / count) * duration;
    const barEnd = ((i + 1) / count) * duration;
    const overlapping = segments.filter(
      (seg) => seg.end * 1000 >= barStart && seg.start * 1000 <= barEnd
    );
    if (overlapping.length === 0) {
      bars[i] = 0.12;
      continue;
    }
    const density = overlapping.reduce((acc, seg) => {
      const segDurationMs = Math.max((seg.end - seg.start) * 1000, 1);
      const textWeight = Math.min(seg.text.length / 140, 1.2);
      const overlap =
        Math.min(barEnd, seg.end * 1000) - Math.max(barStart, seg.start * 1000);
      const share = Math.max(overlap, 0) / segDurationMs;
      return acc + textWeight * share;
    }, 0);
    const seeded =
      0.2 + 0.7 * Math.min(density, 1) + 0.1 * Math.abs(Math.sin(i * 1.7));
    bars[i] = Math.min(1, seeded);
  }
  return bars;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer(
    { src, poster, segments, onTimeUpdate, onPlayChange, className },
    ref
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrubberRef = useRef<HTMLDivElement>(null);

    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [hovering, setHovering] = useState(false);

    const waveform = useMemo(() => buildWaveformBars(segments, 100), [segments]);

    useImperativeHandle(
      ref,
      () => ({
        seek: (ms: number) => {
          const v = videoRef.current;
          if (!v) return;
          v.currentTime = Math.max(0, ms / 1000);
        },
        play: () => {
          videoRef.current?.play().catch(() => {});
        },
        pause: () => {
          videoRef.current?.pause();
        },
        toggle: () => {
          const v = videoRef.current;
          if (!v) return;
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        },
        getCurrentMs: () => {
          const v = videoRef.current;
          return v ? Math.floor(v.currentTime * 1000) : 0;
        },
      }),
      []
    );

    const handleTimeUpdate = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      const ms = Math.floor(v.currentTime * 1000);
      setCurrentMs(ms);
      onTimeUpdate?.(ms);
    }, [onTimeUpdate]);

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const onLoaded = () => setDurationMs(Math.floor(v.duration * 1000));
      const onPlay = () => {
        setPlaying(true);
        onPlayChange?.(true);
      };
      const onPause = () => {
        setPlaying(false);
        onPlayChange?.(false);
      };
      v.addEventListener("loadedmetadata", onLoaded);
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      return () => {
        v.removeEventListener("loadedmetadata", onLoaded);
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
      };
    }, [onPlayChange]);

    useEffect(() => {
      const onFsChange = () => {
        setFullscreen(document.fullscreenElement === containerRef.current);
      };
      document.addEventListener("fullscreenchange", onFsChange);
      return () =>
        document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    function togglePlay() {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }

    function toggleMute() {
      const v = videoRef.current;
      if (!v) return;
      v.muted = !v.muted;
      setMuted(v.muted);
    }

    function handleVolume(e: React.ChangeEvent<HTMLInputElement>) {
      const v = videoRef.current;
      if (!v) return;
      const next = Number(e.target.value);
      v.volume = next;
      setVolume(next);
      if (next === 0) {
        v.muted = true;
        setMuted(true);
      } else if (v.muted) {
        v.muted = false;
        setMuted(false);
      }
    }

    async function toggleFullscreen() {
      if (!containerRef.current) return;
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      } else {
        await containerRef.current.requestFullscreen().catch(() => {});
      }
    }

    function handleScrubberClick(e: React.MouseEvent<HTMLDivElement>) {
      const v = videoRef.current;
      const scrubber = scrubberRef.current;
      if (!v || !scrubber || !durationMs) return;
      const rect = scrubber.getBoundingClientRect();
      const pct = Math.min(
        1,
        Math.max(0, (e.clientX - rect.left) / rect.width)
      );
      v.currentTime = (durationMs / 1000) * pct;
    }

    function handleScrubberKey(e: React.KeyboardEvent<HTMLDivElement>) {
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      } else if (e.key === "Home") {
        e.preventDefault();
        v.currentTime = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        v.currentTime = v.duration || 0;
      }
    }

    const progressPct =
      durationMs > 0 ? Math.min(100, (currentMs / durationMs) * 100) : 0;

    return (
      <div
        ref={containerRef}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          "surface relative overflow-hidden rounded-2xl",
          "focus-within:border-border-hover",
          className
        )}
      >
        <div className="relative aspect-video w-full bg-black">
          {src ? (
            <video
              ref={videoRef}
              src={src}
              poster={poster}
              onTimeUpdate={handleTimeUpdate}
              className="h-full w-full"
              onClick={togglePlay}
              playsInline
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-text-dim">
              Video is not available yet.
            </div>
          )}

          {src && (
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? "Pause video" : "Play video"}
              className={cn(
                "focus-ring absolute inset-0 m-auto flex h-20 w-20 items-center justify-center",
                "rounded-full bg-black/40 text-white backdrop-blur-md",
                "transition-opacity duration-200",
                playing && !hovering
                  ? "pointer-events-none opacity-0"
                  : "opacity-100"
              )}
            >
              {playing ? (
                <Pause className="h-8 w-8" strokeWidth={2.25} />
              ) : (
                <Play className="ml-1 h-8 w-8" strokeWidth={2.25} />
              )}
            </button>
          )}
        </div>

        <div className="flex flex-col gap-2.5 border-t border-border bg-bg-card px-4 py-3">
          <div
            ref={scrubberRef}
            role="slider"
            tabIndex={0}
            aria-label="Video timeline"
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={currentMs}
            aria-valuetext={formatTimecode(currentMs)}
            onClick={handleScrubberClick}
            onKeyDown={handleScrubberKey}
            className={cn(
              "focus-ring relative h-12 w-full cursor-pointer rounded-md",
              "group select-none"
            )}
          >
            <div className="absolute inset-0 flex items-center gap-[2px] px-0.5">
              {waveform.map((h, i) => {
                const barPct = ((i + 0.5) / waveform.length) * 100;
                const past = barPct <= progressPct;
                return (
                  <span
                    key={i}
                    className={cn(
                      "wave-bar flex-1 rounded-sm transition-colors",
                      past
                        ? "bg-accent"
                        : "bg-[color-mix(in_oklab,var(--border-hover)_80%,transparent)]"
                    )}
                    style={{
                      height: `${Math.max(14, Math.round(h * 100))}%`,
                    }}
                  />
                );
              })}
            </div>
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_25%,transparent)]"
              style={{ left: `${progressPct}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className={cn(
                  "focus-ring flex h-9 w-9 items-center justify-center rounded-md",
                  "text-text transition-colors hover:bg-bg-elev"
                )}
              >
                {playing ? (
                  <Pause className="h-4 w-4" strokeWidth={2.25} />
                ) : (
                  <Play className="h-4 w-4" strokeWidth={2.25} />
                )}
              </button>
              <div className="num-tab text-[13px] text-text-muted">
                <span className="text-text">{formatTimecode(currentMs)}</span>
                <span className="mx-1.5 text-text-dim">/</span>
                <span>{formatTimecode(durationMs)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute" : "Mute"}
                  className={cn(
                    "focus-ring flex h-9 w-9 items-center justify-center rounded-md",
                    "text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
                  )}
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" strokeWidth={2.25} />
                  ) : (
                    <Volume2 className="h-4 w-4" strokeWidth={2.25} />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={handleVolume}
                  aria-label="Volume"
                  className={cn(
                    "focus-ring h-1 w-20 cursor-pointer appearance-none rounded-full",
                    "bg-border accent-[var(--accent)]"
                  )}
                />
              </div>
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={
                  fullscreen ? "Exit fullscreen" : "Enter fullscreen"
                }
                className={cn(
                  "focus-ring flex h-9 w-9 items-center justify-center rounded-md",
                  "text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
                )}
              >
                {fullscreen ? (
                  <Minimize2 className="h-4 w-4" strokeWidth={2.25} />
                ) : (
                  <Maximize2 className="h-4 w-4" strokeWidth={2.25} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

export { VideoPlayer };
