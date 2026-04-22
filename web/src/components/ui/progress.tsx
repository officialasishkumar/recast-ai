import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  variant?: "soft" | "bold";
}

function Progress({
  value,
  max = 100,
  variant = "soft",
  className,
  ...props
}: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const indeterminate = Number.isNaN(value);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full",
        variant === "bold" ? "bg-border" : "bg-bg-elev",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-500 ease-out",
          "bg-[linear-gradient(90deg,color-mix(in_oklab,var(--accent)_85%,white)_0%,var(--accent)_50%,var(--accent-hover)_100%)]",
          "bg-[length:200%_100%] [animation:shimmer_2.4s_linear_infinite]"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export { Progress };
