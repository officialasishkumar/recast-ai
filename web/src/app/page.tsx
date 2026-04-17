import Link from "next/link";
import { Upload, BrainCircuit, AudioLines, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

const steps = [
  { icon: Upload, label: "Upload", caption: "Drop in any screen capture" },
  { icon: BrainCircuit, label: "Analyze", caption: "Vision model reads every frame" },
  { icon: AudioLines, label: "Synthesize", caption: "Frame-accurate TTS" },
  { icon: Download, label: "Export", caption: "Muxed video, ready to ship" },
];

const bars = Array.from({ length: 64 }, (_, i) => {
  const h = 18 + Math.abs(Math.sin(i * 0.62) * 70) + (i % 6) * 3;
  return Math.min(Math.round(h), 92);
});

export default function HomePage() {
  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[760px]">
        <div className="absolute left-1/2 top-[-120px] h-[720px] w-[1200px] -translate-x-1/2 rounded-full bg-indigo-600/15 blur-[120px]" />
        <div className="absolute left-[20%] top-[120px] h-[340px] w-[340px] rounded-full bg-fuchsia-600/10 blur-[100px]" />
      </div>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-16 px-6 pb-24 pt-24 lg:grid-cols-[1.05fr_1fr] lg:pt-32">
        <div>
          <div className="mb-7 inline-flex items-center gap-3 text-[11px] uppercase tracking-[0.24em] text-slate-400">
            <span className="h-px w-8 bg-slate-700" />
            Narration, automated
          </div>
          <h1 className="text-[44px] font-semibold leading-[1.03] tracking-tight text-white sm:text-6xl md:text-[76px]">
            Recordings that
            <br />
            <span className="font-[450] italic text-amber-200/95">
              speak for themselves.
            </span>
          </h1>
          <p className="mt-7 max-w-md text-lg leading-relaxed text-slate-400">
            Drop in a screen recording. Get back studio-quality narration,
            frame-synced and ready to ship.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3">
            <Link href="/register">
              <Button size="lg">Start narrating →</Button>
            </Link>
            <Link
              href="/login"
              className="text-sm text-slate-400 transition-colors hover:text-slate-200"
            >
              Already have an account?{" "}
              <span className="underline underline-offset-4">Sign in</span>
            </Link>
          </div>
        </div>

        {/* App preview */}
        <div className="relative">
          <div className="absolute -inset-8 -z-10 rounded-[32px] bg-gradient-to-br from-indigo-500/15 via-fuchsia-500/5 to-transparent blur-3xl" />
          <div className="overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/70 shadow-2xl shadow-indigo-950/40 backdrop-blur">
            {/* window chrome */}
            <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              </div>
              <span className="num-tab text-[11px] tracking-wide text-slate-500">
                onboarding-demo.mp4 · 02:14
              </span>
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                live
              </span>
            </div>

            {/* waveform */}
            <div className="px-6 pt-6">
              <div className="relative flex h-24 items-end justify-between gap-[3px]">
                {bars.map((h, i) => (
                  <span
                    key={i}
                    className="wave-bar w-[3px] origin-bottom rounded-full bg-gradient-to-t from-indigo-600/40 to-indigo-300"
                    style={{
                      height: `${h}px`,
                      animation: `wave-pulse ${1.8 + (i % 5) * 0.15}s ease-in-out ${(i % 9) * 0.08}s infinite`,
                    }}
                  />
                ))}
                <span
                  className="playhead absolute inset-y-[-6px] left-0 w-px bg-amber-200/80 shadow-[0_0_12px_rgba(253,230,138,0.6)]"
                  style={{ animation: "playhead-sweep 6s linear infinite" }}
                />
              </div>
              <div className="num-tab mt-2 flex justify-between text-[10px] tracking-wider text-slate-600">
                <span>00:00</span>
                <span>00:30</span>
                <span>01:00</span>
                <span>01:30</span>
                <span>02:00</span>
              </div>
            </div>

            {/* transcript */}
            <div className="border-t border-slate-800/80 px-6 py-5">
              <div className="space-y-3 font-mono text-[13px] leading-relaxed text-slate-300">
                <div className="flex gap-4">
                  <span className="num-tab shrink-0 text-slate-600">00:04</span>
                  <span>
                    Let&apos;s open the{" "}
                    <span className="rounded bg-indigo-500/20 px-1 text-indigo-200">
                      dashboard
                    </span>{" "}
                    and review today&apos;s jobs.
                  </span>
                </div>
                <div className="flex gap-4 opacity-70">
                  <span className="num-tab shrink-0 text-slate-600">00:09</span>
                  <span>Each row tracks a video through the pipeline…</span>
                </div>
                <div className="flex gap-4 opacity-40">
                  <span className="num-tab shrink-0 text-slate-600">00:14</span>
                  <span>…with a frame-level transcript beneath.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Process */}
      <section className="mx-auto max-w-6xl border-t border-slate-900 px-6 py-14">
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="group relative">
                <div className="num-tab mb-4 text-[11px] tracking-[0.22em] text-slate-600">
                  0{i + 1} /04
                </div>
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-indigo-300 transition-colors group-hover:border-slate-700 group-hover:text-indigo-200">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="text-sm font-medium text-slate-100">
                  {s.label}
                </div>
                <div className="mt-1 text-[13px] leading-relaxed text-slate-500">
                  {s.caption}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <footer className="border-t border-slate-900 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 text-xs text-slate-500">
          <span>Recast AI</span>
          <span className="num-tab">v0.1 · 2026</span>
        </div>
      </footer>
    </div>
  );
}
