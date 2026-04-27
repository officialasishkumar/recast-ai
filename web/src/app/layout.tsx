import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/components/toaster";
import {
  ShortcutHint,
  ShortcutsOverlay,
  ShortcutsProvider,
} from "@/components/shortcuts";
import { cn } from "@/lib/utils";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://recast.ai",
  ),
  title: {
    default: "Recast AI — Narration, automated",
    template: "%s · Recast AI",
  },
  description:
    "Drop in a screen recording. Get back studio-quality narration, frame-synced and ready to ship.",
  applicationName: "Recast AI",
  keywords: [
    "video narration",
    "AI voiceover",
    "screen recording",
    "Gemini",
    "TTS",
    "voice synthesis",
  ],
  authors: [{ name: "Recast AI" }],
  openGraph: {
    type: "website",
    title: "Recast AI — Narration, automated",
    description:
      "Drop in a screen recording. Get back studio-quality narration, frame-synced and ready to ship.",
    siteName: "Recast AI",
  },
  twitter: {
    card: "summary_large_image",
    title: "Recast AI — Narration, automated",
    description:
      "Drop in a screen recording. Get back studio-quality narration, frame-synced and ready to ship.",
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn(inter.variable, jetbrains.variable, "dark h-full")}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-bg text-text antialiased motion-reduce:!transition-none motion-reduce:!animate-none">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-bg-elev focus:px-3 focus:py-2 focus:text-sm focus:text-text focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Skip to main content
        </a>
        <ShortcutsProvider>
          <Navbar />
          <main id="main-content" className="flex-1" tabIndex={-1}>
            {children}
          </main>
          <ShortcutsOverlay />
          <ShortcutHint />
        </ShortcutsProvider>
        <Toaster />
      </body>
    </html>
  );
}
