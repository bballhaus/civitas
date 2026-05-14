"use client";

// v2 RFP match detail (Architecture-v2 § 12).
//
// Prime + Sub tracks as tabs (spec § 9.7). Each scoring category prints a
// human-readable citation: the RFP phrase + the profile claim that backed
// it (spec § 9.10). Top of page shows a data_quality summary so the user
// knows whether they're reading full extracted requirements or just a title.

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";

type CategoryStatus = "strong" | "partial" | "weak" | "missing" | "neutral" | "unknown";

interface CategoryBreakdown {
  category: string;
  status: CategoryStatus;
  score: number | null;
  weight: number;
  detail: string;
  rfpPhrase?: string;
  profileClaim?: string;
  profileClaimSource?: string;
}

interface DetailResponse {
  rfp: {
    id: string;
    title: string;
    description: string | null;
    agency: string | null;
    location: string | null;
    deadline: string | null;
    sourceId: string;
    estimatedValueUsd: number | null;
  };
  score: number;
  winProbability: number;
  tier: "excellent" | "strong" | "moderate" | "low" | "minimal" | "not_eligible";
  primeEligible: boolean;
  subEligible: boolean;
  gateFailures: string[];
  incumbent: {
    state: "likely" | "open_field" | "unknown";
    confidence: number | null;
    source: string;
    namedVendor?: string;
    contractEnd?: string;
  };
  dataQuality: {
    sourceId: string;
    hasPdfExtraction: boolean;
    hasMarketIntel: boolean;
    coverage: "full" | "requirements_only" | "market_intel_only" | "thin";
  };
  breakdown: CategoryBreakdown[];
  subTrack: {
    eligible: boolean;
    score: number;
    breakdown: CategoryBreakdown[];
  };
}

const STATUS_STYLES: Record<CategoryStatus, { dot: string; chip: string; label: string }> = {
  strong: { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Strong" },
  partial: { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-700 border-blue-200", label: "Partial" },
  weak: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700 border-amber-200", label: "Weak" },
  missing: { dot: "bg-red-400", chip: "bg-red-50 text-red-700 border-red-200", label: "Missing" },
  neutral: { dot: "bg-slate-300", chip: "bg-slate-50 text-slate-500 border-slate-200", label: "—" },
  unknown: { dot: "bg-slate-300", chip: "bg-slate-50 text-slate-500 border-slate-200", label: "Unknown" },
};

function formatUsd(n: number | null): string {
  if (!n) return "Value not disclosed";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

export default function RfpDetailPage() {
  const router = useRouter();
  const params = useParams<{ rfpId: string }>();
  const rfpId = params?.rfpId;
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"prime" | "sub">("prime");

  useEffect(() => {
    if (!rfpId) return;
    let cancelled = false;
    fetch(`/api/match/${encodeURIComponent(rfpId)}/`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return null;
        }
        if (!res.ok) throw new Error(`Failed to load match (${res.status})`);
        return res.json() as Promise<DetailResponse>;
      })
      .then((d) => {
        if (cancelled || !d) return;
        setData(d);
        // Default to whichever track the user is eligible on. If both,
        // prime wins (it's the primary signal).
        if (!d.primeEligible && d.subEligible) setTab("sub");
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
  }, [rfpId, router]);

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]" />
          <p className="text-slate-600 font-medium">Loading match&hellip;</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <main className="relative max-w-3xl mx-auto px-6 md:px-10 py-10">
          <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-red-500 p-6">
            <h2 className="text-lg font-bold text-red-700">Couldn&apos;t load match</h2>
            <p className="text-sm text-slate-600 mt-2">{error ?? "Match not found"}</p>
            <Link href="/matches" className="inline-block mt-4 text-sm font-semibold text-[#3C89C6] hover:underline">
              ← Back to matches
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const breakdown = tab === "prime" ? data.breakdown : data.subTrack.breakdown;
  const scoreShown = tab === "prime" ? data.score : data.subTrack.score;
  const winProbShown = tab === "prime" ? data.winProbability : data.subTrack.score; // sub track doesn't apply incumbent multiplier

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <main className="relative max-w-5xl mx-auto px-6 md:px-10 py-10">
        <Link
          href="/matches"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-700 mb-4"
        >
          ← Back to matches
        </Link>

        {/* Header card */}
        <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 border-l-4 border-l-[#3C89C6] p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold text-slate-900 leading-tight">{data.rfp.title}</h1>
              <p className="text-sm text-slate-500 mt-2">
                {data.rfp.agency ?? "Unknown agency"}
                {data.rfp.location ? ` · ${data.rfp.location}` : ""}
                {data.rfp.deadline && ` · deadline ${new Date(data.rfp.deadline).toLocaleDateString()}`}
              </p>
              <p className="text-sm text-slate-700 font-semibold mt-1">
                {formatUsd(data.rfp.estimatedValueUsd)}
              </p>
            </div>
            <div className="shrink-0 flex items-center gap-4">
              <div className="text-right">
                <div className="text-3xl font-extrabold text-slate-900 leading-none">{scoreShown}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-1">
                  {tab === "prime" ? "Prime score" : "Sub score"}
                </div>
              </div>
              {tab === "prime" && data.winProbability !== data.score && (
                <div className="text-right">
                  <div className="text-2xl font-bold text-amber-700 leading-none">{winProbShown}</div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mt-1">
                    Win prob
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Data quality + incumbent strip */}
          <div className="mt-4 pt-4 border-t border-slate-100">
            <DataQualityBanner dq={data.dataQuality} />
            {data.incumbent.state === "likely" && (
              <div className="mt-3 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2">
                <span className="text-red-700 text-lg leading-none">⚠</span>
                <div className="text-sm text-red-800">
                  <strong>Incumbent likely</strong>
                  {data.incumbent.namedVendor && (
                    <>: {data.incumbent.namedVendor}</>
                  )}
                  {data.incumbent.contractEnd && (
                    <> · contract ends {data.incumbent.contractEnd}</>
                  )}
                  <div className="text-xs text-red-700/80 mt-0.5">
                    Win probability adjusted down — incumbent presence detected via {data.incumbent.source.replace(/_/g, " ")}.
                  </div>
                </div>
              </div>
            )}
            {data.incumbent.state === "open_field" && (
              <div className="mt-3 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-800 flex items-center gap-2">
                <span>✓</span>
                <strong>Open field</strong>
                <span className="text-xs text-emerald-700/80">
                  · no recurring winner detected
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Eligibility callouts when prime gates failed */}
        {!data.primeEligible && data.gateFailures.length > 0 && (
          <div className="mb-6 bg-amber-50/80 backdrop-blur-sm rounded-2xl border border-amber-200 p-5">
            <h3 className="text-sm font-bold text-amber-900">Not eligible as prime</h3>
            <ul className="mt-2 space-y-1 text-sm text-amber-800">
              {data.gateFailures.map((g) => (
                <li key={g} className="flex items-start gap-2">
                  <span className="text-amber-700">•</span>
                  {g}
                </li>
              ))}
            </ul>
            {data.subEligible ? (
              <p className="mt-3 text-sm text-amber-900">
                You may still qualify as a subcontractor — see the <strong>Sub</strong> tab below.
              </p>
            ) : (
              <p className="mt-3 text-sm text-amber-900">
                And the sub track doesn&apos;t look eligible either based on your current profile.
              </p>
            )}
          </div>
        )}

        {/* Prime/Sub tabs */}
        <div className="mb-4 flex items-center gap-1 bg-white/70 backdrop-blur-sm rounded-xl border border-slate-200 p-1 w-fit">
          <button
            type="button"
            onClick={() => setTab("prime")}
            disabled={!data.primeEligible}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
              tab === "prime"
                ? "bg-[#3C89C6] text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-not-allowed"
            }`}
          >
            Prime
          </button>
          <button
            type="button"
            onClick={() => setTab("sub")}
            disabled={!data.subEligible}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
              tab === "sub"
                ? "bg-[#3C89C6] text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900 disabled:text-slate-300 disabled:cursor-not-allowed"
            }`}
          >
            Sub
            {!data.subEligible && <span className="text-xs ml-1 opacity-60">(n/a)</span>}
          </button>
        </div>

        {/* Breakdown */}
        <div className="space-y-3">
          {breakdown.map((b) => (
            <CategoryRow key={`${tab}-${b.category}`} b={b} />
          ))}
        </div>

        {/* Description */}
        {data.rfp.description && (
          <div className="mt-8 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-5">
            <h3 className="text-sm font-bold text-slate-900 mb-2">RFP description</h3>
            <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">
              {data.rfp.description}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function DataQualityBanner({ dq }: { dq: DetailResponse["dataQuality"] }) {
  const messages: Record<typeof dq.coverage, string> = {
    full: "Full data available — RFP requirements extracted and market bidder data captured.",
    requirements_only: "RFP requirements available, but no bidder/market data from this source.",
    market_intel_only:
      "Bidder and award data available, but PDF requirements (NAICS, licenses, certifications) are not accessible from this source.",
    thin: "Limited data — only title and basic fields. Bid carefully.",
  };
  const tones: Record<typeof dq.coverage, string> = {
    full: "bg-emerald-50 text-emerald-800 border-emerald-200",
    requirements_only: "bg-blue-50 text-blue-800 border-blue-200",
    market_intel_only: "bg-violet-50 text-violet-800 border-violet-200",
    thin: "bg-amber-50 text-amber-900 border-amber-200",
  };
  return (
    <div className={`text-xs px-3 py-2 rounded-lg border ${tones[dq.coverage]}`}>
      <span className="font-semibold">Data quality: {dq.coverage.replace(/_/g, " ")}</span>
      <span className="opacity-80"> · {messages[dq.coverage]}</span>
      <span className="opacity-60"> · source: {dq.sourceId}</span>
    </div>
  );
}

function CategoryRow({ b }: { b: CategoryBreakdown }) {
  const style = STATUS_STYLES[b.status];
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-white/60 shadow-sm shadow-slate-200/50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex items-center gap-2 min-w-[160px] shrink-0">
          <span className={`w-2 h-2 rounded-full ${style.dot}`} />
          <span className="font-semibold text-slate-900 text-sm">{b.category}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${style.chip}`}>
              {style.label}
            </span>
            <span className="text-xs text-slate-400">
              weight {(b.weight * 100).toFixed(0)}%
            </span>
            {b.score != null && (
              <span className="text-xs text-slate-500 font-mono">
                score {(b.score * 100).toFixed(0)}/100
              </span>
            )}
          </div>
          <p className="text-sm text-slate-700">{b.detail}</p>
          {(b.rfpPhrase || b.profileClaim) && (
            <div className="mt-2 pt-2 border-t border-slate-100 text-xs">
              {b.rfpPhrase && (
                <div className="text-slate-600">
                  <span className="font-semibold text-slate-500">RFP:</span>{" "}
                  <span className="italic">&ldquo;{b.rfpPhrase}&rdquo;</span>
                </div>
              )}
              {b.profileClaim && (
                <div className="text-slate-600 mt-0.5">
                  <span className="font-semibold text-slate-500">Your claim:</span>{" "}
                  &ldquo;{b.profileClaim}&rdquo;
                  {b.profileClaimSource && (
                    <span className="text-slate-400"> · from {b.profileClaimSource}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
