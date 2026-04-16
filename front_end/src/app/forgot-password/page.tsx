"use client";

import { useState } from "react";
import Link from "next/link";
import { MeshBackground } from "@/components/MeshBackground";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Cannot connect to server. Please try again later.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative">
      <MeshBackground />
      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl shadow-xl border border-white/20 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Reset Password</h1>
          <p className="text-gray-600 mb-6">
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>

          {submitted ? (
            <div className="text-center">
              <div className="p-4 rounded-lg bg-green-50 text-green-700 mb-4">
                If an account with that email exists, a reset link has been sent.
                Check your email (or console in dev mode).
              </div>
              <Link href="/login" className="text-blue-600 hover:underline">
                Back to login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="you@example.com"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {isLoading ? "Sending..." : "Send Reset Link"}
              </button>

              <p className="text-center text-sm text-gray-600">
                Remember your password?{" "}
                <Link href="/login" className="text-blue-600 hover:underline">
                  Log in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
