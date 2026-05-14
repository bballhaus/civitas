"use client";

// v2 match dashboard (Architecture-v2 § 12).
//
// Lives at /matches alongside the existing /dashboard so the v2 surface
// can be evaluated without breaking the v1 features users already rely on
// (saved/applied/in_progress filters, proposal/POE generation). Once the
// v2 path covers those, this should be promoted to /dashboard.
//
// Differences from v1 worth noting:
//   - Score and win_probability are surfaced separately. A high score
//     with a low win_probability = "good fit, likely renewal — not worth
//     bidding." Spec § 9.8.
//   - Each card carries a data_quality badge so the user knows whether
//     they're looking at full extracted requirements or thin-source title-only.
//   - Incumbent chips: red when state=likely (with named vendor), green
//     when state=open_field. No chip when state=unknown — don't fake
//     precision the matcher doesn't have.
//   - "Hide likely incumbents" filter (§ 12).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";

interface MatchListItem {
  rfpId: string;
  title: string;
  agency: string | null;
  location: string | null;
  deadline: string | null;
  sourceId: string;
  estimatedValueUsd: number | null;
  score: number;
  winProbability: number;
  tier: "excellent" | "strong" | "moderate" | "low" | "minimal" | "not_eligible";
  primeEligible: boolean;
  subEligible: boolean;
  incumbentState: "likely" | "open_field" | "unknown";
  incumbentVendor: string | null;
  dataQuality: {
    sourceId: string;
    hasPdfExtraction: boolean;
    hasMarketIntel: boolean;
    coverage: "full" | "requirements_only" | "market_intel_only" | "thin";
  };
  topReasons: { category: string; status: string; detail: string }[];
}

interface MatchResponse {
  count: number;
  profileCompleteness: number;
  matches: MatchListItem[];
}

const TIER_STYLES: Record<MatchListItem["tier"], { dot: string; chip: string; label: string }> = {
  excellent: { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Excellent" },
  strong: { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-700 border-blue-200", label: "Strong" },
  moderate: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700 border-amber-200", label: "Moderate" },
  low: { dot: "bg-slate-400", chip: "bg-slate-50 text-slate-600 border-slate-200", label: "Low" },
  minimal: { dot: "bg-slate-300", chip: "bg-slate-50 text-slate-500 border-slate-200", label: "Minimal" },
  not_eligible: { dot: "bg-red-400", chip: "bg-red-50 text-red-700 border-red-200", label: "Not eligible as prime" },
};

const COVERAGE_LABEL: Record<MatchListItem["dataQuality"]["coverage"], { label: string; tone: string }> = {
  full: { label: "Full data", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  requirements_only: { label: "Requirements only", tone: "bg-blue-50 text-blue-700 border-blue-200" },
  market_intel_only: { label: "Market intel only", tone: "bg-violet-50 text-violet-700 border-violet-200" },
  thin: { label: "Thin data", tone: "bg-amber-50 text-amber-700 border-amber-200" },
};

function formatUsd(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

function formatDeadline(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const diffDays = Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return "Past";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays <= 7) return `${diffDays}d`;
  if (diffDays <= 30) return `${diffDays}d`;
  return d.toLocaleDateString();
}

export default function MatchesPage() {
  const router = useRouter();
  const [data, setData] = useState<MatchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideIncumbents, setHideIncumbents] = useState(false);
  const [minScore, setMinScore] = useState<number>(0);
  const [sourceFilter, setSourceFilter] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/match/", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return null;
        }
        if (!res.ok) throw new Error(`Failed to load matches (${res.status})`);
        return res.json() as Promise<MatchResponse>;
      })
      .then((d) => {
        if (cancelled || !d) return;
        setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const sources = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set(data.matches.map((m) => m.sourceId));
    return Array.from(set).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as MatchListItem[];
    return data.matches.filter((m) => {
      if (hideIncumbents && m.incumbentState === "likely") return false;
      if (m.score < minScore) return false;
      if (sourceFilter && m.sourceId !== sourceFilter) return false;
      return true;
    });
  }, [data, hideIncumbents, minScore, sourceFilter]);

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading matches&hellip;</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <main className="relative max-w-3xl mx-auto px-6 md:px-10 py-10">
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-red-500 p-6">
            <h2 className="text-lg font-bold text-red-700">Couldn&apos;t load matches</h2>
            <p className="text-sm text-slate-600 mt-2">{error}</p>
            <p className="text-xs text-slate-500 mt-4">
              If you just signed up, the rfp_cache table might be empty.
              Run <code className="px-1 py-0.5 bg-slate-100 rounded">npm run rfp-cache:populate</code> on the server.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-7xl mx-auto px-6 md:px-10 py-10">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-1">Matches</h1>
            <p className="text-slate-600 text-sm">
              {data?.count ?? 0} open RFPs scored against your profile
              {data?.profileCompleteness !== undefined && (
                <>
                  {" "}· profile {data.profileCompleteness}% complete
                </>
              )}
            </p>
          </div>
        </div>

        {/* Filter strip */}
        <div className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-sm shadow-slate-200/50 p-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={hideIncumbents}
              onChange={(e) => setHideIncumbents(e.target.checked)}
              className="rounded text-[#3C89C6] focus:ring-[#3C89C6]"
            />
            <span>Hide likely incumbents</span>
          </label>
          <div className="h-5 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <label htmlFor="minScore" className="text-sm text-slate-700">Min score</label>
            <select
              id="minScore"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="px-2 py-1 border border-slate-300 rounded-md bg-white text-sm text-slate-700"
            >
              <option value={0}>Any</option>
              <option value={15}>15+ (low)</option>
              <option value={35}>35+ (moderate)</option>
              <option value={55}>55+ (strong)</option>
              <option value={75}>75+ (excellent)</option>
            </select>
          </div>
          <div className="h-5 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <label htmlFor="source" className="text-sm text-slate-700">Source</label>
            <select
              id="source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded-md bg-white text-sm text-slate-700"
            >
              <option value="">All</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto text-xs text-slate-500">
            Showing {filtered.length} of {data?.matches.length ?? 0}
          </div>
        </div>

        {/* Results */}
        {filtered.length === 0 ? (
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-8 text-center">
            <p className="text-slate-600 text-sm">No matches under these filters.</p>
            {data?.matches.length === 0 && (
              <p className="text-xs text-slate-500 mt-3">
                If your rfp_cache is empty, run{" "}
                <code className="px-1 py-0.5 bg-slate-100 rounded">npm run rfp-cache:populate</code> on the server.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filtered.map((m) => (
              <MatchCard key={m.rfpId} m={m} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function MatchCard({ m }: { m: MatchListItem }) {
  const tier = TIER_STYLES[m.tier];
  const coverage = COVERAGE_LABEL[m.dataQuality.coverage];

  return (
    <Link
      href={`/matches/${encodeURIComponent(m.rfpId)}`}
      className="block bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 ease-out overflow-hidden group"
    >
      <div className="p-5 border-l-4" style={{ borderLeftColor: tierAccent(m.tier) }}>
        {/* Top row: score + win_prob */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-slate-900 text-sm leading-snug line-clamp-2 group-hover:text-[#3C89C6] transition-colors">
              {m.title}
            </h3>
            <p className="text-xs text-slate-500 mt-1 truncate">
              {m.agency ?? "Unknown agency"}
              {m.location ? ` · ${m.location}` : ""}
            </p>
          </div>
          <ScoreBadges score={m.score} winProbability={m.winProbability} tier={m.tier} />
        </div>

        {/* Chips row */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${tier.chip}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${tier.dot}`} />
            {tier.label}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${coverage.tone}`}>
            {coverage.label}
          </span>
          {m.incumbentState === "likely" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200 text-xs font-semibold">
              ⚠ Incumbent likely
              {m.incumbentVendor && <span className="font-normal opacity-80">· {m.incumbentVendor}</span>}
            </span>
          )}
          {m.incumbentState === "open_field" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 text-xs font-semibold">
              ✓ Open field
            </span>
          )}
          {!m.primeEligible && m.subEligible && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full border bg-violet-50 text-violet-700 border-violet-200 text-xs font-semibold">
              Sub track
            </span>
          )}
        </div>

        {/* Reasons */}
        {m.topReasons.length > 0 && (
          <ul className="space-y-1 mb-3">
            {m.topReasons.slice(0, 2).map((r) => (
              <li key={r.category} className="text-xs text-slate-600 line-clamp-1">
                <span className="font-semibold text-slate-700">{r.category}:</span> {r.detail}
              </li>
            ))}
          </ul>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-100">
          <span>{formatUsd(m.estimatedValueUsd)}</span>
          <span className="font-semibold text-slate-700">{formatDeadline(m.deadline)}</span>
        </div>
      </div>
    </Link>
  );
}

function ScoreBadges({
  score,
  winProbability,
  tier,
}: {
  score: number;
  winProbability: number;
  tier: MatchListItem["tier"];
}) {
  if (tier === "not_eligible") {
    return (
      <div className="text-right shrink-0">
        <div className="text-xs font-bold text-red-700">Not eligible</div>
        <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">as prime</div>
      </div>
    );
  }
  // Render both score and win_probability stacked, with win_prob shown
  // only when meaningfully different (i.e. incumbent multiplier was applied).
  const gap = score - winProbability;
  return (
    <div className="text-right shrink-0">
      <div className="text-2xl font-extrabold text-slate-900 leading-none">{score}</div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-0.5">match</div>
      {gap > 1 && (
        <div className="mt-1.5">
          <div className="text-sm font-bold text-amber-700 leading-none">{winProbability}</div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mt-0.5">win prob</div>
        </div>
      )}
    </div>
  );
}

function tierAccent(tier: MatchListItem["tier"]): string {
  switch (tier) {
    case "excellent":
      return "rgb(16 185 129)"; // emerald-500
    case "strong":
      return "rgb(59 130 246)"; // blue-500
    case "moderate":
      return "rgb(245 158 11)"; // amber-500
    case "low":
      return "rgb(148 163 184)"; // slate-400
    case "not_eligible":
      return "rgb(248 113 113)"; // red-400
    default:
      return "rgb(203 213 225)"; // slate-300
  }
}
