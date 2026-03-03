"use client";

/**
 * Full-page loading screen while waiting for API (e.g. user/profile from AWS).
 * Use while getCurrentUser() or other auth/profile requests are in flight.
 */
export function LoadingScreen({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center justify-center gap-4">
      <div
        className="animate-spin rounded-full h-12 w-12 border-2 border-[#2563eb] border-t-transparent"
        aria-hidden
      />
      <p className="text-slate-600 text-sm font-medium">{message}</p>
    </div>
  );
}
