"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media query hook. Returns `false` on the server; subscribes on the
 * client and returns live `matches` state.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (ev: MediaQueryListEvent) => setMatches(ev.matches);

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    // Safari <14 fallback.
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, [query]);

  return matches;
}
