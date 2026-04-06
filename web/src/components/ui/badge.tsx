import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-slate-700 text-slate-200",
        green: "bg-emerald-900/60 text-emerald-400 border border-emerald-700",
        blue: "bg-blue-900/60 text-blue-400 border border-blue-700",
        yellow: "bg-amber-900/60 text-amber-400 border border-amber-700",
        red: "bg-red-900/60 text-red-400 border border-red-700",
        indigo: "bg-indigo-900/60 text-indigo-400 border border-indigo-700",
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
