"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  Clock,
  Download,
  ExternalLink,
  Mic2,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Job, JobStage } from "@/lib/api";

type ExtendedJob = Job & {
  thumbnail_path?: string | null;
  voice_name?: string | null;
  duration_ms?: number;
};

type CardVariant = "grid" | "list";

interface JobCardProps {
  job: ExtendedJob;
  variant?: CardVariant;
  selected?: boolean;
  onToggleSelect?: (id: string, next: boolean) => void;
  onDelete?: (id: string) => void;
  onShare?: (id: string) => void;
  onDownload?: (id: string) => void;
}

const IN_PROGRESS_STAGES: readonly JobStage[] = [
  "analyzing",
  "transcribed",
  "synthesizing",
  "muxing",
];

const STAGE_LABEL: Record<JobStage, string> = {
  uploaded: "Pending",
  analyzing: "Analyzing",
  transcribed: "Transcribed",
  synthesizing: "Synthesizing",
  muxing: "Muxing",
  completed: "Completed",
  failed: "Failed",
};

function stageVariant(
  stage: JobStage
): "success" | "danger" | "info" | "default" {
  if (stage === "completed") return "success";
  if (stage === "failed") return "danger";
  if (IN_PROGRESS_STAGES.includes(stage)) return "info";
  return "default";
}

function isInProgress(stage: JobStage): boolean {
  return IN_PROGRESS_STAGES.includes(stage);
}

function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || seconds <= 0) return "–:––";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function gradientFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 55) % 360;
  return `linear-gradient(135deg, hsl(${h1} 55% 18%) 0%, hsl(${h2} 60% 32%) 100%)`;
}

async function resolveThumbnail(
  jobId: string,
  thumbnailPath: string | null | undefined
): Promise<string | null> {
  if (!thumbnailPath) return null;
  try {
    // A-fe-share-api will expose this helper from @/lib/api.
    const api = (await import("@/lib/api")) as unknown as {
      getThumbnailUrl?: (id: string) => Promise<string> | string;
    };
    if (typeof api.getThumbnailUrl === "function") {
      const url = await api.getThumbnailUrl(jobId);
      return typeof url === "string" && url.length > 0 ? url : null;
    }
  } catch {
    // fall through
  }
  return null;
}

interface DropdownProps {
  jobId: string;
  onClose: () => void;
  onOpen: () => void;
  onShare?: (id: string) => void;
  onDownload?: (id: string) => void;
  onDelete?: (id: string) => void;
}

function ActionDropdown({
  jobId,
  onClose,
  onOpen,
  onShare,
  onDownload,
  onDelete,
}: DropdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  function stop<T extends MouseEvent>(e: T) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={rootRef}
      role="menu"
      className={cn(
        "absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl",
        "surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)]",
        "animate-fade-in"
      )}
      onClick={stop}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-3 px-4 py-2 text-sm text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
        onClick={(e) => {
          stop(e);
          onOpen();
          onClose();
        }}
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-3 px-4 py-2 text-sm text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
        onClick={(e) => {
          stop(e);
          onShare?.(jobId);
          onClose();
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        Share
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-3 px-4 py-2 text-sm text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
        onClick={(e) => {
          stop(e);
          onDownload?.(jobId);
          onClose();
        }}
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Download
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-3 border-t border-border px-4 py-2 text-sm text-danger transition-colors hover:bg-bg-elev"
        onClick={(e) => {
          stop(e);
          onDelete?.(jobId);
          onClose();
        }}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        Delete
      </button>
    </div>
  );
}

interface ThumbnailProps {
  job: ExtendedJob;
  variant: CardVariant;
}

function Thumbnail({ job, variant }: ThumbnailProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!job.thumbnail_path) {
      setSrc(null);
      return;
    }
    resolveThumbnail(job.id, job.thumbnail_path).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [job.id, job.thumbnail_path]);

  const showImage = src && !failed;
  const seconds =
    typeof job.duration === "number"
      ? job.duration
      : job.duration_ms
        ? job.duration_ms / 1000
        : 0;

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        variant === "grid"
          ? "aspect-video w-full rounded-t-2xl"
          : "h-[68px] w-[120px] shrink-0 rounded-lg"
      )}
      style={showImage ? undefined : { background: gradientFor(job.id) }}
      aria-hidden={variant === "list" ? undefined : "true"}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-9 w-9 rounded-full bg-black/30 backdrop-blur-sm ring-1 ring-white/10" />
        </div>
      )}
      {seconds > 0 && (
        <span
          className={cn(
            "absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5",
            "text-[11px] font-medium tabular-nums text-white backdrop-blur-sm"
          )}
        >
          {formatDuration(seconds)}
        </span>
      )}
    </div>
  );
}

export function JobCard({
  job,
  variant = "grid",
  selected = false,
  onToggleSelect,
  onDelete,
  onShare,
  onDownload,
}: JobCardProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const stage = job.status;
  const variantBadge = stageVariant(stage);
  const inProgress = isInProgress(stage);
  const title = job.name || "Untitled project";

  function openJob() {
    router.push(`/jobs/${job.id}`);
  }

  function handleCardKey(e: KeyboardEvent<HTMLElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openJob();
    }
  }

  function handleCheckboxClick(e: MouseEvent<HTMLInputElement>) {
    e.stopPropagation();
  }

  function handleCheckboxChange(next: boolean) {
    onToggleSelect?.(job.id, next);
  }

  function handleMenuToggle(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }

  const checkbox = (
    <label
      className={cn(
        "absolute left-3 top-3 z-10 flex h-7 w-7 items-center justify-center",
        "rounded-md border border-border bg-bg/80 backdrop-blur-md transition-opacity",
        selected
          ? "opacity-100 border-accent bg-accent/20"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onClick={handleCheckboxClick}
        onChange={(e) => handleCheckboxChange(e.target.checked)}
        aria-label={`Select ${title}`}
        className="peer h-4 w-4 cursor-pointer accent-accent"
      />
    </label>
  );

  const stageDot = inProgress ? (
    <span
      className="relative mr-1 inline-flex h-1.5 w-1.5"
      aria-hidden="true"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
    </span>
  ) : null;

  const badge = (
    <Badge variant={variantBadge} className="shrink-0">
      {stageDot}
      {STAGE_LABEL[stage]}
    </Badge>
  );

  const meta = (
    <div className="flex items-center gap-3 text-[13px] text-text-muted">
      <span className="inline-flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
        {relativeTime(job.created_at)}
      </span>
      {job.voice_name ? (
        <span className="inline-flex items-center gap-1.5">
          <Mic2 className="h-3.5 w-3.5" aria-hidden="true" />
          {job.voice_name}
        </span>
      ) : null}
    </div>
  );

  const menuButton = (
    <div className="relative">
      <button
        type="button"
        onClick={handleMenuToggle}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
        className={cn(
          "focus-ring flex h-8 w-8 items-center justify-center rounded-lg",
          "text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
        )}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {menuOpen ? (
        <ActionDropdown
          jobId={job.id}
          onOpen={openJob}
          onClose={() => setMenuOpen(false)}
          onShare={onShare}
          onDownload={onDownload}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );

  if (variant === "list") {
    return (
      <article
        role="button"
        tabIndex={0}
        aria-label={`Open ${title}`}
        onClick={openJob}
        onKeyDown={handleCardKey}
        className={cn(
          "group relative flex cursor-pointer items-center gap-4 rounded-2xl surface p-3 transition-colors",
          "hover:border-border-hover focus-ring",
          selected && "border-accent ring-1 ring-accent/40"
        )}
      >
        {checkbox}
        <Thumbnail job={job} variant="list" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h3 className="truncate text-[17px] font-semibold leading-snug text-text">
              {title}
            </h3>
            {badge}
          </div>
          <div className="mt-1.5">{meta}</div>
        </div>
        <div
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {menuButton}
        </div>
      </article>
    );
  }

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
      onClick={openJob}
      onKeyDown={handleCardKey}
      className={cn(
        "group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl surface transition-all",
        "hover:border-border-hover hover:shadow-[0_24px_70px_-30px_rgba(0,0,0,0.7)] focus-ring",
        selected && "border-accent ring-1 ring-accent/40"
      )}
    >
      {checkbox}
      <Thumbnail job={job} variant="grid" />
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <h3
            className="line-clamp-2 text-[18px] font-semibold leading-[1.3] text-text"
          >
            {title}
          </h3>
          {badge}
        </div>
        <div className="mt-auto flex items-end justify-between gap-3">
          {meta}
          <div
            className="shrink-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {menuButton}
          </div>
        </div>
      </div>
    </article>
  );
}
