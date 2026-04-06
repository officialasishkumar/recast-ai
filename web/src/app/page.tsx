import Link from "next/link";
import {
  Upload,
  BrainCircuit,
  AudioLines,
  Download,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: Upload,
    title: "Upload",
    description:
      "Drag & drop any screen recording. We support MP4, MOV, WebM, and more.",
  },
  {
    icon: BrainCircuit,
    title: "AI Analysis",
    description:
      "Our vision model analyzes every frame, understanding context and on-screen actions.",
  },
  {
    icon: AudioLines,
    title: "Voice Synthesis",
    description:
      "Choose from dozens of natural-sounding AI voices to narrate your video.",
  },
  {
    icon: Download,
    title: "Export",
    description:
      "Download the finished video with perfectly synced narration, ready to share.",
  },
];

const pricingFree = [
  "5 minutes per month",
  "720p export",
  "3 voice options",
  "Community support",
];

const pricingPro = [
  "Unlimited minutes",
  "4K export",
  "All premium voices",
  "Priority support",
  "Custom voice cloning",
  "Webhook integrations",
];

export default function HomePage() {
  return (
    <div className="relative overflow-hidden">
      {/* Gradient backdrop */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-3xl" />

      {/* Hero */}
      <section className="relative mx-auto max-w-5xl px-4 pb-20 pt-28 text-center sm:px-6">
        <span className="mb-4 inline-block rounded-full border border-indigo-700/60 bg-indigo-900/30 px-3 py-1 text-xs font-medium text-indigo-300">
          Now in public beta
        </span>
        <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl">
          Turn any screen recording into a{" "}
          <span className="text-indigo-400">professionally narrated</span> video
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
          Upload your raw screen capture and let Recast AI analyze the content,
          generate a script, and produce studio-quality narration — all in
          minutes.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link href="/register">
            <Button size="lg">Get started free</Button>
          </Link>
          <Link href="/login">
            <Button variant="outline" size="lg">
              Sign in
            </Button>
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-2xl font-bold text-white sm:text-3xl">
          How it works
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-slate-400">
          Four simple steps from raw footage to polished narrated video.
        </p>

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group rounded-xl border border-slate-800 bg-slate-900/50 p-6 transition-colors hover:border-slate-700"
              >
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400 transition-colors group-hover:bg-indigo-600/30">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="mb-1 text-xs font-medium text-indigo-400">
                  Step {i + 1}
                </div>
                <h3 className="text-base font-semibold text-slate-100">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {f.description}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Pricing */}
      <section className="relative mx-auto max-w-4xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-2xl font-bold text-white sm:text-3xl">
          Simple, transparent pricing
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-center text-slate-400">
          Start for free, upgrade when you need more.
        </p>

        <div className="mt-14 grid gap-8 sm:grid-cols-2">
          {/* Free */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8">
            <h3 className="text-lg font-semibold text-slate-100">Free</h3>
            <div className="mt-2">
              <span className="text-4xl font-bold text-white">$0</span>
              <span className="text-slate-500"> / month</span>
            </div>
            <ul className="mt-6 space-y-3">
              {pricingFree.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-sm text-slate-300"
                >
                  <Check className="h-4 w-4 text-emerald-400" />
                  {item}
                </li>
              ))}
              {["Custom voice cloning", "Webhook integrations"].map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-sm text-slate-500"
                >
                  <X className="h-4 w-4 text-slate-600" />
                  {item}
                </li>
              ))}
            </ul>
            <Link href="/register" className="mt-8 block">
              <Button variant="outline" className="w-full">
                Get started
              </Button>
            </Link>
          </div>

          {/* Pro */}
          <div className="rounded-xl border border-indigo-600/50 bg-indigo-600/5 p-8 ring-1 ring-indigo-600/20">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-slate-100">Pro</h3>
              <span className="rounded-full bg-indigo-600/30 px-2 py-0.5 text-xs font-medium text-indigo-300">
                Popular
              </span>
            </div>
            <div className="mt-2">
              <span className="text-4xl font-bold text-white">$29</span>
              <span className="text-slate-500"> / month</span>
            </div>
            <ul className="mt-6 space-y-3">
              {pricingPro.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-sm text-slate-300"
                >
                  <Check className="h-4 w-4 text-indigo-400" />
                  {item}
                </li>
              ))}
            </ul>
            <Link href="/register" className="mt-8 block">
              <Button className="w-full">Upgrade to Pro</Button>
            </Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-2xl font-bold text-white sm:text-3xl">
          Ready to recast your videos?
        </h2>
        <p className="mt-3 text-slate-400">
          Join thousands of creators who save hours every week with AI narration.
        </p>
        <Link href="/register" className="mt-8 inline-block">
          <Button size="lg">Start for free</Button>
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-slate-500 sm:px-6">
          Recast AI &mdash; AI-powered video narration platform.
        </div>
      </footer>
    </div>
  );
}
