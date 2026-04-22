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
  title: "Recast AI — Narration, automated",
  description:
    "Drop in a screen recording. Get back studio-quality narration, frame-synced and ready to ship.",
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
    >
      <body className="flex min-h-full flex-col bg-bg text-text antialiased">
        <ShortcutsProvider>
          <Navbar />
          <main className="flex-1">{children}</main>
          <ShortcutsOverlay />
          <ShortcutHint />
        </ShortcutsProvider>
        <Toaster />
      </body>
    </html>
  );
}
