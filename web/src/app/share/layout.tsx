import type { ReactNode } from "react";

/** Minimal layout for public share pages - no navbar, artifact-first feel. */
export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-bg text-text antialiased">
      {children}
    </div>
  );
}
