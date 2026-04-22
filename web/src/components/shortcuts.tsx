"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Kbd } from "@/components/kbd";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

export interface RegisteredShortcut {
  id: string;
  combo: string;
  description: string;
  section?: string;
}

interface ShortcutsRegistryContextValue {
  register: (shortcut: RegisteredShortcut) => void;
  unregister: (id: string) => void;
  getAll: () => RegisteredShortcut[];
}

export const ShortcutsRegistryContext =
  React.createContext<ShortcutsRegistryContextValue | null>(null);

interface OverlayContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const ShortcutsOverlayContext = React.createContext<OverlayContextValue | null>(
  null
);

interface ShortcutsStateContextValue {
  shortcuts: RegisteredShortcut[];
}

const ShortcutsStateContext =
  React.createContext<ShortcutsStateContextValue | null>(null);

/* --------------------------- Provider ----------------------------------- */

export interface ShortcutsProviderProps {
  children: React.ReactNode;
}

export function ShortcutsProvider({ children }: ShortcutsProviderProps) {
  const [shortcuts, setShortcuts] = React.useState<RegisteredShortcut[]>([]);
  const [open, setOpenState] = React.useState(false);

  const registryRef = React.useRef<RegisteredShortcut[]>([]);

  const register = React.useCallback((shortcut: RegisteredShortcut) => {
    const existing = registryRef.current.findIndex((s) => s.id === shortcut.id);
    if (existing >= 0) {
      registryRef.current = registryRef.current.map((s, i) =>
        i === existing ? shortcut : s
      );
    } else {
      registryRef.current = [...registryRef.current, shortcut];
    }
    setShortcuts(registryRef.current);
  }, []);

  const unregister = React.useCallback((id: string) => {
    const before = registryRef.current.length;
    registryRef.current = registryRef.current.filter((s) => s.id !== id);
    if (registryRef.current.length !== before) {
      setShortcuts(registryRef.current);
    }
  }, []);

  const getAll = React.useCallback(() => registryRef.current, []);

  const registryValue = React.useMemo<ShortcutsRegistryContextValue>(
    () => ({ register, unregister, getAll }),
    [register, unregister, getAll]
  );

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
  }, []);

  const toggle = React.useCallback(() => {
    setOpenState((v) => !v);
  }, []);

  const overlayValue = React.useMemo<OverlayContextValue>(
    () => ({ open, setOpen, toggle }),
    [open, setOpen, toggle]
  );

  const stateValue = React.useMemo<ShortcutsStateContextValue>(
    () => ({ shortcuts }),
    [shortcuts]
  );

  return (
    <ShortcutsRegistryContext.Provider value={registryValue}>
      <ShortcutsOverlayContext.Provider value={overlayValue}>
        <ShortcutsStateContext.Provider value={stateValue}>
          {children}
        </ShortcutsStateContext.Provider>
      </ShortcutsOverlayContext.Provider>
    </ShortcutsRegistryContext.Provider>
  );
}

/* ---------------------------- Hook -------------------------------------- */

export function useRegisterShortcut(
  keys: string,
  description: string,
  section?: string
): void {
  const registry = React.useContext(ShortcutsRegistryContext);
  const id = React.useId();

  React.useEffect(() => {
    if (!registry) return;
    registry.register({ id, combo: keys, description, section });
    return () => registry.unregister(id);
  }, [registry, id, keys, description, section]);
}

/* ---------------------------- Overlay ----------------------------------- */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  ) {
    return true;
  }
  return target.isContentEditable;
}

export function ShortcutsOverlay() {
  const overlay = React.useContext(ShortcutsOverlayContext);
  const state = React.useContext(ShortcutsStateContext);
  const [mounted, setMounted] = React.useState(false);
  const closeBtnRef = React.useRef<HTMLButtonElement>(null);
  const prevFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => setMounted(true), []);

  const open = overlay?.open ?? false;
  const setOpen = overlay?.setOpen;
  const toggle = overlay?.toggle;

  // Global "?" listener (Shift + /).
  React.useEffect(() => {
    if (!toggle) return;
    const listener = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && open) {
        ev.preventDefault();
        setOpen?.(false);
        return;
      }
      if (ev.key !== "?" && !(ev.key === "/" && ev.shiftKey)) return;
      if (!open && isTypingTarget(ev.target)) return;
      ev.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open, setOpen, toggle]);

  // Focus management.
  React.useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      prevFocusRef.current?.focus?.();
    };
  }, [open]);

  const shortcuts = state?.shortcuts ?? [];

  const grouped = React.useMemo(() => {
    const bySection = new Map<string, RegisteredShortcut[]>();
    for (const s of shortcuts) {
      const sec = s.section ?? "General";
      const list = bySection.get(sec) ?? [];
      list.push(s);
      bySection.set(sec, list);
    }
    return Array.from(bySection.entries()).sort(([a], [b]) => {
      if (a === "General") return -1;
      if (b === "General") return 1;
      return a.localeCompare(b);
    });
  }, [shortcuts]);

  if (!mounted || !open) {
    return <style>{OVERLAY_STYLES}</style>;
  }

  const content = (
    <div
      aria-hidden={!open}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
    >
      <div
        className="shortcuts-overlay-backdrop absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen?.(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className={cn(
          "shortcuts-overlay-panel relative w-full max-w-2xl",
          "rounded-2xl border border-border bg-bg-card shadow-2xl",
          "max-h-[80vh] overflow-hidden flex flex-col"
        )}
      >
        <header className="flex items-center justify-between gap-4 px-6 pt-5 pb-4 border-b border-border">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold text-text">
              Keyboard shortcuts
            </h2>
            <p className="text-xs text-text-muted">
              Press <Kbd keys="?" size="sm" /> anytime to toggle this panel.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={() => setOpen?.(false)}
            aria-label="Close shortcuts"
            className={cn(
              "rounded-md p-1.5 text-text-muted",
              "hover:bg-bg-elev hover:text-text",
              "focus-ring transition-colors"
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {grouped.length === 0 ? (
            <p className="text-sm text-text-muted">
              No shortcuts registered yet.
            </p>
          ) : (
            <div className="flex flex-col gap-6">
              {grouped.map(([section, items]) => (
                <section key={section} className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-dim">
                    {section}
                  </h3>
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-elev/40">
                    {items.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-4 px-4 py-2.5"
                      >
                        <span className="text-sm text-text">
                          {s.description}
                        </span>
                        <Kbd keys={s.combo} size="sm" />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <style>{OVERLAY_STYLES}</style>
      {createPortal(content, document.body)}
    </>
  );
}

/* ----------------------------- Hint ------------------------------------- */

export function ShortcutHint() {
  const overlay = React.useContext(ShortcutsOverlayContext);
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (isMobile || overlay?.open) return null;

  return (
    <button
      type="button"
      onClick={() => overlay?.setOpen(true)}
      aria-label="Show keyboard shortcuts"
      className={cn(
        "fixed bottom-6 left-6 z-40",
        "inline-flex items-center gap-2 rounded-full",
        "border border-border bg-bg-card/80 backdrop-blur-md",
        "px-3 py-1.5 text-xs text-text-muted",
        "shadow-md hover:border-border-hover hover:text-text",
        "focus-ring transition-colors",
        "shortcut-hint"
      )}
    >
      <span>Press</span>
      <Kbd keys="?" size="sm" />
      <span>for shortcuts</span>
    </button>
  );
}

const OVERLAY_STYLES = `
.shortcuts-overlay-backdrop {
  animation: shortcuts-backdrop-in 160ms ease-out;
}
.shortcuts-overlay-panel {
  animation: shortcuts-panel-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.shortcut-hint {
  animation: shortcuts-hint-in 220ms ease-out;
}
@keyframes shortcuts-backdrop-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes shortcuts-panel-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes shortcuts-hint-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .shortcuts-overlay-backdrop,
  .shortcuts-overlay-panel,
  .shortcut-hint {
    animation: none !important;
  }
}
`;
