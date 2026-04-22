"use client";

import * as React from "react";
import { CheckCircle2, XCircle, Info, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastVariant = "default" | "success" | "error" | "loading";

export interface ToastOptions {
  description?: string;
  duration?: number;
  id?: string;
}

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  description?: string;
  createdAt: number;
  duration: number;
}

type Subscriber = (toasts: ToastItem[]) => void;

const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 6000;
const LOADING_DURATION = Number.POSITIVE_INFINITY;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultDurationFor(variant: ToastVariant): number {
  if (variant === "error") return ERROR_DURATION;
  if (variant === "loading") return LOADING_DURATION;
  return DEFAULT_DURATION;
}

class ToastStore {
  private items: ToastItem[] = [];
  private subs = new Set<Subscriber>();

  getSnapshot = (): ToastItem[] => this.items;

  subscribe = (fn: Subscriber): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  private emit() {
    for (const s of this.subs) s(this.items);
  }

  add(
    variant: ToastVariant,
    message: string,
    options: ToastOptions = {}
  ): string {
    const id = options.id ?? makeId();
    const duration = options.duration ?? defaultDurationFor(variant);
    const existingIdx = this.items.findIndex((t) => t.id === id);
    const next: ToastItem = {
      id,
      variant,
      message,
      description: options.description,
      createdAt: Date.now(),
      duration,
    };
    if (existingIdx >= 0) {
      this.items = this.items.map((t, i) => (i === existingIdx ? next : t));
    } else {
      this.items = [...this.items, next];
    }
    this.emit();
    return id;
  }

  update(id: string, patch: Partial<Omit<ToastItem, "id" | "createdAt">>): void {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = this.items[idx];
    const merged: ToastItem = {
      ...prev,
      ...patch,
      id: prev.id,
      createdAt: Date.now(),
    };
    this.items = this.items.map((t, i) => (i === idx ? merged : t));
    this.emit();
  }

  dismiss(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length !== before) this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }
}

const store = new ToastStore();

function toastFn(message: string, options?: ToastOptions): string {
  return store.add("default", message, options);
}

interface ToastApi {
  (message: string, options?: ToastOptions): string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  loading: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  promise: <T>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((err: unknown) => string);
    },
    options?: Omit<ToastOptions, "id">
  ) => Promise<T>;
}

const toastApi = toastFn as ToastApi;

toastApi.success = (message, options) => store.add("success", message, options);
toastApi.error = (message, options) => store.add("error", message, options);
toastApi.loading = (message, options) => store.add("loading", message, options);
toastApi.dismiss = (id) => store.dismiss(id);
toastApi.clear = () => store.clear();
toastApi.promise = <T,>(
  promise: Promise<T>,
  messages: {
    loading: string;
    success: string | ((value: T) => string);
    error: string | ((err: unknown) => string);
  },
  options?: Omit<ToastOptions, "id">
): Promise<T> => {
  const id = store.add("loading", messages.loading, options);
  return promise.then(
    (value) => {
      const msg =
        typeof messages.success === "function"
          ? messages.success(value)
          : messages.success;
      store.update(id, {
        variant: "success",
        message: msg,
        description: undefined,
        duration: DEFAULT_DURATION,
      });
      return value;
    },
    (err: unknown) => {
      const msg =
        typeof messages.error === "function"
          ? messages.error(err)
          : messages.error;
      store.update(id, {
        variant: "error",
        message: msg,
        description: undefined,
        duration: ERROR_DURATION,
      });
      throw err;
    }
  );
};

export const toast = toastApi;

/* --------------------------------- UI ----------------------------------- */

function useToasts(): ToastItem[] {
  return React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => [] as ToastItem[]
  );
}

const VARIANT_STYLES: Record<
  ToastVariant,
  { accent: string; ariaLive: "polite" | "assertive"; role: "status" | "alert" }
> = {
  default: { accent: "bg-accent", ariaLive: "polite", role: "status" },
  success: { accent: "bg-success", ariaLive: "polite", role: "status" },
  error: { accent: "bg-danger", ariaLive: "assertive", role: "alert" },
  loading: { accent: "bg-accent", ariaLive: "polite", role: "status" },
};

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const className = "h-5 w-5 shrink-0";
  if (variant === "success") {
    return <CheckCircle2 className={cn(className, "text-success")} aria-hidden />;
  }
  if (variant === "error") {
    return <XCircle className={cn(className, "text-danger")} aria-hidden />;
  }
  if (variant === "loading") {
    return (
      <Loader2
        className={cn(className, "text-accent animate-spin")}
        aria-hidden
      />
    );
  }
  return <Info className={cn(className, "text-accent")} aria-hidden />;
}

interface ToastCardProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  paused: boolean;
}

function ToastCard({ toast, onDismiss, paused }: ToastCardProps) {
  const [visible, setVisible] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = React.useRef<number>(toast.duration);
  const startedAtRef = React.useRef<number>(Date.now());

  const variantCfg = VARIANT_STYLES[toast.variant];

  const beginExit = React.useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => {
      onDismiss(toast.id);
    }, 200);
  }, [onDismiss, toast.id]);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleDismiss = React.useCallback(
    (ms: number) => {
      clearTimer();
      if (!Number.isFinite(ms)) return;
      startedAtRef.current = Date.now();
      remainingRef.current = ms;
      timerRef.current = setTimeout(() => {
        beginExit();
      }, ms);
    },
    [beginExit, clearTimer]
  );

  // Mount animation.
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Reset lifecycle whenever duration / variant / message changes.
  React.useEffect(() => {
    remainingRef.current = toast.duration;
    if (paused) {
      clearTimer();
      return;
    }
    scheduleDismiss(toast.duration);
    return clearTimer;
  }, [toast.duration, toast.createdAt, paused, scheduleDismiss, clearTimer]);

  // Handle pause/resume.
  React.useEffect(() => {
    if (paused) {
      if (timerRef.current && Number.isFinite(remainingRef.current)) {
        const elapsed = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        clearTimer();
      }
      return;
    }
    if (Number.isFinite(remainingRef.current) && !timerRef.current) {
      scheduleDismiss(remainingRef.current);
    }
  }, [paused, scheduleDismiss, clearTimer]);

  return (
    <div
      role={variantCfg.role}
      aria-live={variantCfg.ariaLive}
      aria-atomic="true"
      className={cn(
        "toaster-item pointer-events-auto relative flex items-start gap-3 overflow-hidden",
        "rounded-xl border border-border bg-bg-card shadow-xl",
        "pr-3 pl-4 py-[14px] min-w-[280px] max-w-[420px]",
        "text-text"
      )}
      data-state={leaving ? "leaving" : visible ? "visible" : "initial"}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 h-full w-[3px]",
          variantCfg.accent
        )}
      />
      <VariantIcon variant={toast.variant} />
      <div className="min-w-0 flex-1 pt-[1px]">
        <p className="text-sm font-medium leading-5 text-text">
          {toast.message}
        </p>
        {toast.description ? (
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {toast.description}
          </p>
        ) : null}
      </div>
      {toast.variant !== "loading" ? (
        <button
          type="button"
          onClick={beginExit}
          aria-label="Dismiss notification"
          className={cn(
            "shrink-0 rounded-md p-1 text-text-dim",
            "hover:bg-bg-elev hover:text-text",
            "focus-ring transition-colors"
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts();
  const [hovered, setHovered] = React.useState(false);

  const handleDismiss = React.useCallback((id: string) => {
    store.dismiss(id);
  }, []);

  return (
    <>
      <style>{TOASTER_STYLES}</style>
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {toasts.map((t) => (
          <ToastCard
            key={t.id}
            toast={t}
            onDismiss={handleDismiss}
            paused={hovered}
          />
        ))}
      </div>
    </>
  );
}

const TOASTER_STYLES = `
.toaster-item {
  opacity: 0;
  transform: translateX(24px);
  transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1),
              transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}
.toaster-item[data-state="visible"] {
  opacity: 1;
  transform: translateX(0);
}
.toaster-item[data-state="leaving"] {
  opacity: 0;
  transform: translateX(24px);
}
@media (prefers-reduced-motion: reduce) {
  .toaster-item {
    transition-duration: 0ms !important;
    transform: none !important;
  }
}
`;
