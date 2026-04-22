"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AudioLines,
  ChevronDown,
  LogOut,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const authListeners = new Set<() => void>();

export function notifyAuthChange() {
  authListeners.forEach((fn) => fn());
}

function subscribeAuth(callback: () => void) {
  authListeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    authListeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function getAuthSnapshot() {
  return !!localStorage.getItem("token");
}

function getAuthServerSnapshot() {
  return false;
}

function useAuth() {
  return useSyncExternalStore(
    subscribeAuth,
    getAuthSnapshot,
    getAuthServerSnapshot
  );
}

interface MeResponse {
  id: string;
  email: string;
  name?: string;
}

function useCurrentUser(authenticated: boolean) {
  const [user, setUser] = useState<MeResponse | null>(null);

  useEffect(() => {
    if (!authenticated) {
      setUser(null);
      return;
    }
    const token = localStorage.getItem("token");
    if (!token) return;
    const base =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";
    const controller = new AbortController();
    fetch(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setUser(data as MeResponse);
      })
      .catch(() => {
        /* 401s are handled elsewhere */
      });
    return () => controller.abort();
  }, [authenticated]);

  return user;
}

const AUTHED_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/jobs", label: "Jobs" },
];

const PUBLIC_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const authenticated = useAuth();
  const user = useCurrentUser(authenticated);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  function logout() {
    localStorage.removeItem("token");
    notifyAuthChange();
    setMenuOpen(false);
    router.push("/login");
  }

  const links = authenticated ? AUTHED_LINKS : PUBLIC_LINKS;
  const email = user?.email ?? "";
  const initial = (user?.name || user?.email || "U").trim().charAt(0).toUpperCase();

  return (
    <header
      className={cn(
        "sticky top-0 z-50 h-16 border-b border-border",
        "bg-bg/70 backdrop-blur-xl"
      )}
    >
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-5 sm:px-8">
        <div className="flex items-center gap-10">
          <Link
            href="/"
            className="focus-ring flex items-center gap-2.5 rounded-md"
            aria-label="Recast AI home"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[#0a0a0c] shadow-[0_6px_18px_-8px_color-mix(in_oklab,var(--accent)_70%,transparent)]">
              <AudioLines className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-text">
              Recast AI
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            {links.map((link) => {
              const active =
                link.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "focus-ring rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "text-text"
                      : "text-text-muted hover:text-text"
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {authenticated ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={cn(
                  "focus-ring flex items-center gap-2 rounded-lg border border-transparent",
                  "pl-1.5 pr-2 py-1.5 text-sm text-text-muted transition-colors",
                  "hover:border-border hover:bg-bg-elev hover:text-text"
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full",
                    "bg-gradient-to-br from-accent to-accent-hover",
                    "text-xs font-semibold text-[#0a0a0c]"
                  )}
                  aria-hidden="true"
                >
                  {initial}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    menuOpen && "rotate-180"
                  )}
                  aria-hidden="true"
                />
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className={cn(
                    "absolute right-0 mt-2 w-60 overflow-hidden rounded-xl",
                    "surface shadow-[0_20px_60px_-20px_rgba(0,0,0,0.6)]"
                  )}
                >
                  {email && (
                    <div className="border-b border-border px-4 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-dim">
                        Signed in as
                      </p>
                      <p className="mt-0.5 truncate text-sm text-text">
                        {email}
                      </p>
                    </div>
                  )}
                  <div className="py-1">
                    <Link
                      href="/settings"
                      role="menuitem"
                      className={cn(
                        "focus-ring flex items-center gap-3 px-4 py-2 text-sm",
                        "text-text-muted transition-colors hover:bg-bg-elev hover:text-text"
                      )}
                    >
                      <Settings className="h-4 w-4" aria-hidden="true" />
                      Settings
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={logout}
                      className={cn(
                        "focus-ring flex w-full items-center gap-3 px-4 py-2 text-sm",
                        "text-danger transition-colors hover:bg-bg-elev"
                      )}
                    >
                      <LogOut className="h-4 w-4" aria-hidden="true" />
                      Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Sign in
                </Button>
              </Link>
              <Link href="/register">
                <Button size="sm">Get started</Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
