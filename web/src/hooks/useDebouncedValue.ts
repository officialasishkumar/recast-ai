"use client";

import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delayMs`
 * milliseconds have elapsed without a change. When `delayMs <= 0` the
 * debounced value tracks the input synchronously by deriving from props
 * during render.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  // When debounce is disabled, return the live value directly.
  return delayMs <= 0 ? value : debounced;
}
