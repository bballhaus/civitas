"use client";

// v2 RFP match detail (Architecture-v2 § 12).
//
// Prime + Sub tracks as tabs (spec § 9.7). Each scoring category prints a
// human-readable citation: the RFP phrase + the profile claim that backed
// it (spec § 9.10). Top of page shows a data_quality summary so the user
// knows whether they're reading full extracted requirements or just a title.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import { MarkdownContent } from "@/components/MarkdownContent";
import { portalLabel } from "@/lib/rfp-portal";
import {
  getCurrentUser,
  updateUserRfpStatus,
  setRfpStatus,
  getProfileFromBackend,
  mapBackendProfileToCompanyProfile,
  getCachedProfile,
  setCachedProfile,
} from "@/lib/api";
import { trackEvent } from "@/lib/event-tracker";
import type { CompanyProfile } from "@/lib/rfp-matching";

// Save state is server-persisted via match_state. Toggling Save on this
// page is the entry point into the Bidding Process Tracker — the new row's
// status becomes 'saved' and the default task template is auto-seeded by
// the /api/user/rfp-status route.

// Approximate the rule-based summary that /api/match-summary expects as
// `currentSummary` input — the v2 matcher doesn't produce one, so we
// stitch together the top breakdown rows. The LLM uses this as a hint,
// not as ground truth.
function buildRuleBasedSummary(detail: DetailResponse): string {
  const top = detail.breakdown
    .filter((b) => b.status === "strong" || b.status === "partial")
    .slice(0, 3)
    .map((b) => `${b.category}: ${b.detail}`)
    .join(". ");
  const score = `Score ${detail.score} (${detail.tier}).`;
  return [score, top].filter(Boolean).join(" ");
}

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

interface DetailRfp {
  id: string;
  title: string;
  description: string | null;
  agency: string | null;
  location: string | null;
  deadline: string | null;
  sourceId: string;
  estimatedValueUsd: number | null;
  capabilities: string[];
  naicsCodes: string[];
  certificationsRequired: string[];
  licensesRequired: string[];
  setAsideTypes: string[];
  deliverables: string[];
  incumbentVendor: string | null;
  incumbentContractEnd: string | null;
  industry: string | null;
  contractType: string | null;
  contractDuration: string | null;
  evaluationCriteria: string[];
  clearancesRequired: string[];
  attachmentUrls: string[];
  mirroredAttachments: { filename: string; s3Key: string; originalUrl: string | null }[];
  attachmentRollup: unknown;
  eventUrl: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

interface DetailResponse {
  rfp: DetailRfp;
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

  // User profile drives the capabilities-analysis prompt. Matches the v1
  // pattern (read localStorage first, fall back to extracted profile).
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // LLM-generated summaries.
  const [matchSummary, setMatchSummary] = useState<string | null>(null);
  const [matchSummaryLoading, setMatchSummaryLoading] = useState(false);
  const [matchSummaryError, setMatchSummaryError] = useState(false);
  const [requirementsSummary, setRequirementsSummary] = useState<string | null>(null);
  const [requirementsSummaryLoading, setRequirementsSummaryLoading] = useState(false);
  const [requirementsSummaryError, setRequirementsSummaryError] = useState(false);
  const [capabilitiesAnalysis, setCapabilitiesAnalysis] = useState<string | null>(null);
  const [capabilitiesAnalysisLoading, setCapabilitiesAnalysisLoading] = useState(false);
  const [capabilitiesAnalysisError, setCapabilitiesAnalysisError] = useState(false);
  const [matchSummaryOpen, setMatchSummaryOpen] = useState(false);
  const [aboutRfpOpen, setAboutRfpOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

  // Save state (server-persisted via match_state). Hydrated from
  // /api/auth/me's saved_rfp_ids snapshot.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveBusy, setSaveBusy] = useState(false);

  // Good / bad match feedback (server-persisted via /api/user/rfp-status).
  const [matchRating, setMatchRating] = useState<"good" | "bad" | null>(null);
  const [matchReason, setMatchReason] = useState("");
  const [savedMatchReason, setSavedMatchReason] = useState("");
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Hydrate saved-IDs set from the server on mount. The same payload that
  // /api/auth/me returns for match feedback also includes the pipeline
  // snapshot (saved/in_progress/bid_submitted/won/lost/no_bid).
  useEffect(() => {
    getCurrentUser(true)
      .then((full) => {
        if (full?.saved_rfp_ids) setSavedIds(new Set(full.saved_rfp_ids));
      })
      .catch(() => {});
  }, []);

  // Hydrate company profile. Prefer the server (the same /api/profile/ that
  // powers the % complete gauge); fall back to localStorage if the user is
  // signed out or the backend is unreachable. Reading localStorage alone
  // would hide a fully-populated server profile from a fresh browser session.
  useEffect(() => {
    let cancelled = false;
    const cached = getCachedProfile();
    if (cached) {
      setProfile(cached as CompanyProfile);
      setProfileLoaded(true);
      return;
    }
    getProfileFromBackend()
      .then((backendProfile) => {
        if (cancelled) return;
        const mapped = mapBackendProfileToCompanyProfile(backendProfile);
        if (mapped) {
          setProfile(mapped as CompanyProfile);
          setCachedProfile(undefined, mapped);
        }
      })
      .catch(() => {
        if (cancelled) return;
        const saved = typeof window !== "undefined" ? localStorage.getItem("companyProfile") : null;
        const extracted =
          typeof window !== "undefined" ? localStorage.getItem("extractedProfileData") : null;
        try {
          if (saved) setProfile(JSON.parse(saved) as CompanyProfile);
          else if (extracted) setProfile(JSON.parse(extracted) as CompanyProfile);
        } catch {
          // ignore malformed
        }
      })
      .finally(() => {
        if (!cancelled) setProfileLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate match-feedback state from the server (good/bad rating + reason).
  useEffect(() => {
    if (!rfpId) return;
    getCurrentUser(true)
      .then((full) => {
        if (!full) return;
        const fb = full.match_feedback_by_rfp?.[rfpId];
        if (fb) {
          setMatchRating(fb.rating);
          setSavedMatchReason(fb.reason ?? "");
          setMatchReason(fb.reason ?? "");
        }
      })
      .catch(() => {});
  }, [rfpId]);

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
        trackEvent("rfp_viewed", {
          rfpId: d.rfp.id,
          pagePath: "/matches",
          matchScore: d.score,
          matchTier: d.tier,
          source: "rfp_detail",
        });
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

  // Dwell time on the detail page. Fires on unmount with how long the user
  // spent here — useful for surface-level engagement signal alongside the
  // section expansion / attachment-click events below. Beacon-friendly: the
  // event tracker already flushes via sendBeacon on visibilitychange/pagehide.
  const detailEnteredAtRef = useRef<number>(Date.now());
  useEffect(() => {
    detailEnteredAtRef.current = Date.now();
    return () => {
      if (!rfpId) return;
      const dur = Date.now() - detailEnteredAtRef.current;
      if (dur >= 500) {
        trackEvent("rfp_dwell", { rfpId, durationMs: dur });
      }
    };
  }, [rfpId]);

  // Build the per-route RFP payload the LLM endpoints expect. /api/events
  // returns a richer shape than /api/match/[rfpId] historically did, so
  // we map our expanded fields into that shape here.
  const llmRfpPayload = data
    ? {
        title: data.rfp.title,
        agency: data.rfp.agency,
        industry: data.rfp.industry,
        location: data.rfp.location,
        deadline: data.rfp.deadline,
        capabilities: data.rfp.capabilities,
        certifications: data.rfp.certificationsRequired,
        contractType: data.rfp.contractType,
        description: data.rfp.description ?? "",
        naicsCodes: data.rfp.naicsCodes,
        clearancesRequired: data.rfp.clearancesRequired,
        setAsideTypes: data.rfp.setAsideTypes,
        deliverables: data.rfp.deliverables,
        evaluationCriteria: data.rfp.evaluationCriteria,
        estimatedValue: formatUsd(data.rfp.estimatedValueUsd),
        contractDuration: data.rfp.contractDuration,
        attachmentRollup: data.rfp.attachmentRollup,
        incumbentVendor: data.rfp.incumbentVendor,
        incumbentContractEnd: data.rfp.incumbentContractEnd,
      }
    : null;

  const llmProfilePayload = profile
    ? {
        companyName: profile.companyName,
        industry: profile.industry,
        specialties: profile.specialties,
        capabilities: profile.capabilities,
        certifications: profile.certifications,
        workAreas: profile.workAreas,
        agencyExperience: profile.agencyExperience,
        contractTypes: profile.contractTypes,
      }
    : null;

  // Fetch match summary once we have the data + profile (profile may be null).
  // /api/match-summary streams plain-text tokens — we drop the spinner on
  // the first byte and re-render the accumulating text on each chunk, so
  // the paragraph "types itself in" instead of materializing all at once.
  useEffect(() => {
    if (!data || !profileLoaded || !llmRfpPayload) return;
    const detail = data;
    const controller = new AbortController();
    setMatchSummaryLoading(true);
    setMatchSummaryError(false);
    const ruleSummary = buildRuleBasedSummary(detail);

    (async () => {
      try {
        const res = await fetch("/api/match-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            rfp: llmRfpPayload,
            profile: llmProfilePayload,
            currentSummary: ruleSummary,
            positiveReasons: detail.breakdown
              .filter((b) => b.status === "strong" || b.status === "partial")
              .map((b) => `${b.category}: ${b.detail}`),
            negativeReasons: detail.breakdown
              .filter((b) => b.status === "weak" || b.status === "missing")
              .map((b) => `${b.category}: ${b.detail}`),
          }),
        });
        if (!res.ok || !res.body) throw new Error(await res.text());

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (firstChunk) {
            // First byte: replace the loading spinner with the partial text.
            setMatchSummaryLoading(false);
            firstChunk = false;
          }
          setMatchSummary(accumulated);
        }
        // Flush any tail bytes the decoder was holding.
        accumulated += decoder.decode();
        setMatchSummary(accumulated || ruleSummary);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setMatchSummaryError(true);
        setMatchSummary(ruleSummary);
      } finally {
        if (!controller.signal.aborted) setMatchSummaryLoading(false);
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rfp.id, profileLoaded]);

  // Fetch RFP requirements summary (About this RFP). Streams plain-text
  // chunks so the section paints in progressively — same pattern as
  // match-summary above.
  useEffect(() => {
    if (!data || !data.rfp.description?.trim() || !llmRfpPayload) return;
    const controller = new AbortController();
    setRequirementsSummaryLoading(true);
    setRequirementsSummaryError(false);

    (async () => {
      try {
        const res = await fetch("/api/rfp-requirements-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ rfp: llmRfpPayload }),
        });
        if (!res.ok || !res.body) throw new Error(await res.text());
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (firstChunk) {
            setRequirementsSummaryLoading(false);
            firstChunk = false;
          }
          setRequirementsSummary(accumulated);
        }
        accumulated += decoder.decode();
        setRequirementsSummary(accumulated || null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRequirementsSummaryError(true);
        setRequirementsSummary(null);
      } finally {
        if (!controller.signal.aborted) setRequirementsSummaryLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rfp.id]);

  // Fetch capabilities analysis (compares profile against RFP requirements).
  // Also streams — Haiku with full RFP + profile + breakdown is the heaviest
  // of the three LLM calls so progressive rendering matters most here.
  useEffect(() => {
    if (!data || !profileLoaded || !llmRfpPayload) return;
    const detail = data;
    const controller = new AbortController();
    setCapabilitiesAnalysisLoading(true);
    setCapabilitiesAnalysisError(false);

    (async () => {
      try {
        const res = await fetch("/api/capabilities-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            rfp: llmRfpPayload,
            profile: llmProfilePayload
              ? { ...llmProfilePayload, technologyStack: (profile as { technologyStack?: string[] } | null)?.technologyStack }
              : null,
            breakdown: detail.breakdown,
          }),
        });
        if (!res.ok || !res.body) throw new Error(await res.text());
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (firstChunk) {
            setCapabilitiesAnalysisLoading(false);
            firstChunk = false;
          }
          setCapabilitiesAnalysis(accumulated);
        }
        accumulated += decoder.decode();
        setCapabilitiesAnalysis(accumulated || null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCapabilitiesAnalysisError(true);
        setCapabilitiesAnalysis(null);
      } finally {
        if (!controller.signal.aborted) setCapabilitiesAnalysisLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.rfp.id, profileLoaded]);

  const handleToggleSave = useCallback(async () => {
    if (!rfpId || saveBusy) return;
    const wasSaved = savedIds.has(rfpId);
    // Optimistic UI; reverted on failure.
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (wasSaved) next.delete(rfpId);
      else next.add(rfpId);
      return next;
    });
    setSaveBusy(true);
    try {
      await setRfpStatus(rfpId, wasSaved ? null : "saved");
      // Server route emits rfp_saved / rfp_unsaved events; no client trackEvent.
    } catch (err) {
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.add(rfpId);
        else next.delete(rfpId);
        return next;
      });
      console.error("Failed to update saved status:", err);
    } finally {
      setSaveBusy(false);
    }
  }, [rfpId, savedIds, saveBusy]);

  const handleSubmitMatchFeedback = useCallback(
    async (rating: "good" | "bad") => {
      if (!rfpId || !data) return;
      const previousRating = matchRating;
      const previousReason = savedMatchReason;
      setMatchRating(rating);
      setFeedbackError(null);
      if (rating === "good") {
        setMatchReason("");
        setSavedMatchReason("");
      }
      setFeedbackSaving(true);
      try {
        await updateUserRfpStatus({
          submit_match_feedback: {
            rfp_id: rfpId,
            rating,
            reason: rating === "bad" ? matchReason.trim() || undefined : undefined,
            match_score: data.score,
            match_tier: data.tier,
          },
        });
      } catch (err) {
        setMatchRating(previousRating);
        setSavedMatchReason(previousReason);
        setMatchReason(previousReason);
        setFeedbackError(err instanceof Error ? err.message : "Failed to save feedback");
      } finally {
        setFeedbackSaving(false);
      }
    },
    [rfpId, data, matchRating, savedMatchReason, matchReason],
  );

  const handleRemoveMatchFeedback = useCallback(async () => {
    if (!rfpId) return;
    const previousRating = matchRating;
    const previousReason = savedMatchReason;
    setMatchRating(null);
    setMatchReason("");
    setSavedMatchReason("");
    setFeedbackError(null);
    try {
      await updateUserRfpStatus({ remove_match_feedback: rfpId });
    } catch (err) {
      setMatchRating(previousRating);
      setSavedMatchReason(previousReason);
      setMatchReason(previousReason);
      setFeedbackError(err instanceof Error ? err.message : "Failed to remove feedback");
    }
  }, [rfpId, matchRating, savedMatchReason]);

  const handleSaveReason = useCallback(async () => {
    if (!rfpId || !data || matchRating !== "bad") return;
    const trimmed = matchReason.trim();
    if (trimmed === savedMatchReason.trim()) return;
    setFeedbackSaving(true);
    setFeedbackError(null);
    try {
      await updateUserRfpStatus({
        submit_match_feedback: {
          rfp_id: rfpId,
          rating: "bad",
          reason: trimmed || undefined,
          match_score: data.score,
          match_tier: data.tier,
        },
      });
      setSavedMatchReason(trimmed);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to save reason");
    } finally {
      setFeedbackSaving(false);
    }
  }, [rfpId, data, matchRating, matchReason, savedMatchReason]);

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

          {/* Action buttons — save (= add to Bidding Process Tracker),
              good/bad match feedback, and view on portal. Pipeline status
              transitions beyond "saved" (in_progress, bid_submitted, won,
              lost, no_bid) happen on /tracker, not here. */}
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggleSave()}
              disabled={saveBusy}
              title={rfpId && savedIds.has(rfpId) ? "Remove from tracker" : "Add to bidding tracker"}
              className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors disabled:opacity-60 ${
                rfpId && savedIds.has(rfpId)
                  ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              }`}
            >
              <svg
                className="w-4 h-4 shrink-0"
                fill={rfpId && savedIds.has(rfpId) ? "currentColor" : "none"}
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                />
              </svg>
              {rfpId && savedIds.has(rfpId) ? "Saved · in tracker" : "Save to tracker"}
            </button>
            {rfpId && savedIds.has(rfpId) && (
              <Link
                href="/tracker"
                className="text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg text-[#3C89C6] hover:bg-blue-50 font-semibold"
              >
                Manage in tracker &rarr;
              </Link>
            )}
            <span className="w-px h-5 bg-slate-200 mx-1" aria-hidden="true" />
            <button
              type="button"
              title="Good match"
              aria-pressed={matchRating === "good"}
              onClick={() =>
                matchRating === "good"
                  ? void handleRemoveMatchFeedback()
                  : void handleSubmitMatchFeedback("good")
              }
              disabled={feedbackSaving}
              className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors disabled:opacity-60 ${
                matchRating === "good"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-500 hover:text-emerald-600 hover:bg-emerald-50"
              }`}
            >
              <svg
                className="w-4 h-4 shrink-0"
                fill={matchRating === "good" ? "currentColor" : "none"}
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"
                />
              </svg>
              Good match
            </button>
            <button
              type="button"
              title="Bad match"
              aria-pressed={matchRating === "bad"}
              onClick={() =>
                matchRating === "bad"
                  ? void handleRemoveMatchFeedback()
                  : void handleSubmitMatchFeedback("bad")
              }
              disabled={feedbackSaving}
              className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors disabled:opacity-60 ${
                matchRating === "bad"
                  ? "bg-red-600 text-white"
                  : "text-slate-500 hover:text-red-600 hover:bg-red-50"
              }`}
            >
              <svg
                className="w-4 h-4 shrink-0"
                fill={matchRating === "bad" ? "currentColor" : "none"}
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 15V19a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 2h3a2 2 0 012 2v7a2 2 0 01-2 2h-3"
                />
              </svg>
              Bad match
            </button>
            {data.rfp.eventUrl && (
              <a
                href={data.rfp.eventUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() =>
                  trackEvent("rfp_external_link_clicked", {
                    rfpId: data.rfp.id,
                    source: "detail",
                    sourceId: data.rfp.sourceId,
                  })
                }
                className="ml-auto text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              >
                View on {portalLabel(data.rfp.sourceId)}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            )}
          </div>
          {matchRating === "bad" && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Why is this a bad match?{" "}
                <span className="text-slate-400">(optional, helps tune your matches)</span>
              </label>
              <textarea
                value={matchReason}
                onChange={(e) => setMatchReason(e.target.value)}
                onBlur={() => void handleSaveReason()}
                placeholder="e.g. Wrong region, contract type we don't bid on, license class we don't hold…"
                rows={2}
                className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-transparent placeholder:text-slate-400 resize-none"
              />
              {feedbackError && <p className="mt-1 text-xs text-red-600">{feedbackError}</p>}
            </div>
          )}

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

        {/* Match Summary — Claude-generated explanation of WHY this scored
            what it did, anchored to the user's profile. Falls back to the
            rule-based summary on failure. */}
        <section className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-6">
          <button
            type="button"
            onClick={() => {
              setMatchSummaryOpen((o) => {
                if (!o && rfpId) trackEvent("rfp_section_expanded", { rfpId, section: "match_summary" });
                return !o;
              });
            }}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Match summary
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              {matchSummaryLoading && (
                <span className="text-xs text-slate-400 animate-pulse">Summarizing…</span>
              )}
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${matchSummaryOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
          </button>
          {matchSummaryOpen && (
            <div className="mt-3">
              {matchSummary ? (
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{matchSummary}</p>
              ) : matchSummaryLoading ? (
                <p className="text-sm text-slate-400 animate-pulse">Generating match summary…</p>
              ) : (
                <p className="text-sm text-slate-500">{buildRuleBasedSummary(data)}</p>
              )}
              {matchSummaryError && (
                <p className="mt-2 text-xs text-amber-600">
                  AI summary unavailable — showing rule-based summary.
                </p>
              )}
            </div>
          )}
        </section>

        {/* About this RFP — Claude-generated structured requirements summary
            plus the structured key-requirements fields (deliverables,
            licenses, NAICS, set-asides, evaluation criteria, etc.) extracted
            from the RFP PDFs. One collapsible covering all of it. */}
        <section className="mb-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-6">
          <button
            type="button"
            onClick={() => {
              setAboutRfpOpen((o) => {
                if (!o && rfpId) trackEvent("rfp_section_expanded", { rfpId, section: "about_rfp" });
                return !o;
              });
            }}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              About this RFP
            </h2>
            <svg className={`w-4 h-4 text-slate-400 transition-transform ${aboutRfpOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
          {aboutRfpOpen && (() => {
            // Deliverables and evaluation criteria intentionally omitted —
            // the AI requirements summary above already covers both, with
            // Deliverables explicitly prioritized in the prompt as the most
            // important bullet list. The fields below stay as chips because
            // chip form is scannable in a way prose isn't.
            const hasClearances = data.rfp.clearancesRequired.length > 0;
            const hasSetAsides = data.rfp.setAsideTypes.length > 0;
            const hasLicenses = data.rfp.licensesRequired.length > 0;
            const hasNaics = data.rfp.naicsCodes.length > 0;
            const hasCerts = data.rfp.certificationsRequired.length > 0;
            const anyKeyRequirement =
              hasClearances ||
              hasSetAsides ||
              hasLicenses ||
              hasNaics ||
              hasCerts;
            return (
              <div className="mt-3">
                {requirementsSummaryLoading && !requirementsSummary ? (
                  <p className="text-sm text-slate-400 animate-pulse">Summarizing contract requirements…</p>
                ) : requirementsSummary ? (
                  <MarkdownContent content={requirementsSummary} />
                ) : data.rfp.description?.trim() ? (
                  <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">
                    {data.rfp.description}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">No description available for this RFP.</p>
                )}
                {requirementsSummaryError && data.rfp.description?.trim() && (
                  <p className="mt-2 text-xs text-amber-600">
                    AI summary unavailable — showing original description.
                  </p>
                )}
                {data.rfp.contractDuration && (
                  <p className="mt-3 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">Contract duration:</span>{" "}
                    {data.rfp.contractDuration}
                  </p>
                )}
                {anyKeyRequirement && (
                  <div className="mt-5 pt-5 border-t border-slate-200 space-y-5 text-sm">
                    {hasNaics && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1.5">NAICS codes</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {data.rfp.naicsCodes.map((n) => (
                            <span
                              key={n}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200"
                            >
                              {n}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {hasCerts && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1.5">Certifications</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {data.rfp.certificationsRequired.map((c, i) => (
                            <span
                              key={i}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {hasLicenses && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1.5">Licenses</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {data.rfp.licensesRequired.map((l, i) => (
                            <span
                              key={i}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100"
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {hasClearances && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1.5">Clearances required</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {data.rfp.clearancesRequired.map((c, i) => (
                            <span
                              key={i}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {hasSetAsides && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1.5">Set-asides</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {data.rfp.setAsideTypes.map((s, i) => (
                            <span
                              key={i}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-50 text-violet-700 border border-violet-100"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </section>

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

        {/* Capabilities Analysis — Claude prose comparing the user's
            profile to the RFP's stated requirements. Distinct from the
            score breakdown above (that's deterministic + token-level). */}
        <section className="mt-8 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-6">
          <button
            type="button"
            onClick={() => {
              setCapabilitiesOpen((o) => {
                if (!o && rfpId) trackEvent("rfp_section_expanded", { rfpId, section: "capabilities" });
                return !o;
              });
            }}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Capabilities analysis
            </h2>
            <svg className={`w-4 h-4 text-slate-400 transition-transform ${capabilitiesOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
          {capabilitiesOpen && (
            <div className="mt-3">
              {!profileLoaded ? (
                <p className="text-sm text-slate-400 animate-pulse">Loading profile…</p>
              ) : !profile ? (
                <p className="text-sm text-slate-500">
                  Complete your company profile to see a capabilities analysis.
                </p>
              ) : capabilitiesAnalysisLoading && !capabilitiesAnalysis ? (
                <p className="text-sm text-slate-400 animate-pulse">
                  Analyzing your capabilities against the requirements…
                </p>
              ) : capabilitiesAnalysis ? (
                <MarkdownContent content={capabilitiesAnalysis} />
              ) : capabilitiesAnalysisError ? (
                <p className="text-xs text-amber-600">Capabilities analysis unavailable right now.</p>
              ) : (
                <p className="text-sm text-slate-500">No analysis available.</p>
              )}
            </div>
          )}
        </section>

        {/* Attachments — prefer S3-mirrored PDFs (served via /api/attachments/);
            fall back to original source URLs only when no mirror exists. */}
        {(() => {
          const mirrors = data.rfp.mirroredAttachments ?? [];
          const fallback = (data.rfp.attachmentUrls ?? []).filter(
            (url) => url && !url.startsWith("planetbids://"),
          );
          type Link = { href: string; label: string; key: string };
          const links: Link[] = [
            ...mirrors.map((m, i) => ({
              href: `/api/attachments/${m.s3Key}`,
              label: m.filename || `Attachment ${i + 1}`,
              key: `mirror-${m.s3Key}`,
            })),
            ...(mirrors.length === 0
              ? fallback.map((url, i) => {
                  let label = `Attachment ${i + 1}`;
                  try {
                    const u = new URL(url);
                    const last = u.pathname.split("/").filter(Boolean).pop();
                    if (last) label = decodeURIComponent(last);
                  } catch {}
                  return { href: url, label, key: `src-${url}-${i}` };
                })
              : []),
          ];
          if (links.length === 0) return null;
          return (
            <section className="mt-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-6">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-3">
                Attachments ({links.length})
              </h2>
              <ul className="space-y-2">
                {links.map((link, idx) => (
                  <li key={link.key}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() =>
                        trackEvent("rfp_attachment_clicked", {
                          rfpId: data.rfp.id,
                          attachmentIndex: idx,
                          hasMirror: link.key.startsWith("mirror-"),
                        })
                      }
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 transition-colors"
                    >
                      <svg
                        className="w-4 h-4 text-red-500 shrink-0"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 7V3.5L19.5 9H14z" />
                      </svg>
                      <span className="truncate max-w-[40ch]">{link.label}</span>
                      <svg
                        className="w-3.5 h-3.5 text-slate-400 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })()}

        {/* Contact info pulled from the RFP raw payload. */}
        {(data.rfp.contactName || data.rfp.contactEmail || data.rfp.contactPhone) && (
          <section className="mt-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-6">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-3">
              Contact
            </h2>
            {data.rfp.contactName && (
              <p className="text-sm text-slate-700">{data.rfp.contactName}</p>
            )}
            {data.rfp.contactEmail && (
              <a
                href={`mailto:${data.rfp.contactEmail}`}
                className="text-sm text-[#3C89C6] hover:underline"
              >
                {data.rfp.contactEmail}
              </a>
            )}
            {data.rfp.contactPhone && (
              <p className="text-sm text-slate-600 mt-1">{data.rfp.contactPhone}</p>
            )}
          </section>
        )}

        {/* Original description as a fallback / for completeness — useful
            when the LLM summary is short or the user wants to read the
            full source text. */}
        {data.rfp.description && (
          <details className="mt-6 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/60 shadow-lg shadow-slate-200/50 p-5 group">
            <summary className="text-sm font-bold text-slate-900 uppercase tracking-wider cursor-pointer select-none">
              Full RFP description
            </summary>
            <p className="mt-3 text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">
              {data.rfp.description}
            </p>
          </details>
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
