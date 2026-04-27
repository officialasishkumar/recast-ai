"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe media query hook. Returns `false` on the server; subscribes on the
 * client and returns live `matches` state.
 *
 * Uses useSyncExternalStore so subscribe/snapshot follow the React 19 rules
 * for external systems (no setState in effect, no torn reads).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || !window.matchMedia) {
        return () => {};
      }
      const mql = window.matchMedia(query);
      const handler = () => notify();
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", handler);
        return () => mql.removeEventListener("change", handler);
      }
      mql.addListener(handler);
      return () => mql.removeListener(handler);
    },
    () => {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      return window.matchMedia(query).matches;
    },
    () => false,
  );
}
