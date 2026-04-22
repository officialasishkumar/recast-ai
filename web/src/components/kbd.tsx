import * as React from "react";
import { cn } from "@/lib/utils";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Keys to render. Supply either children OR `keys`. */
  keys?: string | string[];
  size?: "sm" | "md";
}

const KEY_GLYPHS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  mod: "⌘",
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  enter: "⏎",
  return: "⏎",
  esc: "Esc",
  escape: "Esc",
  tab: "⇥",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "⌫",
  delete: "⌦",
  space: "Space",
};

function glyph(token: string): string {
  const key = token.trim().toLowerCase();
  const mapped = KEY_GLYPHS[key];
  if (mapped) return mapped;
  if (token.length === 1) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function parseKeys(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input.join(" ") : input;
  // Keep "+" as a literal key when it's the only character.
  if (raw.trim() === "+") return ["+"];
  // Sequences use spaces; combos use +. Treat both uniformly: split both.
  return raw
    .split(/\s+/)
    .flatMap((chunk) => (chunk === "+" ? [chunk] : chunk.split("+")))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const sizeStyles = {
  sm: "min-w-[1.25rem] h-[1.25rem] text-[0.6875rem] px-1",
  md: "min-w-[1.5rem] h-[1.5rem] text-xs px-1.5",
} as const;

export function Kbd({
  keys,
  size = "md",
  className,
  children,
  ...props
}: KbdProps) {
  const tokens = React.useMemo(() => {
    if (children !== undefined) return null;
    if (keys === undefined) return [];
    return parseKeys(keys);
  }, [children, keys]);

  const baseKey = cn(
    "inline-flex items-center justify-center rounded-md font-mono font-medium",
    "bg-bg-elev border border-border text-text-muted",
    "shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_1px_0_0_rgba(0,0,0,0.35)]",
    "select-none",
    sizeStyles[size]
  );

  if (tokens === null || children !== undefined) {
    return (
      <kbd
        className={cn(baseKey, className)}
        aria-label={typeof children === "string" ? children : undefined}
        {...props}
      >
        {children}
      </kbd>
    );
  }

  return (
    <span
      role="group"
      aria-label={tokens.join(" then ")}
      className={cn("inline-flex items-center gap-1 align-middle", className)}
      {...props}
    >
      {tokens.map((token, i) => (
        <kbd key={`${token}-${i}`} className={baseKey}>
          {glyph(token)}
        </kbd>
      ))}
    </span>
  );
}

Kbd.displayName = "Kbd";
