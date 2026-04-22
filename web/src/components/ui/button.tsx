import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium",
    "transition-[background-color,border-color,color,transform,box-shadow]",
    "duration-150 ease-out active:scale-[0.98] focus-ring",
    "disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap",
    "select-none",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-accent text-[#0a0a0c] hover:bg-accent-hover shadow-[0_1px_0_0_rgba(255,255,255,0.08)_inset,0_1px_2px_rgba(0,0,0,0.3)] hover:shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset,0_8px_24px_-8px_color-mix(in_oklab,var(--accent)_60%,transparent)]",
        secondary:
          "bg-bg-card border border-border text-text hover:border-border-hover hover:bg-bg-elev",
        ghost:
          "bg-transparent text-text-muted hover:bg-bg-elev hover:text-text",
        outline:
          "bg-transparent border border-border text-text hover:border-border-hover hover:bg-bg-elev",
        destructive:
          "bg-danger text-[#0a0a0c] hover:brightness-110 shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset,0_1px_2px_rgba(0,0,0,0.3)]",
      },
      size: {
        sm: "h-9 px-3.5 text-sm",
        md: "h-11 px-5 text-base",
        lg: "h-13 px-7 text-lg",
        icon: "h-11 w-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
