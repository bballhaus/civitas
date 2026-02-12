"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

interface CompanyProfile {
  companyName: string;
  industry: string[];
  sizeStatus: string[];
  certifications: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  capabilities: string[];
  agencyExperience: string[];
  contractTypes: string[];
}

interface RFP {
  id: string;
  title: string;
  agency: string;
  location: string;
  deadline: string;
  estimatedValue: string;
  industry: string;
  naicsCodes: string[];
  capabilities: string[];
  certifications: string[];
  contractType: string;
  description: string;
  eventUrl?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

interface RFPMatch {
  score: number;
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
}

type RFPWithMatch = RFP & { match: RFPMatch };

const FALLBACK_RFPS: RFP[] = [
  { id: "fallback-1", title: "Sample RFP (API unavailable)", agency: "Sample Agency", location: "California", deadline: "TBD", estimatedValue: "TBD", industry: "Consulting", naicsCodes: [], capabilities: ["Consulting"], certifications: [], contractType: "RFx", description: "Connect to the webscraping data to see real Cal eProcure events." },
];

const STORAGE_KEYS = {
  SAVED: "civitas_saved_rfps",
  NOT_INTERESTED: "civitas_not_interested_rfps",
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

function saveSet(key: string, set: Set<string>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify([...set]));
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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 2);
}

function toTokenSet(values: string[]): Set<string> {
  const tokens = values.flatMap((value) => tokenize(value));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function countNaicsOverlap(rfpCodes: string[], profileCodes: string[]): string[] {
  if (rfpCodes.length === 0 || profileCodes.length === 0) return [];
  const normalizedProfile = profileCodes.map((code) => code.trim());
  return rfpCodes.filter((code) =>
    normalizedProfile.some((profileCode) =>
      profileCode === code || profileCode.startsWith(code) || code.startsWith(profileCode)
    )
  );
}

function findTokenOverlap(values: string[], profileTokens: Set<string>): string[] {
  return values.filter((value) => {
    const tokens = tokenize(value);
    return tokens.some((token) => profileTokens.has(token));
  });
}

function scoreFromSimilarity(sim: number, maxPoints: number) {
  const s = clamp(sim, 0, 1);
  return maxPoints * (0.15 + 0.85 * s);
}

function computeMatch(rfp: RFP, profile: CompanyProfile | null): RFPMatch {
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  let score = 40;

  if (!profile) {
    return {
      score: 50,
      reasons: ["Complete your profile for personalized match scores"],
      positiveReasons: [],
      negativeReasons: [],
    };
  }

  const profileIndustryTokens = toTokenSet(profile.industry ?? []);
  const profileNaics = profile.naicsCodes ?? [];
  const profileCapsTokens = toTokenSet(profile.capabilities ?? []);
  const profileCertTokens = toTokenSet(profile.certifications ?? []);
  const profileAgencyTokens = toTokenSet(profile.agencyExperience ?? []);
  const profileContractTokens = toTokenSet(profile.contractTypes ?? []);
  const profileLocationTokens = toTokenSet([...(profile.workCities ?? []), ...(profile.workCounties ?? [])]);

  const rfpIndustryTokens = toTokenSet([rfp.industry ?? ""]);
  const rfpCapTokens = toTokenSet(rfp.capabilities ?? []);
  const rfpAgencyTokens = toTokenSet([rfp.agency ?? ""]);
  const rfpContractTokens = toTokenSet([rfp.contractType ?? ""]);
  const rfpLocationTokens = toTokenSet([rfp.location ?? ""]);
  const rfpDescTokens = toTokenSet([rfp.description ?? "", rfp.title ?? ""]);

  const due = parseDeadline(rfp.deadline);
  if (due) {
    const now = new Date();
    if (now > due) {
      score = 5;
      negativeReasons.push("Deadline has passed.");
      const reasons = [
        ...positiveReasons.map((r) => `✓ ${r}`),
        ...negativeReasons.map((r) => `✗ ${r}`),
      ];
      return { score, reasons, positiveReasons, negativeReasons };
    }
    positiveReasons.push("Deadline is still open.");
    score += 6;
  } else if (rfp.deadline?.toUpperCase() !== "TBD") {
    negativeReasons.push("Could not parse deadline.");
  }

  const certOverlap = findTokenOverlap(rfp.certifications ?? [], profileCertTokens);
  if ((rfp.certifications ?? []).length > 0) {
    if (certOverlap.length === 0) {
      score -= 18;
      negativeReasons.push("RFP lists certifications you may not have.");
    } else {
      score += 10;
      positiveReasons.push(`Certification overlap: ${certOverlap.slice(0, 2).join(", ")}`);
    }
  }

  const locationSimilarity = jaccardSimilarity(rfpLocationTokens, profileLocationTokens);
  if ((rfp.location ?? "").trim().length > 0) {
    if (locationSimilarity === 0 && profileLocationTokens.size > 0) {
      score -= 12;
      negativeReasons.push("Location may be outside your service area.");
    } else if (locationSimilarity > 0) {
      score += 8;
      positiveReasons.push("Location aligns with your service area.");
    }
  }

  const industrySimilarity = jaccardSimilarity(rfpIndustryTokens, profileIndustryTokens);
  if (industrySimilarity > 0) {
    score += scoreFromSimilarity(industrySimilarity, 18);
    positiveReasons.push("Industry aligns with your profile.");
  } else if ((rfp.industry ?? "").trim()) {
    score -= 6;
    negativeReasons.push(`Industry (${rfp.industry}) not reflected in your profile.`);
  }

  const naicsOverlap = countNaicsOverlap(rfp.naicsCodes ?? [], profileNaics);
  if ((rfp.naicsCodes ?? []).length > 0) {
    if (naicsOverlap.length > 0) {
      const ratio = naicsOverlap.length / Math.max(1, rfp.naicsCodes.length);
      score += 16 * ratio;
      positiveReasons.push(`NAICS overlap: ${naicsOverlap.slice(0, 3).join(", ")}`);
    } else {
      score -= 6;
      negativeReasons.push("No NAICS overlap.");
    }
  }

  const capSimilarity = jaccardSimilarity(rfpCapTokens, profileCapsTokens);
  const capOverlap = findTokenOverlap(rfp.capabilities ?? [], profileCapsTokens);
  if ((rfp.capabilities ?? []).length > 0) {
    if (capSimilarity > 0 || capOverlap.length > 0) {
      score += scoreFromSimilarity(clamp(capSimilarity + capOverlap.length * 0.05, 0, 1), 26);
      positiveReasons.push(
        capOverlap.length > 0
          ? `Capabilities align: ${capOverlap.slice(0, 3).join(", ")}`
          : "Capabilities align with your profile."
      );
    } else {
      score -= 8;
      negativeReasons.push("Limited capability overlap.");
    }
  }

  const profileTextTokens = new Set<string>([
    ...profileIndustryTokens,
    ...profileCapsTokens,
    ...profileCertTokens,
    ...profileAgencyTokens,
  ]);
  const descSimilarity = jaccardSimilarity(rfpDescTokens, profileTextTokens);
  if (descSimilarity > 0.05) {
    score += scoreFromSimilarity(descSimilarity, 12);
    positiveReasons.push("Description language matches your profile keywords.");
  }

  const agencySimilarity = jaccardSimilarity(rfpAgencyTokens, profileAgencyTokens);
  if (agencySimilarity > 0) {
    score += scoreFromSimilarity(agencySimilarity, 8);
    positiveReasons.push("You have experience with this agency.");
  }

  const contractSimilarity = jaccardSimilarity(rfpContractTokens, profileContractTokens);
  if (contractSimilarity > 0) {
    score += scoreFromSimilarity(contractSimilarity, 5);
    positiveReasons.push("Contract type matches your preferences.");
  }

  score = clamp(score, 5, 98);

  const reasons = [
    ...positiveReasons.slice(0, 3).map((r) => `✓ ${r}`),
    ...negativeReasons.slice(0, 3).map((r) => `✗ ${r}`),
  ];

  return { score, reasons, positiveReasons, negativeReasons };
}

function generateMatchSummary(_rfp: RFP, match: RFPMatch): string {
  const { positiveReasons, negativeReasons, score } = match;
  if (score >= 75 && positiveReasons.length > 0) {
    const topReasons = positiveReasons.slice(0, 3);
    const first = topReasons[0].charAt(0).toLowerCase() + topReasons[0].slice(1);
    const rest = topReasons.slice(1).map((r) => r.toLowerCase()).join(". ");
    return `This RFP is a strong fit for you. ${first}. ${rest}. Worth a close look.`;
  }
  if (score >= 55 && positiveReasons.length > 0) {
    const top = positiveReasons[0].toLowerCase();
    const extra = positiveReasons.length > 1 ? ` Also: ${positiveReasons.slice(1, 2).join(", ").toLowerCase()}.` : ".";
    return `This opportunity has potential: ${top}${extra}`;
  }
  if (positiveReasons.length > 0) {
    const align = positiveReasons[0].toLowerCase();
    const hint = negativeReasons.length > 0 ? " Consider updating your profile to improve future matches." : "";
    return `Some alignment: ${align}.${hint}`;
  }
  return "Complete your profile for personalized match insights.";
}

function MatchBadge({ score }: { score: number }) {
  const isHigh = score >= 75;
  const isMedium = score >= 55 && score < 75;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-bold ${
        isHigh
          ? "bg-emerald-500 text-white"
          : isMedium
          ? "bg-amber-400 text-amber-900"
          : "bg-slate-200 text-slate-600"
      }`}
    >
      {isHigh && <span className="mr-1">★</span>}
      {score}% match
    </span>
  );
}

export default function DashboardPage() {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [selectedRfpId, setSelectedRfpId] = useState<string | null>(null);
  const [rfps, setRfps] = useState<RFP[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedRfpIds, setSavedRfpIds] = useState<Set<string>>(() => loadSet(STORAGE_KEYS.SAVED));
  const [notInterestedRfpIds, setNotInterestedRfpIds] = useState<Set<string>>(() => loadSet(STORAGE_KEYS.NOT_INTERESTED));
  const [expressedInterestRfpIds, setExpressedInterestRfpIds] = useState<Set<string>>(() => loadSet(STORAGE_KEYS.EXPRESSED_INTEREST));
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  };

  const handleSaveRfp = (rfpId: string) => {
    setSavedRfpIds((prev) => {
      const next = new Set(prev);
      if (next.has(rfpId)) next.delete(rfpId);
      else next.add(rfpId);
      saveSet(STORAGE_KEYS.SAVED, next);
      showToast(next.has(rfpId) ? "Saved to your list" : "Removed from saved");
      return next;
    });
  };

  const handleNotInterested = (rfpId: string) => {
    setNotInterestedRfpIds((prev) => {
      const next = new Set(prev);
      next.add(rfpId);
      saveSet(STORAGE_KEYS.NOT_INTERESTED, next);
      return next;
    });
    setSelectedRfpId((current) => (current === rfpId ? null : current));
    showToast("Marked as not interested");
  };

  const handleExpressInterest = (rfpId: string) => {
    setExpressedInterestRfpIds((prev) => {
      const next = new Set(prev);
      next.add(rfpId);
      saveSet(STORAGE_KEYS.EXPRESSED_INTEREST, next);
      return next;
    });
    showToast("Interest expressed — we'll use this to improve your matches");
  };

  const handleRemoveFromNotInterested = (rfpId: string) => {
    setNotInterestedRfpIds((prev) => {
      const next = new Set(prev);
      next.delete(rfpId);
      saveSet(STORAGE_KEYS.NOT_INTERESTED, next);
      return next;
    });
    showToast("RFP restored to your list");
  };

  const [showNotInterestedList, setShowNotInterestedList] = useState(false);
  const [listFilter, setListFilter] = useState<"all" | "saved">("all");

  useEffect(() => {
    const saved = localStorage.getItem("companyProfile");
    const extracted = localStorage.getItem("extractedProfileData");
    if (saved) {
      try {
        setProfile(JSON.parse(saved));
        return;
      } catch {
        // ignore
      }
    }
    if (extracted) {
      try {
        setProfile(JSON.parse(extracted));
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/events");
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setRfps(data.events ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load events");
        setRfps(FALLBACK_RFPS);
      } finally {
        setLoading(false);
      }
    }
    fetchEvents();
  }, []);

  const allRfpsWithMatch: RFPWithMatch[] = (rfps.length > 0 ? rfps : FALLBACK_RFPS).map((rfp) => ({
    ...rfp,
    match: computeMatch(rfp, profile),
  }));
  allRfpsWithMatch.sort((a, b) => b.match.score - a.match.score);

  const rfpsWithMatch = allRfpsWithMatch.filter((r) => !notInterestedRfpIds.has(r.id));
  const hiddenRfps = allRfpsWithMatch.filter((r) => notInterestedRfpIds.has(r.id));
  const hiddenCount = hiddenRfps.length;

  const displayedRfps = listFilter === "saved"
    ? rfpsWithMatch.filter((r) => savedRfpIds.has(r.id))
    : rfpsWithMatch;

  const displayName = profile?.companyName?.trim() || "there";
  const matchCount = displayedRfps.length;
  const selectedId = selectedRfpId ?? displayedRfps[0]?.id ?? null;
  const selectedRfp = displayedRfps.find((r) => r.id === selectedId);

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10 shadow-sm">
        <div className="max-w-full mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/logo.png" alt="Civitas logo" className="h-10 w-10" />
            <span className="text-xl font-bold text-slate-900">Civitas</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/profile" className="text-slate-600 hover:text-slate-900 text-sm font-medium">
              Profile
            </Link>
           
          </div>
        </div>
      </nav>

      {/* Split view */}
      <div className="flex flex-col lg:flex-row h-[calc(100vh-65px)]">
        {/* Left: RFP list */}
        <aside className="w-full lg:w-[440px] shrink-0 flex flex-col border-r border-slate-200 bg-[#fafafa] overflow-hidden">
          <div className="p-6 border-b border-slate-200 bg-white">
            <h1 className="text-lg font-bold text-slate-800 mb-3">
              Hi{displayName !== "there" ? ` ${displayName}` : " there"}! You have{" "}
              <span className="text-[#2563eb]">{matchCount}</span> {listFilter === "saved" ? "saved" : ""} match{matchCount !== 1 ? "es" : ""} to review.
            </h1>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setListFilter("all")}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  listFilter === "all"
                    ? "bg-[#2563eb] text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setListFilter("saved")}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  listFilter === "saved"
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" clipRule="evenodd" />
                </svg>
                Saved ({savedRfpIds.size})
              </button>
            </div>
            <div className="flex gap-3">
              <Link
                href="/profile"
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-[#2563eb] text-sm font-medium hover:bg-slate-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Update Match Preferences
              </Link>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2563eb]"></div>
              </div>
            ) : error ? (
              <p className="text-sm text-amber-600 py-4 px-4 bg-amber-50 rounded-lg">{error}. Showing sample data.</p>
            ) : null}
            {hiddenCount > 0 && (
              <div className="px-4 py-2 border-b border-slate-200 bg-slate-50/50">
                <button
                  type="button"
                  onClick={() => setShowNotInterestedList((prev) => !prev)}
                  className="text-xs text-slate-600 hover:text-slate-900 hover:underline w-full text-left flex items-center justify-between gap-2"
                >
                  <span>
                    {hiddenCount} RFP{hiddenCount !== 1 ? "s" : ""} marked not interested (hidden)
                  </span>
                  <span className="text-slate-400 shrink-0">
                    {showNotInterestedList ? "▼" : "▶"}
                  </span>
                </button>
                {showNotInterestedList && (
                  <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                    {hiddenRfps.map((rfp) => (
                      <div
                        key={rfp.id}
                        className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white border border-slate-200"
                      >
                        <p className="text-xs font-medium text-slate-800 truncate flex-1 min-w-0" title={rfp.title}>
                          {rfp.title}
                        </p>
                        <button
                          type="button"
                          onClick={() => handleRemoveFromNotInterested(rfp.id)}
                          className="shrink-0 text-xs font-medium text-[#2563eb] hover:underline px-2 py-1"
                        >
                          Show again
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {displayedRfps.map((rfp) => {
              const { match } = rfp;
              const isSelected = rfp.id === selectedId;
              const isHighMatch = match.score >= 75;
              const isSaved = savedRfpIds.has(rfp.id);
              const reasonSnippet = generateMatchSummary(rfp, match);

              return (
                <button
                  key={rfp.id}
                  type="button"
                  onClick={() => setSelectedRfpId(rfp.id)}
                  className={`w-full text-left p-4 rounded-xl bg-white border-2 transition-all shadow-sm hover:shadow-md ${
                    isSelected ? "border-[#2563eb] shadow-md" : "border-transparent hover:border-slate-200"
                  }`}
                >
                  <p className="text-sm font-bold text-slate-800 mb-0.5">{rfp.agency}</p>
                  <p className="text-xs text-slate-500 mb-2">{rfp.industry}</p>
                  <h2 className="text-sm font-bold text-[#2563eb] line-clamp-2 mb-2">{rfp.title}</h2>
                  <p className="text-xs text-slate-500 mb-3">{rfp.contractType} · {rfp.location}</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-600">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {rfp.location}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-pink-50 text-pink-600">
                      {rfp.industry}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-amber-50 text-amber-600">
                      {rfp.capabilities[0] || rfp.contractType || "Contract"}
                    </span>
                    {isHighMatch && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-600">
                        <span className="text-emerald-500">✓</span> High Match
                      </span>
                    )}
                    {isSaved && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-600">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" clipRule="evenodd" />
                        </svg>
                        Saved
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <MatchBadge score={match.score} />
                  </div>
                  {reasonSnippet && (
                    <p className="text-xs text-slate-500 mt-2 line-clamp-2">
                      {reasonSnippet}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right: RFP detail */}
        <main className="flex-1 min-w-0 overflow-y-auto bg-[#f5f5f5] relative">
          {toast && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium shadow-lg">
              {toast}
            </div>
          )}
          {selectedRfp ? (
            <RFPDetailPanel
              rfp={selectedRfp}
              generateSummary={generateMatchSummary}
              MatchBadge={MatchBadge}
              isSaved={savedRfpIds.has(selectedRfp.id)}
              hasExpressedInterest={expressedInterestRfpIds.has(selectedRfp.id)}
              onSave={() => handleSaveRfp(selectedRfp.id)}
              onNotInterested={() => handleNotInterested(selectedRfp.id)}
              onExpressInterest={() => handleExpressInterest(selectedRfp.id)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">
              <p>Select an RFP to view details</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function RFPDetailPanel({
  rfp,
  generateSummary,
  MatchBadge,
  isSaved,
  hasExpressedInterest,
  onSave,
  onNotInterested,
  onExpressInterest,
}: {
  rfp: RFPWithMatch;
  generateSummary: (rfp: RFP, match: RFPMatch) => string;
  MatchBadge: React.ComponentType<{ score: number }>;
  isSaved: boolean;
  hasExpressedInterest: boolean;
  onSave: () => void;
  onNotInterested: () => void;
  onExpressInterest: () => void;
}) {
  const { match } = rfp;
  const isHighMatch = match.score >= 75;
  const summary = generateSummary(rfp, match);

  return (
    <article className="w-full p-6 md:p-8">
      <div className="rounded-2xl overflow-hidden bg-white shadow-sm border border-slate-200">
        {/* Header with actions */}
        <div className="p-6 md:p-8 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 mb-4">
            <h2 className="text-xl font-bold text-slate-900">RFP Match</h2>
            <div className="flex items-center gap-3 shrink-0 flex-wrap">
              <button
                type="button"
                onClick={onSave}
                className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
                  isSaved
                    ? "text-emerald-600 bg-emerald-50 hover:bg-emerald-100"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                }`}
              >
                <svg className={`w-4 h-4 ${isSaved ? "fill-current" : ""}`} fill={isSaved ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                {isSaved ? "Saved" : "Save"}
              </button>
              <button
                type="button"
                onClick={onNotInterested}
                className="text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Not Interested
              </button>
              <button
                type="button"
                onClick={onExpressInterest}
                disabled={hasExpressedInterest}
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                  hasExpressedInterest
                    ? "bg-emerald-100 text-emerald-800 cursor-default"
                    : "bg-[#2563eb] text-white hover:bg-[#1d4ed8]"
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {hasExpressedInterest ? "Interest expressed" : "Express Interest"}
              </button>
            </div>
          </div>

          <h3 className="text-2xl font-bold text-slate-900 mb-4">{rfp.title}</h3>

          {/* Colored tags row */}
          <div className="flex flex-wrap gap-2 mb-5">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {rfp.location}
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-pink-50 text-pink-600">
              {rfp.industry}
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-50 text-amber-600">
              {rfp.capabilities[0] || rfp.contractType || "Contract"}
            </span>
            {isHighMatch && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-50 text-emerald-600">
                <span className="text-emerald-500">✓</span> High Success Rate
              </span>
            )}
          </div>

          {/* Key details with icons */}
          <ul className="space-y-3 text-sm text-slate-600">
            <li className="flex items-center gap-3">
              <svg className="w-5 h-5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Due {rfp.deadline} · {rfp.contractType}
            </li>
            <li className="flex items-center gap-3">
              <svg className="w-5 h-5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {rfp.location}
            </li>
            <li className="flex items-center gap-3">
              <svg className="w-5 h-5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {rfp.estimatedValue}
            </li>
          </ul>
        </div>

        {/* Agency info box */}
        <div className="px-6 md:px-8 py-4 bg-slate-50 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold text-slate-900">{rfp.agency}</p>
              <p className="text-sm text-slate-500">{rfp.industry}</p>
            </div>
            <a
              href={rfp.eventUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[#2563eb] hover:underline flex items-center gap-1"
            >
              View on Cal eProcure
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>

        {/* Quick indicators */}
        {isHighMatch && (
          <div className="px-6 md:px-8 py-4 flex flex-wrap gap-2 border-t border-slate-100">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-violet-50 text-violet-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Responds Quickly
            </span>
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600">
              <span className="text-emerald-500">✓</span> High Success Rate
            </span>
          </div>
        )}

        {/* AI-generated match summary - RippleMatch style */}
        <div className="p-6 md:p-8 border-t border-slate-100">
          <div className="rounded-xl border-2 border-blue-200 bg-white p-5">
            <div className="flex items-start justify-between gap-2 mb-3">
              <h4 className="text-sm font-bold text-slate-900">Why this is a good match</h4>
              <svg className="w-5 h-5 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-slate-700 leading-relaxed">{summary}</p>
          </div>
        </div>

        {/* Full description */}
        <div className="p-6 md:p-8 border-t border-slate-100">
          <h4 className="text-sm font-bold text-slate-900 mb-3">About this RFP</h4>
          <p className="text-slate-700 leading-relaxed">{rfp.description}</p>
        </div>

        {/* Tags */}
        <div className="p-6 md:p-8 border-t border-slate-100">
          <h4 className="text-sm font-bold text-slate-900 mb-3">Details</h4>
          <div className="flex flex-wrap gap-2">
            {rfp.naicsCodes?.map((n) => (
              <span key={n} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-600">
                NAICS {n}
              </span>
            ))}
            {rfp.capabilities?.map((c) => (
              <span key={c} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-600">
                {c}
              </span>
            ))}
            {(!rfp.naicsCodes?.length && !rfp.capabilities?.length) && (
              <span className="text-sm text-slate-500">See description for full details</span>
            )}
          </div>
          {(rfp.contactEmail || rfp.contactName) && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <h5 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Contact</h5>
              {rfp.contactName && <p className="text-sm text-slate-700">{rfp.contactName}</p>}
              {rfp.contactEmail && (
                <a href={`mailto:${rfp.contactEmail}`} className="text-sm text-[#2563eb] hover:underline">{rfp.contactEmail}</a>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
