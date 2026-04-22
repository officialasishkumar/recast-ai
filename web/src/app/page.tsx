import Link from "next/link";
import {
  Upload,
  BrainCircuit,
  AudioLines,
  Download,
  Video,
  Waves,
  Mic,
  FileText,
  Share2,
  Terminal,
  ArrowRight,
  Github,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const pipeline = [
  {
    icon: Upload,
    eyebrow: "01",
    label: "Upload",
    caption:
      "Drag in a screen capture up to 60 minutes. We store it, hash it, and hand it to the analyzer.",
  },
  {
    icon: BrainCircuit,
    eyebrow: "02",
    label: "Analyze",
    caption:
      "Gemini reads the whole video at once, segments the timeline, and drafts narration with confidence scores.",
  },
  {
    icon: AudioLines,
    eyebrow: "03",
    label: "Synthesize",
    caption:
      "Your chosen voice, rendered per segment. Word-level timings come straight from the TTS engine.",
  },
  {
    icon: Download,
    eyebrow: "04",
    label: "Export",
    caption:
      "Muxed with the original video, time-fit to every scene, delivered as a single MP4 or share link.",
  },
];

const features = [
  {
    icon: Video,
    title: "Video-first understanding",
    body: "We send the whole file to a multimodal model. No frame sampling, no lost context between cuts.",
  },
  {
    icon: Waves,
    title: "Word-level sync",
    body: "Every word has a millisecond timestamp, so captions, playheads, and edits stay locked to the waveform.",
  },
  {
    icon: Mic,
    title: "Voice studio",
    body: "Bring ElevenLabs, Polly, or Google voices. Preview, mix tones per segment, re-render in seconds.",
  },
  {
    icon: FileText,
    title: "Transcript editor",
    body: "A real document surface for the narration. Edit a line, regenerate just that segment, keep the rest.",
  },
  {
    icon: Share2,
    title: "Shareable links",
    body: "Publish a review link without requiring an account. Revoke it any time from the job page.",
  },
  {
    icon: Terminal,
    title: "Developer API",
    body: "A focused REST surface for uploads, transcripts, and renders. Webhook when a job finishes.",
  },
];

const metrics = [
  { value: "2:14", label: "Average video length" },
  { value: "63%", label: "Tokens saved per render" },
  { value: "480+", label: "Teams onboarded" },
];

const faqs = [
  {
    q: "What video lengths are supported?",
    a: "Up to 60 minutes per upload. Longer videos automatically fall back to the flash model to keep analysis snappy.",
  },
  {
    q: "Which TTS providers work out of the box?",
    a: "ElevenLabs, Amazon Polly, and Google TTS. Switch between them per job, or set a workspace default.",
  },
  {
    q: "Can I edit the narration before rendering?",
    a: "Yes. Every line is editable in the transcript editor. Regenerate a single segment without re-running the whole video.",
  },
  {
    q: "Do you support custom voices?",
    a: "If your provider supports voice cloning, your clones show up automatically in the voice picker.",
  },
  {
    q: "Is there a public API?",
    a: "A focused REST API covers uploads, transcripts, renders, and webhooks. Tokens live in Settings.",
  },
  {
    q: "Where is my video stored?",
    a: "Originals and renders live in your own object storage bucket. We only keep metadata and the transcript.",
  },
];

const logos = [
  "Northwind",
  "Acme Labs",
  "Helios",
  "Parallel",
  "Orbital",
  "Lumen",
];

const bars = Array.from({ length: 64 }, (_, i) => {
  const h = 18 + Math.abs(Math.sin(i * 0.62) * 70) + (i % 6) * 3;
  return Math.min(Math.round(h), 92);
});

const miniBars = Array.from({ length: 24 }, (_, i) => {
  const h = 10 + Math.abs(Math.sin(i * 0.75) * 36) + (i % 5) * 2;
  return Math.min(Math.round(h), 52);
});

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-3 text-[11px] uppercase tracking-[0.24em] text-text-dim">
      <span className="h-px w-8 bg-border" />
      {children}
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="relative overflow-hidden">
      {/* Ambient hero gradient */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[820px]"
        aria-hidden
      >
        <div className="absolute left-1/2 top-[-180px] h-[760px] w-[1240px] -translate-x-1/2 rounded-full bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] blur-[140px]" />
        <div className="absolute left-[18%] top-[120px] h-[320px] w-[320px] rounded-full bg-[color-mix(in_oklab,var(--warn)_10%,transparent)] blur-[110px]" />
        <div className="absolute right-[12%] top-[80px] h-[280px] w-[280px] rounded-full bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] blur-[120px]" />
      </div>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-16 px-6 pb-28 pt-24 lg:grid-cols-[1.05fr_1fr] lg:pt-32">
        <div>
          <div className="mb-7">
            <Eyebrow>Narration, automated</Eyebrow>
          </div>
          <h1 className="text-[44px] font-semibold leading-[1.03] tracking-tight text-text sm:text-6xl md:text-[76px]">
            Recordings that
            <br />
            <span className="font-[450] italic text-warn/95">
              speak for themselves.
            </span>
          </h1>
          <p className="mt-7 max-w-md text-[17px] leading-[1.6] text-text-muted">
            Drop in a screen recording. Recast AI watches the whole video,
            drafts narration that matches the beats, and renders a
            studio-quality voiceover you can ship the same afternoon.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3">
            <Link href="/register">
              <Button size="lg">
                Start narrating
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </Link>
            <Link
              href="/login"
              className="focus-ring rounded-md text-sm text-text-muted transition-colors hover:text-text"
            >
              Already have an account?{" "}
              <span className="underline underline-offset-4">Sign in</span>
            </Link>
          </div>
        </div>

        {/* App preview */}
        <div className="relative">
          <div className="absolute -inset-8 -z-10 rounded-[32px] bg-gradient-to-br from-[color-mix(in_oklab,var(--accent)_18%,transparent)] via-[color-mix(in_oklab,var(--warn)_6%,transparent)] to-transparent blur-3xl" />
          <div className="glass overflow-hidden rounded-2xl shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)]">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-1.5" aria-hidden>
                <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
                <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
                <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
              </div>
              <span className="num-tab text-[11px] tracking-wide text-text-dim">
                onboarding-demo.mp4 · 02:14
              </span>
              <span className="rounded-md border border-[color-mix(in_oklab,var(--success)_30%,transparent)] bg-[color-mix(in_oklab,var(--success)_15%,transparent)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                live
              </span>
            </div>

            <div className="px-6 pt-6">
              <div className="relative flex h-24 items-end justify-between gap-[3px]">
                {bars.map((h, i) => (
                  <span
                    key={i}
                    className="wave-bar w-[3px] origin-bottom rounded-full bg-gradient-to-t from-accent/40 to-accent"
                    style={{
                      height: `${h}px`,
                      animation: `wave-pulse ${1.8 + (i % 5) * 0.15}s ease-in-out ${(i % 9) * 0.08}s infinite`,
                    }}
                  />
                ))}
                <span
                  className="playhead absolute inset-y-[-6px] left-0 w-px bg-warn shadow-[0_0_12px_rgba(251,191,36,0.65)]"
                  style={{ animation: "playhead-sweep 6s linear infinite" }}
                  aria-hidden
                />
              </div>
              <div className="num-tab mt-2 flex justify-between text-[10px] tracking-wider text-text-dim">
                <span>00:00</span>
                <span>00:30</span>
                <span>01:00</span>
                <span>01:30</span>
                <span>02:00</span>
              </div>
            </div>

            <div className="border-t border-border px-6 py-5">
              <div className="space-y-3 font-mono text-[13px] leading-relaxed text-text">
                <div className="flex gap-4">
                  <span className="num-tab shrink-0 text-text-dim">00:04</span>
                  <span>
                    Let&apos;s open the{" "}
                    <span className="rounded bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] px-1 text-accent">
                      dashboard
                    </span>{" "}
                    and review today&apos;s jobs.
                  </span>
                </div>
                <div className="flex gap-4 opacity-70">
                  <span className="num-tab shrink-0 text-text-dim">00:09</span>
                  <span>Each row tracks a video through the pipeline…</span>
                </div>
                <div className="flex gap-4 opacity-40">
                  <span className="num-tab shrink-0 text-text-dim">00:14</span>
                  <span>…with a frame-level transcript beneath.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="border-y border-border/60 bg-bg-elev/30">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <p className="text-center text-[11px] uppercase tracking-[0.28em] text-text-dim">
            Trusted by teams building calm, clear product video
          </p>
          <div className="mt-6 grid grid-cols-2 items-center gap-x-10 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
            {logos.map((name) => (
              <div
                key={name}
                className="flex items-center justify-center text-[15px] font-semibold tracking-tight text-text-dim transition-colors hover:text-text-muted"
              >
                <span className="mr-2 inline-block h-2 w-2 rounded-sm bg-border-hover" aria-hidden />
                {name}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pipeline */}
      <section className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <div className="mb-14 flex flex-col gap-4">
          <Eyebrow>The pipeline</Eyebrow>
          <h2 className="type-h2 max-w-2xl text-text">
            One upload, four deliberate steps, a finished narration.
          </h2>
          <p className="max-w-2xl text-[17px] leading-[1.6] text-text-muted">
            Every stage is inspectable. You can pause between analyze and
            synthesize, edit the transcript, and regenerate a single segment
            without touching the rest.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
          {pipeline.map((step, idx) => {
            const Icon = step.icon;
            return (
              <article
                key={step.label}
                className="surface flex flex-col gap-5 rounded-2xl p-6 transition-colors hover:border-border-hover"
              >
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-elev text-accent">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="num-tab text-[11px] tracking-[0.22em] text-text-dim">
                    {step.eyebrow} / 04
                  </span>
                </div>
                <PipelineMock variant={idx} />
                <div>
                  <h3 className="text-[17px] font-semibold text-text">
                    {step.label}
                  </h3>
                  <p className="mt-2 text-[15px] leading-[1.55] text-text-muted">
                    {step.caption}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <div className="mb-14 flex flex-col gap-4">
          <Eyebrow>Built for narration</Eyebrow>
          <h2 className="type-h2 max-w-2xl text-text">
            Everything you need to ship a voiceover in an afternoon.
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="flex flex-col gap-4 bg-bg-card p-8 transition-colors hover:bg-bg-elev"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-elev text-accent">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <h3 className="text-[17px] font-semibold text-text">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-[1.55] text-text-muted">
                    {f.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Testimonial + metrics */}
      <section className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.2fr_1fr]">
          <figure className="surface relative overflow-hidden rounded-2xl p-10">
            <div
              className="pointer-events-none absolute -left-12 -top-12 h-52 w-52 rounded-full bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] blur-3xl"
              aria-hidden
            />
            <blockquote className="relative max-w-xl text-[22px] leading-[1.45] text-text">
              <span className="mr-1 align-top text-4xl leading-none text-accent">
                &ldquo;
              </span>
              Our onboarding videos used to take a week. Now they ship in an
              afternoon.
            </blockquote>
            <figcaption className="relative mt-8 flex items-center gap-3 text-[14px] text-text-muted">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-elev text-sm font-semibold text-text">
                A
              </span>
              <span>
                <span className="block font-medium text-text">
                  A founder somewhere
                </span>
                <span className="text-text-dim">Early access partner</span>
              </span>
            </figcaption>
          </figure>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {metrics.map((m) => (
              <div
                key={m.label}
                className="surface flex flex-col gap-2 rounded-2xl p-6"
              >
                <dt className="text-[13px] uppercase tracking-[0.18em] text-text-dim">
                  {m.label}
                </dt>
                <dd className="num-tab text-[42px] font-semibold leading-none tracking-tight text-text">
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-4xl px-6 py-24 lg:py-32">
        <div className="mb-14 flex flex-col gap-4">
          <Eyebrow>Questions, answered</Eyebrow>
          <h2 className="type-h2 text-text">Frequently asked.</h2>
        </div>
        <div className="divide-y divide-border border-y border-border">
          {faqs.map((item) => (
            <details key={item.q} className="group py-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[17px] font-medium text-text focus:outline-none group-open:text-text [&::-webkit-details-marker]:hidden">
                {item.q}
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-text-muted transition-transform group-open:rotate-45"
                  aria-hidden
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-2xl text-[15px] leading-[1.6] text-text-muted">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA strip */}
      <section className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <div className="surface relative overflow-hidden rounded-[28px] px-8 py-16 text-center sm:px-16">
          <div
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[color-mix(in_oklab,var(--accent)_14%,transparent)] via-transparent to-[color-mix(in_oklab,var(--warn)_8%,transparent)]"
            aria-hidden
          />
          <div className="relative flex flex-col items-center gap-6">
            <Eyebrow>Ready when you are</Eyebrow>
            <h2 className="type-h2 max-w-2xl text-text">
              Start narrating your first video.
            </h2>
            <p className="max-w-xl text-[17px] leading-[1.6] text-text-muted">
              No installation, no credit card. Drop in a recording and hear the
              first pass in minutes.
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-4">
              <Link href="/register">
                <Button size="lg">
                  Start narrating
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="outline" size="lg">
                  Sign in
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 text-sm text-text-muted sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-text">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[#0a0a0c]">
              <AudioLines className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
            </span>
            <span className="font-semibold tracking-tight">Recast AI</span>
            <span className="ml-2 text-text-dim">© 2026</span>
          </div>
          <nav
            className="flex flex-wrap items-center gap-6"
            aria-label="Footer"
          >
            <Link
              href="/dashboard"
              className="focus-ring rounded-md transition-colors hover:text-text"
            >
              Dashboard
            </Link>
            <Link
              href="/docs"
              className="focus-ring rounded-md transition-colors hover:text-text"
            >
              Docs
            </Link>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex items-center gap-1.5 rounded-md transition-colors hover:text-text"
            >
              <Github className="h-3.5 w-3.5" aria-hidden />
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function PipelineMock({ variant }: { variant: number }) {
  if (variant === 0) {
    return (
      <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border bg-bg-elev/60 text-center">
        <div className="flex flex-col items-center gap-2 text-text-dim">
          <Upload className="h-5 w-5 text-accent" aria-hidden />
          <span className="text-[12px] font-medium">Drop onboarding.mp4</span>
          <span className="num-tab text-[10px] tracking-wider">
            MP4 · MOV · WEBM
          </span>
        </div>
      </div>
    );
  }
  if (variant === 1) {
    return (
      <div className="h-28 overflow-hidden rounded-lg border border-border bg-bg-elev/60 p-3">
        <div className="flex items-center gap-2 text-[10px] text-text-dim">
          <span className="flex h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="num-tab tracking-wider">GEMINI-2.5 · ANALYZING</span>
        </div>
        <div className="mt-2 space-y-1.5">
          <div className="h-2 w-full rounded bg-border" />
          <div className="h-2 w-4/5 rounded bg-border" />
          <div className="h-2 w-11/12 rounded bg-border" />
          <div className="h-2 w-3/5 rounded bg-border" />
        </div>
      </div>
    );
  }
  if (variant === 2) {
    return (
      <div className="flex h-28 items-end justify-between gap-[2px] rounded-lg border border-border bg-bg-elev/60 px-3 pb-3 pt-3">
        {miniBars.map((h, i) => (
          <span
            key={i}
            className="w-[3px] origin-bottom rounded-full bg-gradient-to-t from-accent/40 to-accent"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-28 flex-col justify-between rounded-lg border border-border bg-bg-elev/60 p-3">
      <div className="flex items-center justify-between text-[10px] text-text-dim">
        <span className="num-tab tracking-wider">output.mp4</span>
        <span className="rounded border border-[color-mix(in_oklab,var(--success)_30%,transparent)] bg-[color-mix(in_oklab,var(--success)_14%,transparent)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-success">
          ready
        </span>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-text-muted">
        <Download className="h-3.5 w-3.5 text-accent" aria-hidden />
        <span>1080p · 02:14 · 38 MB</span>
      </div>
    </div>
  );
}
