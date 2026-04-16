"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setCachedUser, clearCachedUser } from "@/lib/api";
import { clearCachedEvents } from "@/lib/events-cache";
import { MeshBackground } from "@/components/MeshBackground";

const PASSWORD_RULES = [
  { key: "length", label: "At least 8 characters", test: (p: string) => p.length >= 8 },
  { key: "upper", label: "One uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
  { key: "lower", label: "One lowercase letter", test: (p: string) => /[a-z]/.test(p) },
  { key: "special", label: "One special character (!@#$…)", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export default function SignupPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const passwordChecks = useMemo(
    () => PASSWORD_RULES.map((r) => ({ ...r, passed: r.test(password) })),
    [password]
  );
  const allPasswordChecksPassed = passwordChecks.every((c) => c.passed);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!allPasswordChecksPassed) {
      setError("Please meet all password requirements before signing up.");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/signup/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, email }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || `Signup failed (${res.status})`);
        return;
      }

      // Auth cookie is set by the server (HttpOnly) — no client-side token handling needed
      clearCachedUser();
      clearCachedEvents();
      if (data?.username) {
        setCachedUser({ username: data.username, email: data.email });
      }
      router.push("/upload");
    } catch (err) {
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setError(
          "Cannot connect to server. The backend may be temporarily unavailable."
        );
      } else {
        setError(err instanceof Error ? err.message : "Signup failed");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] flex items-center justify-center p-4">
      <MeshBackground />
      <div className="relative w-full max-w-md">
        <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-8">
          <h1 className="text-2xl font-semibold text-slate-800 mb-1">
            Create account
          </h1>
          <p className="text-slate-500 text-sm mb-6">
            Sign up to get started
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-slate-700 mb-1"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-700 placeholder:text-slate-500"
                placeholder="Choose a username"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-slate-700 mb-1"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-700 placeholder:text-slate-500"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-700 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-700 placeholder:text-slate-500"
                placeholder="Create a password"
              />
              {password.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {passwordChecks.map((check) => (
                    <li
                      key={check.key}
                      className={`flex items-center gap-1.5 text-xs ${
                        check.passed ? "text-green-600" : "text-slate-400"
                      }`}
                    >
                      {check.passed ? (
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="9" strokeWidth={2} />
                        </svg>
                      )}
                      {check.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !allPasswordChecksPassed}
              className="w-full py-2.5 px-4 bg-[#3C89C6] text-white font-medium rounded-lg hover:bg-[#2d6da3] focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? "Creating account..." : "Sign up"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-[#3C89C6] font-medium hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
