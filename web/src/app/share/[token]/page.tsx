import type { Metadata } from "next";
import Link from "next/link";
import { FileX } from "lucide-react";
import { ShareViewer } from "./viewer";
import type { PublicShare } from "@/lib/api";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

/** Server-side fetch of a public share. Returns null when the link is dead. */
async function fetchShare(token: string): Promise<PublicShare | null> {
  try {
    const res = await fetch(`${API_BASE}/public/shares/${token}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: PublicShare } & PublicShare;
    if (body && typeof body === "object" && "data" in body && body.data) {
      return body.data as PublicShare;
    }
    return body as PublicShare;
  } catch {
    return null;
  }
}

/** Build SEO metadata from the share's job name and transcript excerpt. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const share = await fetchShare(token);
  if (!share) {
    return {
      title: "Share not available - Recast AI",
      description: "This share link is no longer available.",
    };
  }
  const excerpt = share.transcript
    .map((s) => s.text)
    .join(" ")
    .slice(0, 160);
  return {
    title: `${share.job.name} · Recast AI`,
    description: excerpt || `Watch ${share.job.name} on Recast AI.`,
    openGraph: {
      title: `${share.job.name} · Recast AI`,
      description: excerpt || `Watch ${share.job.name} on Recast AI.`,
      type: "video.other",
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await fetchShare(token);

  if (!share) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 py-20 text-center">
        <div className="relative mb-8 flex h-40 w-40 items-center justify-center rounded-full border border-border bg-bg-card">
          <div
            aria-hidden
            className="absolute inset-2 rounded-full bg-[conic-gradient(from_90deg,var(--accent)_0,transparent_40%,transparent_60%,var(--accent)_100%)] opacity-10"
          />
          <FileX className="h-16 w-16 text-text-dim" />
        </div>
        <h1 className="type-h2 text-text">This share link is no longer available</h1>
        <p className="mt-3 max-w-md text-text-muted">
          The owner may have revoked access, or the link has expired.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-bg-card px-5 py-2.5 text-sm font-medium text-text transition hover:border-border-hover hover:bg-bg-elev focus-ring"
        >
          Explore Recast AI
        </Link>
      </div>
    );
  }

  return <ShareViewer share={share} />;
}
