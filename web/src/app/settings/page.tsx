"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  Mic2,
  Shield,
  SlidersHorizontal,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { useDebouncedValue } from "@/hooks";
import {
  deleteAccount,
  getMe,
  getVoices,
  logout as apiLogout,
  updatePreferences,
  type User as ApiUser,
  type Voice as ApiVoice,
} from "@/lib/api";

type SectionKey = "profile" | "preferences" | "api-keys" | "danger";

interface NavItem {
  key: SectionKey;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

const NAV_ITEMS: NavItem[] = [
  { key: "profile", label: "Profile", icon: UserIcon },
  { key: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { key: "api-keys", label: "API keys", icon: KeyRound },
  { key: "danger", label: "Danger zone", icon: Shield },
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
  { value: "hi", label: "Hindi" },
  { value: "pt", label: "Portuguese" },
  { value: "zh", label: "Chinese" },
  { value: "it", label: "Italian" },
  { value: "ko", label: "Korean" },
];

type StyleOption = "formal" | "casual";

type SaveState = "idle" | "saving" | "saved" | "error";

interface Preferences {
  voice_id?: string;
  language?: string;
  style?: StyleOption;
  [key: string]: unknown;
}

function readLocalPreferences(): Preferences {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("preferences");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Preferences = {};
    if (typeof parsed.voice_id === "string") out.voice_id = parsed.voice_id;
    if (typeof parsed.language === "string") out.language = parsed.language;
    if (parsed.style === "formal" || parsed.style === "casual") {
      out.style = parsed.style;
    }
    return out;
  } catch {
    return {};
  }
}

function parseHash(): SectionKey {
  if (typeof window === "undefined") return "profile";
  const raw = window.location.hash.replace(/^#/, "").toLowerCase();
  if (
    raw === "profile" ||
    raw === "preferences" ||
    raw === "api-keys" ||
    raw === "danger"
  ) {
    return raw;
  }
  return "profile";
}

function initialsFrom(user: ApiUser | null): string {
  const source = (user?.name || user?.email || "U").trim();
  if (!source) return "U";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export default function SettingsPage() {
  const router = useRouter();
  const [section, setSection] = useState<SectionKey>("profile");
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Guard: redirect when unauthenticated.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!localStorage.getItem("token")) {
      router.push("/login");
      return;
    }
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        /* 401 is handled globally by the api helper. */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Hash-based deep linking.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSection(parseHash());
    function onHashChange() {
      setSection(parseHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectSection = useCallback((next: SectionKey) => {
    setSection(next);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${next}`);
    }
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-bg">
      <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-10 sm:mb-14">
          <h1 className="type-h1 text-text">Settings</h1>
          <p className="mt-3 type-body text-text-muted">
            Manage your profile and preferences.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_1fr] lg:gap-12">
          <SectionNav
            active={section}
            onSelect={selectSection}
          />

          <div className="min-w-0">
            {section === "profile" ? (
              <ProfileSection
                user={user}
                loading={loading}
                onUserChange={setUser}
              />
            ) : null}
            {section === "preferences" ? (
              <PreferencesSection />
            ) : null}
            {section === "api-keys" ? <ApiKeysSection /> : null}
            {section === "danger" ? (
              <DangerSection userEmail={user?.email ?? ""} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Navigation                                                         */
/* ------------------------------------------------------------------ */

interface SectionNavProps {
  active: SectionKey;
  onSelect: (next: SectionKey) => void;
}

function SectionNav({ active, onSelect }: SectionNavProps) {
  const refs = useRef<Record<SectionKey, HTMLButtonElement | null>>({
    profile: null,
    preferences: null,
    "api-keys": null,
    danger: null,
  });

  function onKeyDown(
    e: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = NAV_ITEMS[(index + 1) % NAV_ITEMS.length];
      onSelect(next.key);
      refs.current[next.key]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = NAV_ITEMS[(index - 1 + NAV_ITEMS.length) % NAV_ITEMS.length];
      onSelect(prev.key);
      refs.current[prev.key]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelect(NAV_ITEMS[0].key);
      refs.current[NAV_ITEMS[0].key]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const last = NAV_ITEMS[NAV_ITEMS.length - 1];
      onSelect(last.key);
      refs.current[last.key]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(NAV_ITEMS[index].key);
    }
  }

  return (
    <>
      {/* Desktop sidebar */}
      <nav
        aria-label="Settings sections"
        role="tablist"
        aria-orientation="vertical"
        className="hidden lg:block"
      >
        <ul className="sticky top-24 flex flex-col gap-1">
          {NAV_ITEMS.map((item, i) => {
            const Icon = item.icon;
            const isActive = item.key === active;
            return (
              <li key={item.key}>
                <button
                  ref={(el) => {
                    refs.current[item.key] = el;
                  }}
                  role="tab"
                  type="button"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onSelect(item.key)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className={cn(
                    "focus-ring group flex w-full items-center gap-3 rounded-lg border-l-2 pl-4 pr-3 py-2.5",
                    "text-left text-sm font-medium transition-colors",
                    isActive
                      ? "border-accent bg-bg-elev text-text"
                      : "border-transparent text-text-muted hover:bg-bg-elev hover:text-text"
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive ? "text-accent" : "text-text-muted"
                    )}
                    aria-hidden
                  />
                  <span className="flex-1">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Mobile tab bar */}
      <nav
        aria-label="Settings sections"
        role="tablist"
        aria-orientation="horizontal"
        className="lg:hidden"
      >
        <div className="-mx-5 overflow-x-auto border-b border-border px-5 sm:-mx-8 sm:px-8">
          <ul className="flex min-w-max items-center gap-1 pb-2">
            {NAV_ITEMS.map((item, i) => {
              const Icon = item.icon;
              const isActive = item.key === active;
              return (
                <li key={item.key}>
                  <button
                    ref={(el) => {
                      refs.current[item.key] = el;
                    }}
                    role="tab"
                    type="button"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => onSelect(item.key)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                    className={cn(
                      "focus-ring flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-bg-elev text-text"
                        : "text-text-muted hover:bg-bg-elev hover:text-text"
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    <span>{item.label}</span>
                    {isActive ? (
                      <ChevronRight
                        className="h-3.5 w-3.5 text-accent"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared section shell                                               */
/* ------------------------------------------------------------------ */

interface SectionShellProps {
  title: string;
  description: string;
  children: React.ReactNode;
  tone?: "default" | "danger";
}

function SectionShell({
  title,
  description,
  children,
  tone = "default",
}: SectionShellProps) {
  return (
    <section
      role="tabpanel"
      className={cn(
        "surface rounded-2xl p-6 sm:p-8",
        tone === "danger" && "border-danger/40"
      )}
    >
      <div className="mb-6 sm:mb-8">
        <h2 className="type-h3 text-text">{title}</h2>
        <p className="mt-1.5 text-sm text-text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */

interface ProfileSectionProps {
  user: ApiUser | null;
  loading: boolean;
  onUserChange: (next: ApiUser) => void;
}

function ProfileSection({ user, loading, onUserChange }: ProfileSectionProps) {
  const [name, setName] = useState(user?.name ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [copied, setCopied] = useState(false);
  const lastPersistedName = useRef<string>(user?.name ?? "");
  const debouncedName = useDebouncedValue(name, 800);

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      lastPersistedName.current = user.name ?? "";
    }
  }, [user]);

  // Autosave on debounce only when the field is unfocused (blur-triggered).
  // We rely on debouncedName to settle then persist if the value changed.
  useEffect(() => {
    if (!user) return;
    const trimmed = debouncedName.trim();
    if (!trimmed) return;
    if (trimmed === lastPersistedName.current) return;

    let cancelled = false;
    setSaveState("saving");
    updatePreferences({ name: trimmed })
      .then((next) => {
        if (cancelled) return;
        lastPersistedName.current = trimmed;
        if (next) onUserChange(next);
        setSaveState("saved");
      })
      .catch(() => {
        if (!cancelled) setSaveState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedName, user, onUserChange]);

  function onCopyEmail() {
    if (!user?.email) return;
    try {
      void navigator.clipboard.writeText(user.email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard API unavailable. */
    }
  }

  if (loading && !user) {
    return (
      <SectionShell
        title="Profile"
        description="Your identity and how you appear in Recast AI."
      >
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading profile…
        </div>
      </SectionShell>
    );
  }

  const initials = initialsFrom(user);

  return (
    <SectionShell
      title="Profile"
      description="Your identity and how you appear in Recast AI."
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div
            className={cn(
              "flex h-20 w-20 items-center justify-center overflow-hidden rounded-full",
              "bg-gradient-to-br from-accent to-accent-hover text-2xl font-semibold",
              "text-[#0a0a0c] shadow-[0_12px_32px_-12px_color-mix(in_oklab,var(--accent)_60%,transparent)]"
            )}
            aria-hidden
          >
            {user?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatar_url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-text">
              {user?.name || "Anonymous"}
            </p>
            <p className="mt-1 text-xs text-text-dim">
              We don&apos;t support custom avatars yet.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <label
              htmlFor="settings-name"
              className="mb-1.5 block text-sm font-medium text-text"
            >
              Name
            </label>
            <Input
              id="settings-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaveState("idle");
              }}
              onBlur={() => {
                // Debounce drives persistence; blur just ensures the latest
                // value flows through.
                setName((n) => n);
              }}
              autoComplete="name"
              placeholder="Your name"
            />
            <SaveStatus state={saveState} />
          </div>

          <div>
            <label
              htmlFor="settings-email"
              className="mb-1.5 block text-sm font-medium text-text"
            >
              Email
            </label>
            <div className="relative">
              <Input
                id="settings-email"
                value={user?.email ?? ""}
                readOnly
                className="pr-12"
              />
              <button
                type="button"
                onClick={onCopyEmail}
                aria-label="Copy email to clipboard"
                className={cn(
                  "focus-ring absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center",
                  "rounded-md text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
                )}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-success" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
              </button>
            </div>
            <p
              className={cn(
                "mt-1.5 text-xs transition-colors",
                copied ? "text-success" : "text-text-dim"
              )}
              aria-live="polite"
            >
              {copied ? "Copied to clipboard" : "Your email is read-only."}
            </p>
          </div>
        </div>

        {user?.created_at ? (
          <p className="text-xs text-text-dim">
            Member since {formatDate(user.created_at)}
          </p>
        ) : null}
      </div>
    </SectionShell>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state === "idle") {
    return <span className="mt-1.5 block h-4" aria-hidden />;
  }
  return (
    <p
      className={cn(
        "mt-1.5 flex items-center gap-1.5 text-xs",
        state === "saving" && "text-text-muted",
        state === "saved" && "text-success",
        state === "error" && "text-danger"
      )}
      aria-live="polite"
    >
      {state === "saving" ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Saving…
        </>
      ) : null}
      {state === "saved" ? (
        <>
          <Check className="h-3 w-3" aria-hidden />
          Saved just now
        </>
      ) : null}
      {state === "error" ? (
        <>
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Save failed — retry
        </>
      ) : null}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  Preferences                                                        */
/* ------------------------------------------------------------------ */

function PreferencesSection() {
  const [voices, setVoices] = useState<ApiVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [prefs, setPrefs] = useState<Preferences>({
    voice_id: undefined,
    language: "en",
    style: "formal",
  });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageRootRef = useRef<HTMLDivElement | null>(null);

  // Initial load: read local fallback + fetch voices.
  useEffect(() => {
    const stored = readLocalPreferences();
    setPrefs((p) => ({ ...p, ...stored }));
    setVoicesLoading(true);
    let cancelled = false;
    getVoices()
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        setPrefs((p) => {
          if (p.voice_id) return p;
          if (list.length === 0) return p;
          return { ...p, voice_id: list[0].id };
        });
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Language dropdown outside click / Esc.
  useEffect(() => {
    if (!languageOpen) return;
    function onPointer(e: PointerEvent) {
      if (
        languageRootRef.current &&
        !languageRootRef.current.contains(e.target as Node)
      ) {
        setLanguageOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setLanguageOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [languageOpen]);

  const commit = useCallback((next: Preferences) => {
    setPrefs(next);
    setSaveState("saving");
    updatePreferences(next)
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("error"));
  }, []);

  const selectedLanguage = useMemo(
    () => LANGUAGES.find((l) => l.value === prefs.language) ?? LANGUAGES[0],
    [prefs.language]
  );

  return (
    <SectionShell
      title="Preferences"
      description="Defaults applied to new projects. You can still override any of these at upload time."
    >
      <div className="flex flex-col gap-8">
        {/* Voice grid */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-text">
              Default voice
            </label>
            <SaveStatus state={saveState} />
          </div>
          {voicesLoading ? (
            <div className="grid max-h-[320px] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "h-[72px] rounded-xl bg-bg-elev",
                    "bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--border)_70%,transparent),transparent)]",
                    "[animation:shimmer_1.8s_linear_infinite]"
                  )}
                />
              ))}
            </div>
          ) : voices.length === 0 ? (
            <div className="rounded-xl border border-border bg-bg-elev px-4 py-6 text-center text-sm text-text-muted">
              No voices are available right now.
            </div>
          ) : (
            <div
              role="radiogroup"
              aria-label="Default voice"
              className="grid max-h-[360px] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2"
            >
              {voices.map((v) => {
                const isSelected = v.id === prefs.voice_id;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    key={v.id}
                    onClick={() => commit({ ...prefs, voice_id: v.id })}
                    className={cn(
                      "focus-ring flex items-center gap-3 rounded-xl border p-3 text-left transition-all",
                      isSelected
                        ? "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] ring-2 ring-accent/40"
                        : "border-border bg-bg-card hover:border-border-hover"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        isSelected
                          ? "bg-accent text-[#0a0a0c]"
                          : "bg-bg-elev text-text-muted"
                      )}
                    >
                      <Mic2 className="h-4 w-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text">
                        {v.name}
                      </p>
                      {v.accent ? (
                        <span
                          className={cn(
                            "mt-1 inline-flex items-center rounded-full border px-2 py-0.5",
                            "text-[10px] font-medium uppercase tracking-wide",
                            isSelected
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : "border-border bg-bg-elev text-text-muted"
                          )}
                        >
                          {v.accent}
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Language */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text">
            Default language
          </label>
          <div ref={languageRootRef} className="relative w-full max-w-xs">
            <button
              type="button"
              onClick={() => setLanguageOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={languageOpen}
              className={cn(
                "focus-ring flex h-11 w-full items-center justify-between gap-2 rounded-lg",
                "border border-border bg-bg-card px-3.5 text-sm text-text transition-colors",
                "hover:border-border-hover"
              )}
            >
              <span>{selectedLanguage.label}</span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  languageOpen && "rotate-180"
                )}
                aria-hidden
              />
            </button>
            {languageOpen ? (
              <ul
                role="listbox"
                className={cn(
                  "absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-xl py-1",
                  "surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)] animate-fade-in"
                )}
              >
                {LANGUAGES.map((opt) => (
                  <li key={opt.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={opt.value === prefs.language}
                      onClick={() => {
                        setLanguageOpen(false);
                        commit({ ...prefs, language: opt.value });
                      }}
                      className={cn(
                        "flex w-full items-center justify-between px-3.5 py-2 text-sm transition-colors",
                        opt.value === prefs.language
                          ? "bg-bg-elev text-text"
                          : "text-text-muted hover:bg-bg-elev hover:text-text"
                      )}
                    >
                      {opt.label}
                      {opt.value === prefs.language ? (
                        <Check
                          className="h-4 w-4 text-accent"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {/* Style */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text">
            Default style
          </label>
          <div
            role="radiogroup"
            aria-label="Default style"
            className="inline-flex rounded-full border border-border bg-bg-card p-1"
          >
            {(["formal", "casual"] as StyleOption[]).map((s) => {
              const active = prefs.style === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => commit({ ...prefs, style: s })}
                  className={cn(
                    "focus-ring rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                    active
                      ? "bg-accent text-[#0a0a0c]"
                      : "text-text-muted hover:text-text"
                  )}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

/* ------------------------------------------------------------------ */
/*  API keys                                                           */
/* ------------------------------------------------------------------ */

function ApiKeysSection() {
  const [tooltipVisible, setTooltipVisible] = useState(false);

  return (
    <SectionShell
      title="API keys"
      description="Programmatic access to trigger renders and fetch completed videos."
    >
      <div className="flex flex-col gap-5">
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg-elev">
              <tr>
                {["Name", "Prefix", "Created", "Last used", ""].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-dim"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="px-4 py-10">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-elev text-accent">
                      <AudioLines className="h-5 w-5" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-text">
                        API keys are coming soon
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        We&apos;re finishing the access management console. You&apos;ll be able to rotate and scope keys right here.
                      </p>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          className="relative inline-block"
          onMouseEnter={() => setTooltipVisible(true)}
          onMouseLeave={() => setTooltipVisible(false)}
          onFocus={() => setTooltipVisible(true)}
          onBlur={() => setTooltipVisible(false)}
        >
          <Button variant="secondary" size="sm" disabled aria-describedby="generate-key-tooltip">
            <KeyRound className="h-4 w-4" aria-hidden />
            Generate new key
          </Button>
          {tooltipVisible ? (
            <span
              id="generate-key-tooltip"
              role="tooltip"
              className={cn(
                "absolute left-0 top-full z-10 mt-2 whitespace-nowrap rounded-md border border-border",
                "bg-bg-elev px-2.5 py-1 text-xs text-text-muted shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)]"
              )}
            >
              Coming soon
            </span>
          ) : null}
        </div>
      </div>
    </SectionShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Danger zone                                                        */
/* ------------------------------------------------------------------ */

interface DangerSectionProps {
  userEmail: string;
}

function DangerSection({ userEmail }: DangerSectionProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await apiLogout();
    } finally {
      setSigningOut(false);
      router.push("/login");
    }
  }

  async function handleDelete() {
    if (confirmValue.trim().toLowerCase() !== userEmail.toLowerCase()) {
      setDeleteError("Email doesn't match.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      if (typeof window !== "undefined") {
        window.location.href = "/";
      }
    } catch (err) {
      setDeleting(false);
      setDeleteError(
        err instanceof Error ? err.message : "Could not delete account."
      );
    }
  }

  return (
    <>
      <SectionShell
        tone="danger"
        title="Danger zone"
        description="Actions here are permanent or affect every device. Proceed with care."
      >
        <ul className="divide-y divide-border">
          <li className="flex flex-col gap-3 py-5 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">
                Sign out of all sessions
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Revoke access on every device. You&apos;ll need to sign in again.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {signingOut ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <LogOut className="h-4 w-4" aria-hidden />
              )}
              {signingOut ? "Signing out…" : "Sign out everywhere"}
            </Button>
          </li>
          <li className="flex flex-col gap-3 py-5 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-danger">
                Delete account
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Permanently remove your account and all associated projects.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmValue("");
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete account
            </Button>
          </li>
        </ul>
      </SectionShell>

      {deleteOpen ? (
        <ConfirmDeleteModal
          email={userEmail}
          value={confirmValue}
          onChange={(v) => {
            setConfirmValue(v);
            if (deleteError) setDeleteError(null);
          }}
          onCancel={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          onConfirm={handleDelete}
          loading={deleting}
          error={deleteError}
        />
      ) : null}
    </>
  );
}

interface ConfirmDeleteModalProps {
  email: string;
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  loading: boolean;
  error: string | null;
}

function ConfirmDeleteModal({
  email,
  value,
  onChange,
  onCancel,
  onConfirm,
  loading,
  error,
}: ConfirmDeleteModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 10);

    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !loading) {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
        );
        const list = Array.from(focusables).filter(
          (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1
        );
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [loading, onCancel]);

  const emailMatch =
    value.trim().toLowerCase() === email.toLowerCase() && email.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className={cn(
          "relative w-full max-w-md overflow-hidden rounded-2xl glass",
          "shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)] animate-fade-in"
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                "bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] text-danger"
              )}
              aria-hidden
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="delete-account-title"
                className="type-h3 text-text"
              >
                Delete account
              </h2>
              <p className="mt-1 text-sm text-text-muted">
                This removes every project, transcript, and render linked to your email. It cannot be undone.
              </p>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={onCancel}
            disabled={loading}
            className={cn(
              "focus-ring flex h-9 w-9 items-center justify-center rounded-lg",
              "text-text-muted transition-colors hover:bg-bg-elev hover:text-text",
              "disabled:opacity-50"
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="px-6 py-5">
          <label
            htmlFor="delete-confirm"
            className="mb-1.5 block text-sm font-medium text-text"
          >
            Type{" "}
            <span className="font-mono text-danger">{email || "your email"}</span>{" "}
            to confirm
          </label>
          <Input
            id="delete-confirm"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={email}
            disabled={loading}
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 flex items-center gap-1.5 text-xs text-danger"
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={loading || !emailMatch}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete permanently
              </>
            )}
          </Button>
        </footer>
      </div>
    </div>
  );
}
