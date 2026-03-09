"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import { getCurrentUser, getCachedUser, getCachedProfile } from "@/lib/api";
import { setCachedEvents } from "@/lib/events-cache";
import type { RFP } from "@/lib/rfp-matching";

const STORAGE_KEYS = {
  SAVED: "civitas_saved_rfps",
  EXPRESSED_INTEREST: "civitas_expressed_interest_rfps",
};
const RFP_PRELOAD_KEY = "civitas_preload_rfp";

function preloadRfpAndNavigate(rfp: RFP, router: ReturnType<typeof useRouter>) {
  try {
    sessionStorage.setItem(RFP_PRELOAD_KEY, JSON.stringify(rfp));
  } catch {
    // ignore quota / private mode
  }
  router.push("/dashboard");
}

function loadSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function parseDeadline(deadline: string): Date | null {
  const normalized = deadline?.trim();
  if (!normalized || normalized.toUpperCase() === "TBD") return null;
  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return new Date(direct);
  const cleaned = normalized
    .replace(/\b(PST|PDT)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)$/i
  );
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  let hh = Number(m[4]);
  const min = Number(m[5]);
  const ampm = m[6].toUpperCase();
  if (ampm === "PM" && hh !== 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;
  return new Date(yyyy, mm - 1, dd, hh, min, 0);
}

function formatDeadlineShort(deadline: string): string {
  const d = parseDeadline(deadline);
  if (!d) return "TBD";
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "Past";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays <= 7) return `${diffDays}d`;
  if (diffDays <= 30) return `${diffDays}d`;
  return d.toLocaleDateString();
}

const CARD_CLASS =
  "bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 overflow-hidden";

function StatCard({
  label,
  value,
  subtext,
  accent,
  icon,
}: {
  label: string;
  value: number;
  subtext: string;
  accent: "blue" | "emerald" | "amber" | "violet";
  icon: React.ReactNode;
}) {
  const styles = {
    blue: "from-blue-500 to-blue-600 ring-blue-200",
    emerald: "from-emerald-500 to-emerald-600 ring-emerald-200",
    amber: "from-amber-500 to-amber-600 ring-amber-200",
    violet: "from-violet-500 to-violet-600 ring-violet-200",
  };
  const textStyles = {
    blue: "text-blue-700",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    violet: "text-violet-700",
  };
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-lg border border-white/60 shadow-sm shadow-slate-200/50 overflow-hidden group">
      <div className="px-3 py-2 flex items-center gap-2">
        <div className={`bg-gradient-to-br ${styles[accent]} w-6 h-6 rounded-md flex items-center justify-center text-white shrink-0`}>
          {icon}
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p>
          <p className={`text-lg font-extrabold leading-tight ${textStyles[accent]}`}>{value}</p>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string>("");
  const [rfps, setRfps] = useState<RFP[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [expressedIds, setExpressedIds] = useState<Set<string>>(new Set());
  const [appliedRfpIds, setAppliedRfpIds] = useState<Set<string>>(new Set());
  const [inProgressRfpIds, setInProgressRfpIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    setSavedIds(loadSet(STORAGE_KEYS.SAVED));
    setExpressedIds(loadSet(STORAGE_KEYS.EXPRESSED_INTEREST));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser(true)
      .then((data) => {
        if (cancelled) return;
        if (data) {
          const cached = getCachedProfile(data.user_id);
          const companyName = cached?.companyName?.trim();
          setDisplayName(companyName || data.username || "there");
          setAppliedRfpIds(new Set(data.applied_rfp_ids ?? []));
          setInProgressRfpIds(new Set(data.in_progress_rfp_ids ?? []));
        } else {
          router.replace("/login");
          return;
        }
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    fetch("/api/events")
      .then((res) => (res.ok ? res.json() : { events: [] }))
      .then((data) => {
        const events = data.events ?? [];
        setRfps(events);
        if (events.length > 0) setCachedEvents(events);
      })
      .catch(() => setRfps([]))
      .finally(() => setLoading(false));
  }, [authChecked]);

  const savedRfps = rfps.filter((r) => savedIds.has(r.id));
  const appliedRfps = rfps.filter((r) => appliedRfpIds.has(r.id));
  const inProgressRfps = rfps.filter((r) => inProgressRfpIds.has(r.id));
  const relevantForDeadlines = [
    ...savedRfps,
    ...appliedRfps.filter((r) => !savedIds.has(r.id)),
    ...inProgressRfps.filter((r) => !savedIds.has(r.id) && !appliedRfpIds.has(r.id)),
  ];
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const upcomingDeadlines = relevantForDeadlines
    .map((r) => ({ rfp: r, date: parseDeadline(r.deadline) }))
    .filter(({ date }) => date && date >= now && date <= in30Days)
    .sort((a, b) => (a.date!.getTime() - b.date!.getTime()))
    .slice(0, 7)
    .map(({ rfp }) => rfp);

  const dueIn30Count = relevantForDeadlines.filter((r) => {
    const d = parseDeadline(r.deadline);
    return d && d >= now && d <= in30Days;
  }).length;

  if (!authChecked) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading home page&hellip;</p>
        </div>
      </div>
    );
  }

  const iconSaved = (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
    </svg>
  );
  const iconApplied = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
  const iconInProgress = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
  const iconDeadline = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />

      <AppHeader />

      <main className="relative max-w-7xl mx-auto px-6 md:px-10 py-10">
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">
              Welcome back{displayName !== "there" ? `, ${displayName}` : ""}
            </h1>
            <p className="text-slate-600 text-sm">
              {"Here's your overview: saved opportunities, applications, and upcoming deadlines."}
            </p>
          </div>
          <button
            onClick={() => {
              if (authChecked) router.push("/dashboard");
            }}
            disabled={!authChecked}
            className="shrink-0 w-full sm:w-auto flex items-center justify-center gap-3 px-5 py-3 rounded-xl bg-[#3C89C6] text-white shadow-lg shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] hover:shadow-xl hover:shadow-[#3C89C6]/30 hover:-translate-y-0.5 transition-all duration-200 ease-out group border border-[#2d6fa0]/20 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0">
            <svg className="w-5 h-5 text-white shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <span className="font-semibold">{authChecked ? "View Matches" : "Loading…"}</span>
            <svg className="w-4 h-4 text-white/90 group-hover:text-white group-hover:translate-x-0.5 shrink-0 transition-all duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
          <StatCard
            label="Saved"
            value={savedIds.size}
            subtext="RFPs in your list"
            accent="blue"
            icon={iconSaved}
          />
          <StatCard
            label="Applied"
            value={appliedRfps.length}
            subtext="Marked as applied"
            accent="emerald"
            icon={iconApplied}
          />
          <StatCard
            label="In progress"
            value={inProgressRfps.length}
            subtext="POA / plan generated"
            accent="violet"
            icon={iconInProgress}
          />
          <StatCard
            label="Due in 30 days"
            value={dueIn30Count}
            subtext="From saved, applied, or in progress"
            accent="amber"
            icon={iconDeadline}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Saved RFPs */}
          <div className={`${CARD_CLASS} border-l-4 border-l-blue-500`}>
            <div className="px-5 py-4 bg-gradient-to-r from-blue-50/80 to-white/80 border-b border-slate-100 font-bold text-slate-900 flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white shadow-md">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                </svg>
              </span>
              Saved RFPs
              {savedIds.size > 0 && (
                <span className="text-sm font-semibold text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
                  {savedIds.size}
                </span>
              )}
            </div>
            <div className="p-4">
              {loading ? (
                <p className="text-sm text-slate-500">Loading&hellip;</p>
              ) : savedRfps.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No saved RFPs yet.{" "}
                  <Link
                    href="/dashboard"
                    className="text-blue-600 font-semibold hover:underline"
                  >
                    Browse opportunities
                  </Link>
                </p>
              ) : (
                <div className={savedRfps.length >= 2 ? "min-h-0 max-h-[11rem] overflow-y-scroll overflow-x-hidden" : ""}>
                  <ul className="space-y-2">
                    {savedRfps.slice(0, 5).map((rfp) => (
                      <li key={rfp.id}>
                        <button
                          type="button"
                          onClick={() => preloadRfpAndNavigate(rfp, router)}
                          className="w-full text-left block p-3 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/50 transition-all hover:shadow-sm border-l-2 border-l-blue-400"
                        >
                          <p className="font-semibold text-slate-900 text-sm line-clamp-2">
                            {rfp.title}
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            {rfp.agency} &middot; {formatDeadlineShort(rfp.deadline)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {savedRfps.length > 5 && (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700 hover:underline"
                >
                  View all saved on dashboard &rarr;
                </Link>
              )}
            </div>
          </div>

          {/* Applied / Expressed interest */}
          <div className={`${CARD_CLASS} border-l-4 border-l-emerald-500`}>
            <div className="px-5 py-4 bg-gradient-to-r from-emerald-50/80 to-white/80 border-b border-slate-100 font-bold text-slate-900 flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-white shadow-md">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              Applied
              {appliedRfps.length > 0 && (
                <span className="text-sm font-semibold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">
                  {appliedRfps.length}
                </span>
              )}
            </div>
            <div className="p-4">
              {loading ? (
                <p className="text-sm text-slate-500">Loading&hellip;</p>
              ) : appliedRfps.length === 0 ? (
                <p className="text-sm text-slate-600">
                  You haven&apos;t marked any RFPs as applied yet. Use &quot;I&apos;ve applied&quot; on the dashboard when you&apos;ve submitted an application.
                </p>
              ) : (
                <div className={appliedRfps.length >= 2 ? "min-h-0 max-h-[11rem] overflow-y-scroll overflow-x-hidden" : ""}>
                  <ul className="space-y-2">
                    {appliedRfps.slice(0, 5).map((rfp) => (
                      <li key={rfp.id}>
                        <button
                          type="button"
                          onClick={() => preloadRfpAndNavigate(rfp, router)}
                          className="w-full text-left block p-3 rounded-xl border border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/50 transition-all hover:shadow-sm border-l-2 border-l-emerald-400"
                        >
                          <p className="font-semibold text-slate-900 text-sm line-clamp-2">
                            {rfp.title}
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            {rfp.agency} &middot; {formatDeadlineShort(rfp.deadline)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {appliedRfps.length > 5 && (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-emerald-600 hover:text-emerald-700 hover:underline"
                >
                  View all on dashboard &rarr;
                </Link>
              )}
            </div>
          </div>

          {/* In progress (POA / plan of action generated) */}
          <div className={`${CARD_CLASS} border-l-4 border-l-violet-500`}>
            <div className="px-5 py-4 bg-gradient-to-r from-violet-50/80 to-white/80 border-b border-slate-100 font-bold text-slate-900 flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center text-white shadow-md">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
              </span>
              In progress
              {inProgressRfps.length > 0 && (
                <span className="text-sm font-semibold text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full">
                  {inProgressRfps.length}
                </span>
              )}
            </div>
            <div className="p-4">
              {loading ? (
                <p className="text-sm text-slate-500">Loading&hellip;</p>
              ) : inProgressRfps.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No RFPs in progress yet. Generate a Plan of Execution on the dashboard to track them here.
                </p>
              ) : (
                <div className={inProgressRfps.length >= 2 ? "min-h-0 max-h-[11rem] overflow-y-scroll overflow-x-hidden" : ""}>
                  <ul className="space-y-2">
                    {inProgressRfps.slice(0, 5).map((rfp) => (
                      <li key={rfp.id}>
                        <button
                          type="button"
                          onClick={() => preloadRfpAndNavigate(rfp, router)}
                          className="w-full text-left block p-3 rounded-xl border border-slate-100 hover:border-violet-200 hover:bg-violet-50/50 transition-all hover:shadow-sm border-l-2 border-l-violet-400"
                        >
                          <p className="font-semibold text-slate-900 text-sm line-clamp-2">
                            {rfp.title}
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            {rfp.agency} &middot; {formatDeadlineShort(rfp.deadline)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {inProgressRfps.length > 5 && (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-violet-600 hover:text-violet-700 hover:underline"
                >
                  View all on dashboard &rarr;
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Upcoming deadlines */}
        <div className={`${CARD_CLASS} mt-6 border-l-4 border-l-amber-500`}>
          <div className="px-5 py-4 bg-gradient-to-r from-amber-50/80 to-white/80 border-b border-slate-100 font-bold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-white shadow-md">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </span>
            Upcoming deadlines
            {upcomingDeadlines.length > 0 && (
              <span className="text-sm font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                {dueIn30Count} due in 30 days
              </span>
            )}
          </div>
          <div className="p-4">
            {loading ? (
              <p className="text-sm text-slate-500">Loading&hellip;</p>
            ) : upcomingDeadlines.length === 0 ? (
              <p className="text-sm text-slate-600">
                No upcoming deadlines in the next 30 days from your saved or
                applied RFPs.
              </p>
            ) : (
              <div className={upcomingDeadlines.length >= 2 ? "min-h-0 max-h-[11rem] overflow-y-scroll overflow-x-hidden" : ""}>
                <ul className="space-y-2">
                  {upcomingDeadlines.map((rfp) => (
                    <li key={rfp.id}>
                      <button
                        type="button"
                        onClick={() => preloadRfpAndNavigate(rfp, router)}
                        className="w-full text-left flex items-center justify-between gap-4 p-3 rounded-xl border border-slate-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all hover:shadow-sm border-l-2 border-l-amber-400"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 text-sm line-clamp-1">
                            {rfp.title}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {rfp.agency}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-bold text-amber-800 bg-amber-100 px-2.5 py-1 rounded-lg">
                          {formatDeadlineShort(rfp.deadline)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1 text-sm font-semibold text-[#3C89C6] hover:text-[#2d6fa0] hover:underline"
              >
                View all RFPs and filters &rarr;
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
