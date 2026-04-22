import * as React from "react";
import { cn } from "@/lib/utils";

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-12 w-full rounded-lg bg-bg-elev border border-border",
        "px-4 text-base text-text placeholder:text-text-muted",
        "transition-[border-color,box-shadow] duration-150",
        "hover:border-border-hover",
        "focus-visible:outline-none focus-visible:border-accent",
        "focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "[font-feature-settings:'ss01','cv11']",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
