"use client";

import { useEffect, useRef } from "react";

type ModifierKey = "ctrl" | "meta" | "alt" | "shift";

interface ParsedCombo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface UseKeyboardShortcutOptions {
  enabled?: boolean;
  preventDefault?: boolean;
  target?: HTMLElement | Window | Document | null;
}

const MODIFIERS: readonly ModifierKey[] = ["ctrl", "meta", "alt", "shift"];

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function normalizeKey(token: string): string {
  const t = token.trim().toLowerCase();
  if (t === "esc") return "escape";
  if (t === "space" || t === "spacebar") return " ";
  if (t === "plus") return "+";
  if (t === "return") return "enter";
  return t;
}

/**
 * Parse a combo like "cmd+s", "ctrl+k", "shift+/", "?".
 * `cmd` maps to meta on mac, ctrl elsewhere.
 * `mod` behaves identically to `cmd`.
 */
export function parseCombo(combo: string): ParsedCombo {
  const raw = combo.trim();
  // Special case: single-char combos including "+" itself.
  const tokens =
    raw === "+"
      ? ["+"]
      : raw.split("+").map((t) => t.trim()).filter((t) => t.length > 0);

  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let key = "";

  const mac = isMac();

  for (const token of tokens) {
    const norm = token.toLowerCase();
    if (norm === "ctrl" || norm === "control") {
      ctrl = true;
    } else if (norm === "meta" || norm === "cmd" || norm === "command") {
      if (mac) meta = true;
      else ctrl = true;
    } else if (norm === "mod") {
      if (mac) meta = true;
      else ctrl = true;
    } else if (norm === "alt" || norm === "option" || norm === "opt") {
      alt = true;
    } else if (norm === "shift") {
      shift = true;
    } else {
      key = normalizeKey(token);
    }
  }

  return { key, ctrl, meta, alt, shift };
}

function matches(e: KeyboardEvent, combo: ParsedCombo): boolean {
  const eventKey = (e.key ?? "").toLowerCase();
  if (eventKey !== combo.key) return false;
  if (combo.ctrl !== e.ctrlKey) return false;
  if (combo.meta !== e.metaKey) return false;
  if (combo.alt !== e.altKey) return false;
  // Shift is tricky for printable keys (e.g. "?" already implies shift).
  // Only enforce shift matching when the key isn't a printable special character.
  if (combo.key.length === 1 && /[^a-z0-9]/i.test(combo.key)) {
    // Allow either state for symbolic keys.
  } else if (combo.shift !== e.shiftKey) {
    return false;
  }
  return true;
}

function isTypingElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcut(
  keys: string | string[],
  handler: (e: KeyboardEvent) => void,
  options: UseKeyboardShortcutOptions = {}
): void {
  const { enabled = true, preventDefault = true, target } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const combos = (Array.isArray(keys) ? keys : [keys]).map(parseCombo);

    const listener = (e: Event) => {
      const kb = e as KeyboardEvent;
      // Skip shortcuts while typing unless the shortcut uses a modifier.
      const hasModifier = combos.some(
        (c) => c.ctrl || c.meta || c.alt
      );
      if (isTypingElement(kb.target) && !hasModifier) return;

      for (const combo of combos) {
        if (matches(kb, combo)) {
          if (preventDefault) kb.preventDefault();
          handlerRef.current(kb);
          return;
        }
      }
    };

    const bindTarget: EventTarget =
      target ?? (typeof window !== "undefined" ? window : ({} as EventTarget));
    bindTarget.addEventListener("keydown", listener);
    return () => bindTarget.removeEventListener("keydown", listener);
  }, [Array.isArray(keys) ? keys.join("|") : keys, enabled, preventDefault, target]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const modifiers = MODIFIERS;
