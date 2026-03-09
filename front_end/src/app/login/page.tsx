"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getApiBase, setCachedUser, setAuthToken, clearCachedUser } from "@/lib/api";
import { clearCachedEvents } from "@/lib/events-cache";
import { MeshBackground } from "@/components/MeshBackground";

const API_BASE = getApiBase();

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      // Get CSRF token first (required for Django session auth)
      const csrfRes = await fetch(`${API_BASE}/auth/csrf/`, {
        method: "GET",
        credentials: "include",
      });
      if (!csrfRes.ok) {
        const errData = await csrfRes.json().catch(() => ({}));
        const msg = errData?.error || (csrfRes.status === 503 ? "Backend not reachable." : "Failed to get CSRF token");
        throw new Error(msg);
      }
      const { csrfToken } = await csrfRes.json();

      const res = await fetch(`${API_BASE}/auth/login/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const apiMessage = data?.error || (typeof data === "string" ? data : "");
        const reason =
          res.status === 401
            ? "Invalid username or password. Please check and try again."
            : res.status === 400 && (apiMessage || "").toLowerCase().includes("required")
              ? "Please enter both username and password."
              : apiMessage
                ? apiMessage
                : res.status === 500
                  ? "Something went wrong on the server. Please try again later."
                  : res.status >= 500
                    ? "The server is temporarily unavailable. Please try again later."
                    : "Login failed. Please try again.";
        setError(reason);
        return;
      }

      if (data?.token) setAuthToken(data.token);
      clearCachedUser();
      clearCachedEvents();
      setCachedUser({
        user_id: typeof data?.user_id === "number" ? data.user_id : 0,
        username: typeof data?.username === "string" ? data.username : username,
      });
      router.push("/home");
    } catch (err) {
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setError(
          "Cannot connect to server. The backend may be temporarily unavailable."
        );
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] flex items-center justify-center p-4">
      <MeshBackground />
      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="flex items-center justify-center gap-3 mr-5">
            <img src="/logo.png" alt="Civitas logo" className="h-16 w-16 mix-blend-multiply" />
            <span className="text-4xl font-extrabold tracking-tight text-slate-900">Civitas</span>
          </div>
          <p className="text-slate-500 text-sm mt-2">AI-powered government contract matching</p>
        </div>
        <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-8">
          <h1 className="text-2xl font-semibold text-slate-800 mb-1">
            Sign in
          </h1>
          <p className="text-slate-500 text-sm mb-6">
            Enter your credentials to access your account
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
                placeholder="Enter your username"
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
                autoComplete="current-password"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-700 placeholder:text-slate-500"
                placeholder="Enter your password"
              />
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 bg-[#3C89C6] text-white font-medium rounded-lg hover:bg-[#2d6da3] focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="text-[#3C89C6] font-medium hover:underline"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
