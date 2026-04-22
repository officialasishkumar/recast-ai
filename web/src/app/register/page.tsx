"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { register } from "@/lib/api";
import { notifyAuthChange } from "@/components/navbar";
import {
  AudioLines,
  ArrowRight,
  Globe as Chrome,
  Code2 as Github,
  Sparkles,
  CheckCircle2,
} from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const nameValid = name.trim().length >= 2;
  const emailValid = EMAIL_RE.test(email);
  const passwordValid = password.length >= MIN_PASSWORD;
  const canSubmit = nameValid && emailValid && passwordValid && !loading;

  const nameError = useMemo(() => {
    if (!name) return "";
    return nameValid ? "" : "Please enter your name";
  }, [name, nameValid]);

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
      const res = await register(email, password, name.trim());
      localStorage.setItem("token", res.token);
      notifyAuthChange();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
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
          className="pointer-events-none absolute -right-32 bottom-0 h-[520px] w-[520px] rounded-full bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] blur-[140px]"
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
              Create your account
            </div>
            <h2 className="type-h2 max-w-md text-text">
              Say hello to narration that{" "}
              <em className="font-[450] italic text-warn/95">ships itself</em>.
            </h2>
            <p className="max-w-sm text-[17px] leading-[1.6] text-text-muted">
              A focused workspace for teams recording product demos,
              walkthroughs, and onboarding moments.
            </p>

            <ul className="mt-2 space-y-3 text-[15px] text-text-muted">
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                First-class video understanding with Gemini.
              </li>
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                Per-segment regeneration in seconds, not minutes.
              </li>
              <li className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
                Share links, developer API, and webhooks out of the box.
              </li>
            </ul>
          </div>

          <p className="flex items-center gap-2 text-[13px] text-text-dim">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            No credit card required.
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
            <h1 className="type-h2 text-text">Create your account</h1>
            <p className="mt-2 text-[15px] text-text-muted">
              Get set up in less than a minute.
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
                htmlFor="name"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Name
              </label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "name-error" : undefined}
                required
                autoFocus
              />
              {nameError ? (
                <p id="name-error" className="mt-1.5 text-[13px] text-danger">
                  {nameError}
                </p>
              ) : null}
            </div>

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
              />
              {emailError ? (
                <p id="email-error" className="mt-1.5 text-[13px] text-danger">
                  {emailError}
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-text"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD} characters`}
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

            <label className="focus-ring flex cursor-pointer items-start gap-3 rounded-md pt-1 text-[14px] text-text-muted">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-border bg-bg-elev text-accent accent-accent focus:outline-none"
              />
              <span>
                I agree to the{" "}
                <Link
                  href="/terms"
                  className="underline underline-offset-4 hover:text-text"
                >
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link
                  href="/terms"
                  className="underline underline-offset-4 hover:text-text"
                >
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

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
              {loading ? "Creating account…" : "Create account"}
              {!loading ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
            </Button>
          </form>

          <p className="mt-7 text-center text-sm text-text-muted">
            Already have an account?{" "}
            <Link
              href="/login"
              className="focus-ring rounded-md font-medium text-accent transition-colors hover:text-accent-hover"
            >
              Sign in
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
