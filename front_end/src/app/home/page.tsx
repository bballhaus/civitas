"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import {
  getCurrentUser,
  getCachedProfile,
  type RfpTask,
  type PipelineStatus,
} from "@/lib/api";
import { trackEvent } from "@/lib/event-tracker";

interface TrackerRfp {
  id: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  status: PipelineStatus;
}

interface TrackerPayload {
  rfps: TrackerRfp[];
  tasks: RfpTask[];
}

const CARD_CLASS =
  "bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 overflow-hidden";

function StatCard({
  label,
  value,
  accent,
  icon,
  href,
}: {
  label: string;
  value: number;
  accent: "blue" | "emerald" | "amber" | "violet";
  icon: React.ReactNode;
  href?: string;
}) {
  const styles = {
    blue: "from-blue-500 to-blue-600",
    emerald: "from-emerald-500 to-emerald-600",
    amber: "from-amber-500 to-amber-600",
    violet: "from-violet-500 to-violet-600",
  };
  const textStyles = {
    blue: "text-blue-700",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    violet: "text-violet-700",
  };
  const inner = (
    <div className="bg-white/80 backdrop-blur-sm rounded-lg border border-white/60 shadow-sm shadow-slate-200/50 overflow-hidden">
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
  return href ? <Link href={href}>{inner}</Link> : inner;
}

interface CalEntry {
  date: Date;
  kind: "deadline" | "task";
  label: string;
  rfpId: string;
  rfpTitle?: string;
  completed?: boolean;
}

function buildCalendarEntries(payload: TrackerPayload): CalEntry[] {
  const entries: CalEntry[] = [];
  for (const rfp of payload.rfps) {
    if (!rfp.deadline) continue;
    const d = new Date(rfp.deadline);
    if (Number.isNaN(d.getTime())) continue;
    entries.push({ date: d, kind: "deadline", label: rfp.title, rfpId: rfp.id });
  }
  const rfpById = new Map(payload.rfps.map((r) => [r.id, r]));
  for (const t of payload.tasks) {
    if (!t.dueDate) continue;
    const d = new Date(t.dueDate);
    if (Number.isNaN(d.getTime())) continue;
    entries.push({
      date: d,
      kind: "task",
      label: t.label,
      rfpId: t.rfpId,
      rfpTitle: rfpById.get(t.rfpId)?.title,
      completed: !!t.completedAt,
    });
  }
  return entries;
}

function MiniCalendar({ entries }: { entries: CalEntry[] }) {
  // Snapshot the current date at mount so derived values (year, month) stay
  // stable across renders — the React Compiler flags re-derived locals as
  // potentially mutating dependencies.
  const [today] = useState(() => new Date());
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = today.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const entriesByDay = useMemo(() => {
    const m = new Map<number, CalEntry[]>();
    for (const e of entries) {
      if (e.date.getFullYear() !== year || e.date.getMonth() !== month) continue;
      const day = e.date.getDate();
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(e);
    }
    return m;
  }, [entries, year, month]);

  const cells: Array<{ day: number | null; entries: CalEntry[] }> = [];
  for (let i = 0; i < startDay; i++) cells.push({ day: null, entries: [] });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, entries: entriesByDay.get(d) ?? [] });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, entries: [] });

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-bold text-slate-900">{monthLabel}</h3>
        <Link href="/tracker" className="text-xs font-semibold text-[#3C89C6] hover:underline">
          Open full tracker &rarr;
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] font-bold text-slate-400 uppercase mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => {
          const isToday = c.day === today.getDate();
          const hasDeadline = c.entries.some((e) => e.kind === "deadline");
          const hasOpenTask = c.entries.some((e) => e.kind === "task" && !e.completed);
          return (
            <div
              key={i}
              className={`aspect-square rounded-md text-xs flex flex-col items-center justify-start p-1 ${
                c.day === null
                  ? ""
                  : isToday
                  ? "bg-[#3C89C6] text-white font-bold"
                  : c.entries.length > 0
                  ? "bg-slate-50 border border-slate-200 text-slate-800"
                  : "text-slate-500"
              }`}
            >
              {c.day !== null && (
                <>
                  <span>{c.day}</span>
                  {(hasDeadline || hasOpenTask) && (
                    <div className="flex gap-0.5 mt-0.5">
                      {hasDeadline && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                      {hasOpenTask && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> RFP deadline</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Open task</span>
      </div>
    </div>
  );
}

function statusLabel(s: PipelineStatus): string {
  return s === "in_progress" ? "In Progress" : s === "bid_submitted" ? "Bid Submitted" : s === "no_bid" ? "No-bid" : s.charAt(0).toUpperCase() + s.slice(1);
}

export default function HomePage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string>("");
  const [payload, setPayload] = useState<TrackerPayload>({ rfps: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    trackEvent("page_viewed", { pagePath: "/home" });
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
        } else {
          router.replace("/login");
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
    fetch("/api/tracker")
      .then((res) => (res.ok ? res.json() : { rfps: [], tasks: [] }))
      .then((data) => setPayload(data as TrackerPayload))
      .catch(() => setPayload({ rfps: [], tasks: [] }))
      .finally(() => setLoading(false));
  }, [authChecked]);

  const entries = useMemo(() => buildCalendarEntries(payload), [payload]);

  // Snapshot "now" at mount. The home page is a quick-look surface; re-running
  // the "due in 30 days" math against a fresh Date on every render isn't worth
  // fighting the React Compiler purity rule.
  const [nowMs] = useState(() => Date.now());

  const stats = useMemo(() => {
    const counts: Record<PipelineStatus, number> = {
      saved: 0,
      in_progress: 0,
      bid_submitted: 0,
      won: 0,
      lost: 0,
      no_bid: 0,
    };
    for (const r of payload.rfps) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const in30 = nowMs + 30 * 24 * 60 * 60 * 1000;
    const dueIn30 = payload.rfps.filter((r) => {
      if (!r.deadline) return false;
      const t = new Date(r.deadline).getTime();
      return !Number.isNaN(t) && t >= nowMs && t <= in30;
    }).length;
    return { ...counts, dueIn30 };
  }, [payload, nowMs]);

  const upcoming = useMemo(() => {
    const in30 = nowMs + 30 * 24 * 60 * 60 * 1000;
    return payload.rfps
      .filter((r) => {
        if (!r.deadline) return false;
        const d = new Date(r.deadline).getTime();
        return !Number.isNaN(d) && d >= nowMs && d <= in30;
      })
      .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())
      .slice(0, 7);
  }, [payload.rfps, nowMs]);

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
  const iconInProgress = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
  const iconBid = (
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
              Here&apos;s your overview: tracker pipeline, calendar, and upcoming deadlines.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/tracker"
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white text-slate-700 font-semibold border border-slate-200 hover:bg-slate-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Open Tracker
            </Link>
            <Link
              href="/matches"
              className="flex items-center gap-3 px-5 py-2.5 rounded-xl bg-[#3C89C6] text-white shadow-lg shadow-[#3C89C6]/25 hover:bg-[#2d6fa0] hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 ease-out group border border-[#2d6fa0]/20"
            >
              <svg className="w-5 h-5 text-white shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              <span className="font-semibold">View Matches</span>
            </Link>
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-8">
          <StatCard label="Saved" value={stats.saved} accent="blue" icon={iconSaved} href="/tracker" />
          <StatCard label="In progress" value={stats.in_progress} accent="violet" icon={iconInProgress} href="/tracker" />
          <StatCard label="Bid submitted" value={stats.bid_submitted} accent="emerald" icon={iconBid} href="/tracker" />
          <StatCard label="Due in 30 days" value={stats.dueIn30} accent="amber" icon={iconDeadline} href="/tracker" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Mini calendar (spans 2 cols on lg) */}
          <div className={`${CARD_CLASS} lg:col-span-2 p-5`}>
            {loading ? (
              <p className="text-sm text-slate-500 py-10 text-center">Loading calendar&hellip;</p>
            ) : (
              <MiniCalendar entries={entries} />
            )}
          </div>

          {/* Upcoming deadlines */}
          <div className={`${CARD_CLASS} border-l-4 border-l-amber-500`}>
            <div className="px-5 py-3 bg-gradient-to-r from-amber-50/80 to-white/80 border-b border-slate-100 font-bold text-slate-900 flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-white shadow-md">
                {iconDeadline}
              </span>
              Upcoming deadlines
              {stats.dueIn30 > 0 && (
                <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  {stats.dueIn30} in 30 days
                </span>
              )}
            </div>
            <div className="p-3">
              {loading ? (
                <p className="text-sm text-slate-500 px-2">Loading&hellip;</p>
              ) : upcoming.length === 0 ? (
                <p className="text-sm text-slate-600 px-2 py-2">
                  No upcoming deadlines in your tracker.{" "}
                  <Link href="/matches" className="text-[#3C89C6] font-semibold hover:underline">
                    Browse opportunities
                  </Link>
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {upcoming.map((rfp) => (
                    <li key={rfp.id}>
                      <Link
                        href={`/matches/${encodeURIComponent(rfp.id)}`}
                        className="block p-2.5 rounded-lg border border-slate-100 hover:border-amber-200 hover:bg-amber-50/50 transition-all"
                      >
                        <p className="font-semibold text-slate-900 text-sm line-clamp-2">{rfp.title}</p>
                        <div className="flex items-center justify-between mt-1 gap-2">
                          <span className="text-xs text-slate-500 truncate">{rfp.agency ?? "Unknown agency"}</span>
                          <span className="shrink-0 text-[11px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                            {new Date(rfp.deadline!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        </div>
                        <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mt-1">
                          {statusLabel(rfp.status)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
