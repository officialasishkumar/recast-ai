"use client";

import { useContext, useEffect, useId, useRef } from "react";
import {
  ShortcutsRegistryContext,
  type RegisteredShortcut,
} from "@/components/shortcuts";
import { parseCombo } from "./useKeyboardShortcut";

export interface UseHotkeyOptions {
  section?: string;
  enabled?: boolean;
  preventDefault?: boolean;
}

/**
 * Register a higher-level hotkey. Supports single combos ("cmd+k") and
 * space-separated sequences ("g d") that must be pressed in order.
 *
 * The registration is broadcast to the `ShortcutsProvider` so the help
 * overlay can list every active binding.
 */
export function useHotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  description: string,
  options: UseHotkeyOptions = {}
): void {
  const { section = "General", enabled = true, preventDefault = true } = options;
  const registry = useContext(ShortcutsRegistryContext);
  const id = useId();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // Register with overlay registry.
  useEffect(() => {
    if (!registry || !enabled) return;
    const entry: RegisteredShortcut = {
      id,
      combo,
      description,
      section,
    };
    registry.register(entry);
    return () => registry.unregister(id);
  }, [registry, id, combo, description, section, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    // Treat space-separated tokens as a sequence (e.g. "g d").
    const rawTokens = combo
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const isSequence = rawTokens.length > 1;

    if (!isSequence) {
      const parsed = parseCombo(rawTokens[0] ?? combo);
      const listener = (ev: KeyboardEvent) => {
        if (shouldSkipTarget(ev)) return;
        if (matchesCombo(ev, parsed)) {
          if (preventDefault) ev.preventDefault();
          handlerRef.current(ev);
        }
      };
      window.addEventListener("keydown", listener);
      return () => window.removeEventListener("keydown", listener);
    }

    const parsedSequence = rawTokens.map((t) => parseCombo(t));
    let progress = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const clearProgress = () => {
      progress = 0;
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
    };

    const listener = (ev: KeyboardEvent) => {
      if (shouldSkipTarget(ev)) return;
      // Ignore modifier-only keydowns.
      if (["Control", "Meta", "Shift", "Alt"].includes(ev.key)) return;

      const expected = parsedSequence[progress];
      if (expected && matchesCombo(ev, expected)) {
        if (preventDefault) ev.preventDefault();
        progress += 1;
        if (progress >= parsedSequence.length) {
          clearProgress();
          handlerRef.current(ev);
          return;
        }
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(clearProgress, 1200);
        return;
      }
      clearProgress();
    };

    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      clearProgress();
    };
  }, [combo, enabled, preventDefault]);
}

function shouldSkipTarget(ev: KeyboardEvent): boolean {
  const el = ev.target;
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    return !ev.ctrlKey && !ev.metaKey;
  }
  if (el.isContentEditable) return true;
  return false;
}

function matchesCombo(
  ev: KeyboardEvent,
  combo: { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }
): boolean {
  const eventKey = (ev.key ?? "").toLowerCase();
  if (eventKey !== combo.key) return false;
  if (combo.ctrl !== ev.ctrlKey) return false;
  if (combo.meta !== ev.metaKey) return false;
  if (combo.alt !== ev.altKey) return false;
  if (combo.key.length === 1 && /[^a-z0-9]/i.test(combo.key)) {
    return true;
  }
  return combo.shift === ev.shiftKey;
}
