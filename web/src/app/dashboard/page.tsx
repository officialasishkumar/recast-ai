"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines,
  ChevronDown,
  LayoutGrid,
  List as ListIcon,
  Plus,
  Search,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JobCard } from "@/components/job-card";
import { UploadModal } from "@/components/upload-modal";
import { cn } from "@/lib/utils";
import {
  deleteJob as apiDeleteJob,
  getJobs,
  type Job,
  type JobStage,
} from "@/lib/api";

type ViewMode = "grid" | "list";

type StatusFilter = "all" | "processing" | "completed" | "failed";

const NON_TERMINAL_STAGES: readonly JobStage[] = [
  "uploaded",
  "analyzing",
  "transcribed",
  "synthesizing",
  "muxing",
];

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function lastUpdatedLabel(jobs: Job[]): string | null {
  if (jobs.length === 0) return null;
  const latest = jobs.reduce((acc, j) => {
    const t = new Date(j.updated_at || j.created_at).getTime();
    return t > acc ? t : acc;
  }, 0);
  if (!latest) return null;
  const diff = Date.now() - latest;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  return `${days} d ago`;
}

function bucketFor(stage: JobStage): StatusFilter {
  if (stage === "completed") return "completed";
  if (stage === "failed") return "failed";
  return "processing";
}

function SkeletonCard() {
  return (
    <div className="surface overflow-hidden rounded-2xl" aria-hidden="true">
      <div className="relative aspect-video w-full overflow-hidden bg-bg-elev">
        <div
          className={cn(
            "absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,color-mix(in_oklab,var(--border)_60%,transparent)_50%,transparent_100%)]",
            "bg-[length:200%_100%] [animation:shimmer_1.8s_linear_infinite]"
          )}
        />
      </div>
      <div className="flex flex-col gap-3 p-5">
        <div className="h-4 w-3/4 rounded-md bg-bg-elev" />
        <div className="h-3 w-1/2 rounded-md bg-bg-elev" />
        <div className="mt-4 flex items-center justify-between">
          <div className="h-3 w-24 rounded-md bg-bg-elev" />
          <div className="h-5 w-16 rounded-full bg-bg-elev" />
        </div>
      </div>
    </div>
  );
}

interface StatusFilterMenuProps {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}

function StatusFilterMenu({ value, onChange }: StatusFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const active = FILTER_OPTIONS.find((o) => o.value === value) ?? FILTER_OPTIONS[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "focus-ring inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-bg-card",
          "px-3.5 text-sm font-medium text-text transition-colors hover:border-border-hover"
        )}
      >
        <span className="text-text-muted">Status:</span>
        {active.label}
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl",
            "surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)] animate-fade-in"
          )}
        >
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between px-4 py-2 text-sm transition-colors",
                opt.value === value
                  ? "bg-bg-elev text-text"
                  : "text-text-muted hover:bg-bg-elev hover:text-text"
              )}
            >
              {opt.label}
              {opt.value === value ? (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ViewToggleProps {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
}

function ViewToggle({ value, onChange }: ViewToggleProps) {
  const base =
    "flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-ring";
  return (
    <div
      role="group"
      aria-label="View mode"
      className="flex h-11 items-center gap-1 rounded-lg border border-border bg-bg-card p-1"
    >
      <button
        type="button"
        aria-pressed={value === "grid"}
        aria-label="Grid view"
        onClick={() => onChange("grid")}
        className={cn(
          base,
          value === "grid"
            ? "bg-bg-elev text-text"
            : "text-text-muted hover:text-text"
        )}
      >
        <LayoutGrid className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-pressed={value === "list"}
        aria-label="List view"
        onClick={() => onChange("list")}
        className={cn(
          base,
          value === "list"
            ? "bg-bg-elev text-text"
            : "text-text-muted hover:text-text"
        )}
      >
        <ListIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchJobs = useCallback(async () => {
    try {
      const data = await getJobs();
      setJobs(data);
    } catch {
      // 401 handled by the api client
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!localStorage.getItem("token")) {
      router.push("/login");
      return;
    }
    setLoading(true);
    fetchJobs().finally(() => setLoading(false));
  }, [fetchJobs, router]);

  // Polite auto-refresh while any job is non-terminal.
  const hasActiveJob = useMemo(
    () => jobs.some((j) => NON_TERMINAL_STAGES.includes(j.status)),
    [jobs]
  );

  useEffect(() => {
    if (!hasActiveJob) return;
    const handle = window.setInterval(() => {
      void fetchJobs();
    }, 15_000);
    return () => window.clearInterval(handle);
  }, [hasActiveJob, fetchJobs]);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter !== "all" && bucketFor(job.status) !== statusFilter) {
        return false;
      }
      if (q.length > 0) {
        const name = (job.name || "").toLowerCase();
        if (!name.includes(q)) return false;
      }
      return true;
    });
  }, [jobs, query, statusFilter]);

  // Prune selections that no longer exist after refresh.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(jobs.map((j) => j.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [jobs]);

  function toggleSelect(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this project? This cannot be undone.")) return;
    try {
      await apiDeleteJob(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    } catch {
      // swallow
    }
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    const count = selected.size;
    if (
      !window.confirm(
        `Delete ${count} project${count === 1 ? "" : "s"}? This cannot be undone.`
      )
    ) {
      return;
    }
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => apiDeleteJob(id)));
    const deleted = new Set(
      ids.filter((_, i) => results[i].status === "fulfilled")
    );
    setJobs((prev) => prev.filter((j) => !deleted.has(j.id)));
    setSelected(new Set());
  }

  async function handleBulkShare() {
    if (selected.size === 0) return;
    try {
      const api = (await import("@/lib/api")) as unknown as {
        shareJob?: (id: string) => Promise<{ url?: string; share_token?: string }>;
      };
      if (typeof api.shareJob !== "function") return;
      await Promise.allSettled(
        Array.from(selected).map((id) => api.shareJob!(id))
      );
    } catch {
      // swallow
    }
  }

  async function handleShare(id: string) {
    try {
      const api = (await import("@/lib/api")) as unknown as {
        shareJob?: (id: string) => Promise<{ url?: string; share_token?: string }>;
      };
      if (typeof api.shareJob !== "function") return;
      const res = await api.shareJob(id);
      if (res?.url && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(res.url);
      }
    } catch {
      // swallow
    }
  }

  async function handleDownload(id: string) {
    try {
      const api = (await import("@/lib/api")) as unknown as {
        exportJob?: (id: string) => Promise<{ url: string }>;
      };
      if (typeof api.exportJob !== "function") return;
      const res = await api.exportJob(id);
      if (res?.url && typeof window !== "undefined") {
        window.open(res.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      // swallow
    }
  }

  function handleSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && query.length > 0) {
      e.preventDefault();
      setQuery("");
    }
  }

  const count = jobs.length;
  const updatedLabel = lastUpdatedLabel(jobs);
  const showEmpty = !loading && filteredJobs.length === 0;
  const showEmptyNoJobs = showEmpty && count === 0;
  const gridClasses =
    view === "grid"
      ? "grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"
      : "flex flex-col gap-3";

  return (
    <div className="mx-auto w-full max-w-[1240px] px-5 py-12 sm:px-8">
      {/* Hero */}
      <section className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="type-h1 text-text">Your videos</h1>
          <p className="mt-3 type-meta">
            {count === 0
              ? "No projects yet"
              : `${count} project${count === 1 ? "" : "s"}`}
            {updatedLabel ? <span> &middot; last updated {updatedLabel}</span> : null}
          </p>
        </div>
        <Button size="lg" onClick={() => setUploadOpen(true)}>
          <Plus className="h-5 w-5" aria-hidden="true" />
          New project
        </Button>
      </section>

      {/* Sub-header */}
      <section className="mt-10 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            placeholder="Search by name…"
            aria-label="Search projects"
            className="pl-10 pr-10"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="focus-ring absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <StatusFilterMenu value={statusFilter} onChange={setStatusFilter} />
        <ViewToggle value={view} onChange={setView} />
      </section>

      {/* Main content */}
      <section className="mt-8 pb-32">
        {loading ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : showEmptyNoJobs ? (
          <EmptyState onCreate={() => setUploadOpen(true)} />
        ) : showEmpty ? (
          <NoMatches
            onClear={() => {
              setQuery("");
              setStatusFilter("all");
            }}
          />
        ) : (
          <div className={gridClasses}>
            {filteredJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                variant={view}
                selected={selected.has(job.id)}
                onToggleSelect={toggleSelect}
                onDelete={handleDelete}
                onShare={handleShare}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}
      </section>

      {/* Bulk action bar */}
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className={cn(
            "fixed inset-x-0 bottom-6 z-40 mx-auto flex w-fit items-center gap-3 rounded-2xl",
            "glass px-4 py-3 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.75)] animate-fade-in"
          )}
        >
          <span className="type-meta pr-2 text-text">
            {selected.size} selected
          </span>
          <Button variant="secondary" size="sm" onClick={handleBulkShare}>
            <Share2 className="h-4 w-4" aria-hidden="true" />
            Share selected
          </Button>
          <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete selected
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="focus-ring ml-1 flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onCreated={() => {
          setUploadOpen(false);
          void fetchJobs();
        }}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "surface flex w-full max-w-xl flex-col items-center gap-5 rounded-[24px] px-8 py-14 text-center",
          "animate-fade-in"
        )}
      >
        <div
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-2xl",
            "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-accent",
            "ring-1 ring-[color-mix(in_oklab,var(--accent)_28%,transparent)]"
          )}
          aria-hidden="true"
        >
          <AudioLines className="h-7 w-7" />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="type-h2 text-text">No projects yet</h2>
          <p className="type-body max-w-md text-text-muted">
            Upload a video and Recast will generate a clean, AI-voiced narration in
            minutes.
          </p>
        </div>
        <Button size="lg" onClick={onCreate}>
          <Plus className="h-5 w-5" aria-hidden="true" />
          Create your first video
        </Button>
      </div>
    </div>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex justify-center">
      <div className="surface flex max-w-md flex-col items-center gap-4 rounded-[20px] px-8 py-12 text-center">
        <h2 className="type-h3 text-text">No matching projects</h2>
        <p className="type-body text-text-muted">
          Try clearing the filter or using different search terms.
        </p>
        <Button variant="secondary" size="md" onClick={onClear}>
          Reset filters
        </Button>
      </div>
    </div>
  );
}
