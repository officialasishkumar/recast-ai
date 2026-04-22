import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5",
    "text-xs font-medium uppercase tracking-wide",
    "border transition-colors",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-bg-elev text-text-muted border-border",
        success:
          "bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-success border-[color-mix(in_oklab,var(--success)_30%,transparent)]",
        warning:
          "bg-[color-mix(in_oklab,var(--warn)_15%,transparent)] text-warn border-[color-mix(in_oklab,var(--warn)_30%,transparent)]",
        danger:
          "bg-[color-mix(in_oklab,var(--danger)_15%,transparent)] text-danger border-[color-mix(in_oklab,var(--danger)_30%,transparent)]",
        info:
          "bg-[color-mix(in_oklab,var(--accent)_15%,transparent)] text-accent border-[color-mix(in_oklab,var(--accent)_35%,transparent)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
