"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/api";
import { notifyAuthChange } from "@/components/navbar";
import {
  AudioLines,
  ArrowRight,
  Chrome,
  Github,
  Sparkles,
  CheckCircle2,
} from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const emailValid = EMAIL_RE.test(email);
  const passwordValid = password.length >= MIN_PASSWORD;
  const canSubmit = emailValid && passwordValid && !loading;

  const emailError = useMemo(() => {
    if (!email) return "";
    return emailValid ? "" : "Enter a valid email address";
  }, [email, emailValid]);

  const passwordError = useMemo(() => {
    if (!password) return "";
    return passwordValid
      ? ""
      : `Password must be at least ${MIN_PASSWORD} characters`;
  }, [password, passwordValid]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const res = await login(email, password);
      localStorage.setItem("token", res.token);
      notifyAuthChange();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  function oauth(provider: "google" | "github") {
    window.location.href = `${API_BASE}/auth/${provider}`;
  }

  return (
    <div className="grid min-h-[calc(100vh-4rem)] grid-cols-1 lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden border-r border-border bg-bg-elev lg:flex">
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[color-mix(in_oklab,var(--accent)_22%,transparent)] via-transparent to-[color-mix(in_oklab,var(--warn)_10%,transparent)]"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -left-32 bottom-0 h-[520px] w-[520px] rounded-full bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] blur-[140px]"
          aria-hidden
        />
        <div className="relative z-10 flex w-full flex-col justify-between p-14">
          <Link
            href="/"
            className="focus-ring inline-flex items-center gap-2.5 self-start rounded-md"
            aria-label="Recast AI home"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-[#0a0a0c] shadow-[0_8px_24px_-10px_color-mix(in_oklab,var(--accent)_65%,transparent)]">
              <AudioLines className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            </span>
            <span className="text-[16px] font-semibold tracking-tight">
              Recast AI
            </span>
          </Link>

          <div className="flex flex-col gap-6">
            <div className="inline-flex items-center gap-3 text-[11px] uppercase tracking-[0.24em] text-text-dim">
              <span className="h-px w-8 bg-border" />
              Welcome back
            </div>
            <h2 className="type-h2 max-w-md text-text">
              Welcome back to <em className="font-[450] italic text-warn/95">Recast AI</em>.
            </h2>
            <p className="max-w-sm text-[17px] leading-[1.6] text-text-muted">
              Pick up where you left off. Your jobs, transcripts, and voices
              are right where you need them.
            </p>

            <ul className="mt-2 space-y-3 text-[15px] text-text-muted">
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                Word-level sync between video and narration.
              </li>
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                Bring your own voice provider, or use ours.
              </li>
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                Regenerate a single segment without touching the rest.
              </li>
            </ul>
          </div>

          <p className="flex items-center gap-2 text-[13px] text-text-dim">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Secure, human-centered voiceover tooling.
          </p>
        </div>
      </aside>

      <section className="flex items-center justify-center px-5 py-16 sm:px-10">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="mb-10 flex flex-col gap-2 lg:hidden">
            <Link
              href="/"
              className="focus-ring inline-flex items-center gap-2.5 self-start rounded-md"
              aria-label="Recast AI home"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-[#0a0a0c]">
                <AudioLines className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              </span>
              <span className="text-[16px] font-semibold tracking-tight">
                Recast AI
              </span>
            </Link>
          </div>

          <div className="mb-8">
            <h1 className="type-h2 text-text">Sign in</h1>
            <p className="mt-2 text-[15px] text-text-muted">
              Use your email or continue with a provider.
            </p>
          </div>

          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-center"
              onClick={() => oauth("google")}
            >
              <Chrome className="h-4 w-4" aria-hidden />
              Continue with Google
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-center"
              onClick={() => oauth("github")}
            >
              <Github className="h-4 w-4" aria-hidden />
              Continue with GitHub
            </Button>
          </div>

          <div className="relative my-7" aria-hidden>
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-[11px]">
              <span className="bg-bg px-3 uppercase tracking-[0.22em] text-text-dim">
                or with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "email-error" : undefined}
                required
                autoFocus
              />
              {emailError ? (
                <p id="email-error" className="mt-1.5 text-[13px] text-danger">
                  {emailError}
                </p>
              ) : null}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-text"
                >
                  Password
                </label>
                <Link
                  href="/login"
                  className="focus-ring rounded-md text-[13px] text-text-muted transition-colors hover:text-text"
                  tabIndex={0}
                >
                  Forgot?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? "pw-error" : undefined}
                required
              />
              {passwordError ? (
                <p id="pw-error" className="mt-1.5 text-[13px] text-danger">
                  {passwordError}
                </p>
              ) : null}
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[13px] text-danger"
              >
                {error}
              </div>
            ) : null}

            <Button
              type="submit"
              className="w-full justify-center"
              disabled={!canSubmit}
            >
              {loading ? "Signing in…" : "Sign in"}
              {!loading ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
            </Button>
          </form>

          <p className="mt-7 text-center text-sm text-text-muted">
            Don&apos;t have an account?{" "}
            <Link
              href="/register"
              className="focus-ring rounded-md font-medium text-accent transition-colors hover:text-accent-hover"
            >
              Sign up
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
