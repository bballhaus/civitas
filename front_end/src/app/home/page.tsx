"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { getCurrentUser } from "@/lib/api";
import type { RFP } from "@/lib/rfp-matching";

const STORAGE_KEYS = {
  SAVED: "civitas_saved_rfps",
  EXPRESSED_INTEREST: "civitas_expressed_interest_rfps",
};

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
  "bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden";

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
    blue: "bg-blue-50 border-blue-200 text-blue-700 [&_.accent]:bg-blue-500 [&_.accent-ring]:ring-blue-100",
    emerald:
      "bg-emerald-50 border-emerald-200 text-emerald-700 [&_.accent]:bg-emerald-500 [&_.accent-ring]:ring-emerald-100",
    amber:
      "bg-amber-50 border-amber-200 text-amber-700 [&_.accent]:bg-amber-500 [&_.accent-ring]:ring-amber-100",
    violet:
      "bg-violet-50 border-violet-200 text-violet-700 [&_.accent]:bg-violet-500 [&_.accent-ring]:ring-violet-100",
  };
  return (
    <div
      className={`rounded-xl border-2 overflow-hidden transition-all hover:shadow-md ${styles[accent]}`}
    >
      <div className="px-5 py-4 flex items-start gap-4">
        <div className="accent w-10 h-10 rounded-lg flex items-center justify-center text-white shrink-0 ring-4 accent-ring">
          {icon}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider opacity-90">
            {label}
          </p>
          <p className="text-2xl font-bold mt-0.5">{value}</p>
          <p className="text-xs opacity-80 mt-1">{subtext}</p>
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
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    setSavedIds(loadSet(STORAGE_KEYS.SAVED));
    setExpressedIds(loadSet(STORAGE_KEYS.EXPRESSED_INTEREST));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setDisplayName(data.username || "there");
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
        setRfps(data.events ?? []);
      })
      .catch(() => setRfps([]))
      .finally(() => setLoading(false));
  }, [authChecked]);

  const savedRfps = rfps.filter((r) => savedIds.has(r.id));
  const appliedRfps = rfps.filter((r) => expressedIds.has(r.id));
  const relevantForDeadlines = [
    ...savedRfps,
    ...appliedRfps.filter((r) => !savedIds.has(r.id)),
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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#3C89C6]" />
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
  const iconDeadline = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-blue-50/30 to-slate-50">
      <AppHeader
        rightContent={
          <div className="flex items-center gap-4">
            <Link
              href="/profile"
              className="text-slate-600 hover:text-slate-900 text-sm font-medium"
            >
              Profile
            </Link>
            <Link
              href="/dashboard"
              className="text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-[#3C89C6] to-blue-600 text-white hover:from-[#2d6fa0] hover:to-blue-700 shadow-sm transition-all"
            >
              View all RFPs
            </Link>
          </div>
        }
      />

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">
            Welcome back{displayName !== "there" ? `, ${displayName}` : ""}
          </h1>
          <p className="text-slate-600 text-sm">
            Here’s your overview: saved opportunities, applications, and
            upcoming deadlines.
          </p>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
          <StatCard
            label="Saved"
            value={savedIds.size}
            subtext="RFPs in your list"
            accent="blue"
            icon={iconSaved}
          />
          <StatCard
            label="Applied"
            value={expressedIds.size}
            subtext="Interest expressed"
            accent="emerald"
            icon={iconApplied}
          />
          <StatCard
            label="Due in 30 days"
            value={dueIn30Count}
            subtext="From saved or applied"
            accent="amber"
            icon={iconDeadline}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Saved RFPs */}
          <div className={`${CARD_CLASS} border-l-4 border-l-blue-500`}>
            <div className="px-5 py-4 bg-gradient-to-r from-blue-50 to-white border-b border-slate-100 font-semibold text-slate-900 flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center text-white">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                </svg>
              </span>
              Saved RFPs
              {savedIds.size > 0 && (
                <span className="text-sm font-normal text-blue-600">
                  ({savedIds.size})
                </span>
              )}
            </div>
            <div className="p-4">
              {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : savedRfps.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No saved RFPs yet.{" "}
                  <Link
                    href="/dashboard"
                    className="text-blue-600 font-medium hover:underline"
                  >
                    Browse opportunities
                  </Link>
                </p>
              ) : (
                <ul className="space-y-2">
                  {savedRfps.slice(0, 5).map((rfp) => (
                    <li key={rfp.id}>
                      <Link
                        href={`/dashboard/rfp/${encodeURIComponent(rfp.id)}`}
                        className="block p-3 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/50 transition-colors border-l-2 border-l-blue-400"
                      >
                        <p className="font-medium text-slate-900 text-sm line-clamp-2">
                          {rfp.title}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          {rfp.agency} · {formatDeadlineShort(rfp.deadline)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {savedRfps.length > 5 && (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 mt-3 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline"
                >
                  View all saved on dashboard →
                </Link>
              )}
            </div>
          </div>

          {/* Applied / Expressed interest */}
          <div className={`${CARD_CLASS} border-l-4 border-l-emerald-500`}>
            <div className="px-5 py-4 bg-gradient-to-r from-emerald-50 to-white border-b border-slate-100 font-semibold text-slate-900 flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-white">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              Applied / Expressed interest
              {expressedIds.size > 0 && (
                <span className="text-sm font-normal text-emerald-600">
                  ({expressedIds.size})
                </span>
              )}
            </div>
            <div className="p-4">
              {loading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : appliedRfps.length === 0 ? (
                <p className="text-sm text-slate-600">
                  You haven’t expressed interest in any RFPs yet. Use “Express
                  interest” on the dashboard when you find a good match.
                </p>
              ) : (
                <ul className="space-y-2">
                  {appliedRfps.slice(0, 5).map((rfp) => (
                    <li key={rfp.id}>
                      <Link
                        href={`/dashboard/rfp/${encodeURIComponent(rfp.id)}`}
                        className="block p-3 rounded-lg border border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/50 transition-colors border-l-2 border-l-emerald-400"
                      >
                        <p className="font-medium text-slate-900 text-sm line-clamp-2">
                          {rfp.title}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          {rfp.agency} · {formatDeadlineShort(rfp.deadline)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {appliedRfps.length > 5 && (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1 mt-3 text-sm font-medium text-emerald-600 hover:text-emerald-700 hover:underline"
                >
                  View all on dashboard →
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Upcoming deadlines */}
        <div className={`${CARD_CLASS} mt-6 border-l-4 border-l-amber-500`}>
          <div className="px-5 py-4 bg-gradient-to-r from-amber-50 to-white border-b border-slate-100 font-semibold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center text-white">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </span>
            Upcoming deadlines
            {upcomingDeadlines.length > 0 && (
              <span className="text-sm font-normal text-amber-700">
                {dueIn30Count} due in the next 30 days
              </span>
            )}
          </div>
          <div className="p-4">
            {loading ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : upcomingDeadlines.length === 0 ? (
              <p className="text-sm text-slate-600">
                No upcoming deadlines in the next 30 days from your saved or
                applied RFPs.
              </p>
            ) : (
              <ul className="space-y-2">
                {upcomingDeadlines.map((rfp) => (
                  <li key={rfp.id}>
                    <Link
                      href={`/dashboard/rfp/${encodeURIComponent(rfp.id)}`}
                      className="flex items-center justify-between gap-4 p-3 rounded-lg border border-slate-100 hover:border-amber-200 hover:bg-amber-50/50 transition-colors border-l-2 border-l-amber-400"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 text-sm line-clamp-1">
                          {rfp.title}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {rfp.agency}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-amber-800 bg-amber-100 px-2.5 py-1 rounded-md">
                        {formatDeadlineShort(rfp.deadline)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1 text-sm font-medium text-violet-600 hover:text-violet-700 hover:underline"
              >
                View all RFPs and filters →
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
