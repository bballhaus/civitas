"use client";

import React, { useState, useEffect, useCallback, startTransition } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  type RFP,
  type RFPMatch,
  type CompanyProfile,
  type ScoreBreakdown,
  computeMatch,
  generateMatchSummary,
} from "@/lib/rfp-matching";
import { MarkdownContent } from "@/components/MarkdownContent";
import { getCurrentUser, getGeneratedPoe, updateUserRfpStatus, setRfpStatus, listContracts } from "@/lib/api";
import { getCachedEvents } from "@/lib/events-cache";
import { trackEvent } from "@/lib/event-tracker";
import { portalLabel } from "@/lib/rfp-portal";

// Feature flag: AI Proposal and Plan-of-Execution generation are hidden from
// the UI for the v-0.1 test-user launch. The backend routes
// (/api/generate-proposal, /api/generate-plan-of-execution) remain available;
// only the entry points in the UI are removed. Flip back to `true` to restore.
const SHOW_AI_GENERATION = false;

type RFPWithMatch = RFP & { match: RFPMatch };

export default function RFPDetailPage() {
  const params = useParams();
  const id = params?.id ? decodeURIComponent(String(params.id)) : "";
  const [rfpData, setRfpData] = useState<RFP | null>(null);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [planOfExecution, setPlanOfExecution] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [proposalExpanded, setProposalExpanded] = useState(true);
  const [planExpanded, setPlanExpanded] = useState(true);
  const [proposalFeedback, setProposalFeedback] = useState("");
  const [planFeedback, setPlanFeedback] = useState("");
  const [requirementsSummary, setRequirementsSummary] = useState<string | null>(null);
  const [requirementsSummaryLoading, setRequirementsSummaryLoading] = useState(false);
  const [requirementsSummaryError, setRequirementsSummaryError] = useState(false);
  const [expandedBreakdownCategory, setExpandedBreakdownCategory] = useState<string | null>(null);
  const [capabilitiesAnalysis, setCapabilitiesAnalysis] = useState<string | null>(null);
  const [capabilitiesAnalysisLoading, setCapabilitiesAnalysisLoading] = useState(false);
  const [capabilitiesAnalysisError, setCapabilitiesAnalysisError] = useState(false);
  const [matchSummaryOpen, setMatchSummaryOpen] = useState(false);
  const [scoreBreakdownOpen, setScoreBreakdownOpen] = useState(false);
  const [aboutRfpOpen, setAboutRfpOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [appliedRfpIds, setAppliedRfpIds] = useState<Set<string>>(new Set());
  const [inProgressRfpIds, setInProgressRfpIds] = useState<Set<string>>(new Set());
  const [savedRfpIds, setSavedRfpIds] = useState<Set<string>>(new Set());
  const [userRfpStatusLoaded, setUserRfpStatusLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<"match" | "generated">("match");
  // Match feedback (thumbs up/down + optional "why" reason). Mirrors the
  // sidebar widget in /dashboard. The reason text is only shown / saved
  // for "bad" ratings, matching the dashboard UX.
  const [matchRating, setMatchRating] = useState<"good" | "bad" | null>(null);
  const [matchReason, setMatchReason] = useState<string>("");
  const [savedMatchReason, setSavedMatchReason] = useState<string>("");
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const rfp: RFPWithMatch | null = rfpData && profileLoaded
    ? { ...rfpData, match: computeMatch(rfpData, profile) }
    : null;

  useEffect(() => {
    const saved = localStorage.getItem("companyProfile");
    const extracted = localStorage.getItem("extractedProfileData");
    if (saved) {
      try {
        setProfile(JSON.parse(saved));
      } catch {
        // ignore
      }
    } else if (extracted) {
      try {
        setProfile(JSON.parse(extracted));
      } catch {
        // ignore
      }
    }
    setProfileLoaded(true);
  }, []);

  // Fire rfp_viewed once per RFP, with match info if available. Tracked via
  // a ref so re-renders (e.g. when match recomputes) don't re-fire.
  //
  // Also persists a server-side first-view timestamp on match_state so the
  // daily roundup digest can filter to "unviewed" RFPs. Fire-and-forget —
  // tracking must never block the user.
  const rfpViewedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!id || rfpViewedRef.current === id) return;
    if (!rfpData) return; // wait for RFP to load before firing
    rfpViewedRef.current = id;
    const matchScore = rfp?.match?.score;
    const matchTier = rfp?.match?.tier;
    trackEvent("rfp_viewed", {
      rfpId: id,
      pagePath: "/dashboard/rfp",
      ...(typeof matchScore === "number" ? { matchScore } : {}),
      ...(typeof matchTier === "string" ? { matchTier } : {}),
    });
    fetch("/api/rfp-views/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rfpId: id }),
      keepalive: true,
    }).catch(() => {
      // Best-effort: the next visit will catch it if this one drops.
    });
  }, [id, rfpData, rfp]);

  useEffect(() => {
    getCurrentUser(true).then((full) => {
      setUserRfpStatusLoaded(true);
      if (full) {
        setAppliedRfpIds(new Set(full.bid_submitted_rfp_ids ?? []));
        setInProgressRfpIds(new Set(full.in_progress_rfp_ids ?? []));
        const fb = full.match_feedback_by_rfp?.[id];
        if (fb) {
          setMatchRating(fb.rating);
          setSavedMatchReason(fb.reason ?? "");
          setMatchReason(fb.reason ?? "");
        }
      }
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    getGeneratedPoe(id).then((saved) => {
      if (saved) setPlanOfExecution(saved);
    });
  }, [id]);

  // Save generated POE when leaving the page while on generated view
  useEffect(() => {
    return () => {
      if (viewMode === "generated" && planOfExecution && id) {
        updateUserRfpStatus({
          save_generated_poe: { rfp_id: id, content: planOfExecution },
        }).catch(() => {});
      }
    };
  }, [viewMode, planOfExecution, id]);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setError("Invalid RFP ID");
      return;
    }
    const preloadKey = "civitas_preload_rfp";
    let preloaded: RFP | null = null;
    try {
      const raw = typeof window !== "undefined" ? sessionStorage.getItem(preloadKey) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as RFP;
        if (parsed && parsed.id === id) {
          preloaded = parsed;
          sessionStorage.removeItem(preloadKey);
        }
      }
    } catch {
      // ignore
    }

    if (preloaded) {
      setRfpData(preloaded);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = getCachedEvents();
    if (cached && cached.length > 0) {
      const found = cached.find((e) => e.id === id);
      if (found) {
        setRfpData(found);
        setLoading(false);
        setError(null);
        return;
      }
    }

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/events");
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const events: RFP[] = data.events ?? [];
        const found = events.find((e) => e.id === id);
        if (!found) {
          setError("RFP not found");
          setRfpData(null);
          return;
        }
        setRfpData(found);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load RFP");
        setRfpData(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  useEffect(() => {
    if (!rfpData) return;
    const rfp: RFP = rfpData;

    let cancelled = false;
    setSummaryLoading(true);
    setSummaryError(false);

    const match = computeMatch(rfp, profile);
    const initialSummary = generateMatchSummary(rfp, match);

    async function fetchSummary() {
      try {
        const res = await fetch("/api/match-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rfp: {
              title: rfp.title,
              agency: rfp.agency,
              industry: rfp.industry,
              location: rfp.location,
              deadline: rfp.deadline,
              capabilities: rfp.capabilities,
              certifications: rfp.certifications,
              contractType: rfp.contractType,
              description: (rfp.description || "").slice(0, 1500),
              naicsCodes: (rfp as any).naicsCodes,
              clearancesRequired: (rfp as any).clearancesRequired,
              setAsideTypes: (rfp as any).setAsideTypes,
              deliverables: (rfp as any).deliverables,
              attachmentRollup: (rfp as any).attachmentRollup ?? null,
            },
            profile: profile
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
              : null,
            currentSummary: initialSummary,
            positiveReasons: match.positiveReasons,
            negativeReasons: match.negativeReasons,
          }),
        });
        if (cancelled) return;
        if (!res.ok || !res.body) {
          const errText = await res.text();
          console.error("[match-summary] API error:", res.status, errText);
          throw new Error(errText);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) {
            reader.cancel();
            return;
          }
          accumulated += decoder.decode(value, { stream: true });
          const partial = accumulated;
          startTransition(() => setSummary(partial));
        }
        accumulated += decoder.decode();
        if (cancelled) return;
        const final = accumulated || initialSummary;
        startTransition(() => setSummary(final));
      } catch (err) {
        console.error("[match-summary] Fetch failed:", err);
        if (!cancelled) {
          setSummaryError(true);
          startTransition(() => setSummary(generateMatchSummary(rfp, match)));
        }
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    }

    fetchSummary();
    return () => {
      cancelled = true;
    };
  }, [rfpData?.id, profile, profileLoaded]);

  useEffect(() => {
    if (!rfpData || !rfpData.description?.trim()) return;
    const rfp: RFP = rfpData;

    let cancelled = false;
    setRequirementsSummaryLoading(true);
    setRequirementsSummaryError(false);

    async function fetchRequirementsSummary() {
      try {
        const res = await fetch("/api/rfp-requirements-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rfp: {
              title: rfp.title,
              agency: rfp.agency,
              industry: rfp.industry,
              location: rfp.location,
              deadline: rfp.deadline,
              contractType: rfp.contractType,
              capabilities: rfp.capabilities,
              certifications: rfp.certifications,
              estimatedValue: rfp.estimatedValue,
              description: rfp.description,
              attachmentRollup: (rfp as any).attachmentRollup ?? null,
            },
          }),
        });
        if (cancelled) return;
        if (!res.ok || !res.body) throw new Error(await res.text());
        // Endpoint streams plain text; accumulate as the bytes arrive so the
        // section paints in progressively. setRequirementsSummaryLoading is
        // dropped on the first chunk so the spinner gives way to text.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) { reader.cancel(); return; }
          accumulated += decoder.decode(value, { stream: true });
          if (firstChunk) {
            setRequirementsSummaryLoading(false);
            firstChunk = false;
          }
          startTransition(() => setRequirementsSummary(accumulated));
        }
        accumulated += decoder.decode();
        startTransition(() => setRequirementsSummary(accumulated || rfp.description));
      } catch (err) {
        console.error("[rfp-requirements-summary] Fetch failed:", err);
        if (!cancelled) {
          setRequirementsSummaryError(true);
          startTransition(() => setRequirementsSummary(null));
        }
      } finally {
        if (!cancelled) setRequirementsSummaryLoading(false);
      }
    }

    fetchRequirementsSummary();
    return () => {
      cancelled = true;
    };
  }, [rfpData?.id]);

  // Fetch capabilities analysis (compares RFP requirements against company profile)
  useEffect(() => {
    if (!rfpData || !profileLoaded) return;
    const rfp: RFP = rfpData;
    const match = computeMatch(rfp, profile);

    let cancelled = false;
    setCapabilitiesAnalysisLoading(true);
    setCapabilitiesAnalysisError(false);

    async function fetchCapabilitiesAnalysis() {
      try {
        const res = await fetch("/api/capabilities-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rfp: {
              title: rfp.title,
              agency: rfp.agency,
              industry: rfp.industry,
              location: rfp.location,
              capabilities: rfp.capabilities,
              certifications: rfp.certifications,
              contractType: rfp.contractType,
              naicsCodes: (rfp as any).naicsCodes,
              clearancesRequired: (rfp as any).clearancesRequired,
              setAsideTypes: (rfp as any).setAsideTypes,
              deliverables: (rfp as any).deliverables,
              estimatedValue: rfp.estimatedValue,
              description: (rfp.description || "").slice(0, 3000),
              attachmentRollup: (rfp as any).attachmentRollup ?? null,
              incumbentVendor: (rfp as any).incumbentVendor ?? null,
              incumbentContractEnd: (rfp as any).incumbentContractEnd ?? null,
            },
            profile: profile
              ? {
                  companyName: profile.companyName,
                  industry: profile.industry,
                  specialties: profile.specialties,
                  capabilities: profile.capabilities,
                  certifications: profile.certifications,
                  workAreas: profile.workAreas,
                  agencyExperience: profile.agencyExperience,
                  contractTypes: profile.contractTypes,
                  technologyStack: (profile as { technologyStack?: string[] }).technologyStack,
                }
              : null,
            breakdown: match.breakdown,
          }),
        });
        if (cancelled) return;
        if (!res.ok || !res.body) throw new Error(await res.text());
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) { reader.cancel(); return; }
          accumulated += decoder.decode(value, { stream: true });
          if (firstChunk) {
            setCapabilitiesAnalysisLoading(false);
            firstChunk = false;
          }
          startTransition(() => setCapabilitiesAnalysis(accumulated));
        }
        accumulated += decoder.decode();
        startTransition(() => setCapabilitiesAnalysis(accumulated || null));
      } catch (err) {
        console.error("[capabilities-analysis] Fetch failed:", err);
        if (!cancelled) {
          setCapabilitiesAnalysisError(true);
          startTransition(() => setCapabilitiesAnalysis(null));
        }
      } finally {
        if (!cancelled) setCapabilitiesAnalysisLoading(false);
      }
    }

    fetchCapabilitiesAnalysis();
    return () => {
      cancelled = true;
    };
  }, [rfpData?.id, profile, profileLoaded]);

  const downloadAsDocx = async (
    content: string,
    title: string,
    filename: string
  ) => {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
    const { saveAs } = await import("file-saver");
    const lines = content.split(/\n/);
    const children = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        continue;
      }
      const isHeading =
        /^\d+\.\s*\*\*/.test(trimmed) ||
        (/^\*\*.*\*\*$/.test(trimmed) && trimmed.length < 80);
      const text = trimmed.replace(/\*\*/g, "");
      if (isHeading) {
        children.push(
          new Paragraph({
            text,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 120 },
          })
        );
      } else {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: trimmed })],
            spacing: { after: 120 },
          })
        );
      }
    }
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              text: title,
              heading: HeadingLevel.TITLE,
              spacing: { after: 240 },
            }),
            new Paragraph({
              text: rfpData!.agency,
              spacing: { after: 360 },
            }),
            ...children,
          ],
        },
      ],
    });
    const blob = await Packer.toBlob(doc);
    const slug = title.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "-");
    saveAs(blob, `${filename}-${slug}.docx`);
  };

  const handleDownloadProposal = () => {
    if (proposal && rfpData)
      downloadAsDocx(proposal, rfpData.title, "Proposal");
  };

  const handleDownloadPlanOfExecution = () => {
    if (planOfExecution && rfpData)
      downloadAsDocx(planOfExecution, rfpData.title, "Plan-of-Execution");
  };

  const proposalPayload = () => ({
    rfp: {
      title: rfpData!.title,
      agency: rfpData!.agency,
      industry: rfpData!.industry,
      location: rfpData!.location,
      deadline: rfpData!.deadline,
      estimatedValue: rfpData!.estimatedValue,
      capabilities: rfpData!.capabilities,
      certifications: rfpData!.certifications,
      contractType: rfpData!.contractType,
      description: rfpData!.description,
      naicsCodes: rfpData!.naicsCodes,
      eventUrl: rfpData!.eventUrl,
      contactName: rfpData!.contactName,
      contactEmail: rfpData!.contactEmail,
      contactPhone: rfpData!.contactPhone,
    },
    profile: profile
            ? {
                companyName: profile.companyName,
                industry: profile.industry,
                sizeStatus: profile.sizeStatus,
                certifications: profile.certifications,
                clearances: profile.clearances,
                naicsCodes: profile.naicsCodes,
                workAreas: profile.workAreas,
                specialties: profile.specialties,
                capabilities: profile.capabilities,
                agencyExperience: profile.agencyExperience,
                contractTypes: profile.contractTypes,
              }
            : null,
  });

  const handleGenerateProposal = async (feedbackText?: string) => {
    if (!rfpData || proposalLoading) return;
    const trimmed = String(feedbackText ?? "").trim();
    setProposalLoading(true);
    setProposalError(null);
    if (!trimmed) setProposal(null);

    setInProgressRfpIds((prev) => new Set([...prev, id]));
    setRfpStatus(id, "in_progress").catch(() => {});

    try {
      // Fetch past contract document URLs for style reference
      let pastDocumentUrls: string[] = [];
      try {
        const contracts = await listContracts();
        pastDocumentUrls = contracts
          .map((c) => c.document)
          .filter((url): url is string => !!url && url.length > 0);
      } catch {
        // Non-critical: proceed without style reference
      }

      const res = await fetch("/api/generate-proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...proposalPayload(),
          pastDocumentUrls,
          ...(trimmed && {
            currentProposal: proposal,
            feedback: trimmed,
          }),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }
      const data = await res.json();
      setProposal(data.proposal ?? "");
      setProposalFeedback("");
    } catch (err) {
      setProposalError(
        err instanceof Error ? err.message : "Failed to generate proposal"
      );
    } finally {
      setProposalLoading(false);
    }
  };

  const planPayload = () => ({
    rfp: {
      title: rfpData!.title,
      agency: rfpData!.agency,
      industry: rfpData!.industry,
      location: rfpData!.location,
      deadline: rfpData!.deadline,
      estimatedValue: rfpData!.estimatedValue,
      capabilities: rfpData!.capabilities,
      certifications: rfpData!.certifications,
      contractType: rfpData!.contractType,
      description: rfpData!.description,
      naicsCodes: rfpData!.naicsCodes,
      eventUrl: rfpData!.eventUrl,
      contactName: rfpData!.contactName,
      contactEmail: rfpData!.contactEmail,
      contactPhone: rfpData!.contactPhone,
    },
    profile: profile
      ? {
          companyName: profile.companyName,
          industry: profile.industry,
          sizeStatus: profile.sizeStatus,
          certifications: profile.certifications,
          clearances: profile.clearances,
          naicsCodes: profile.naicsCodes,
          workAreas: profile.workAreas,
          specialties: profile.specialties,
          capabilities: profile.capabilities,
          agencyExperience: profile.agencyExperience,
          contractTypes: profile.contractTypes,
        }
      : null,
  });

  // Saved RFPs are session-only until the Postgres-backed persistence ships
  // (see project memory: project_saved_rfps_postgres_migration).
  const handleToggleSave = useCallback(() => {
    if (!id) return;
    const currentlySaved = savedRfpIds.has(id);
    setSavedRfpIds((prev) => {
      const next = new Set(prev);
      if (currentlySaved) next.delete(id);
      else next.add(id);
      return next;
    });
    // rfp_saved / rfp_unsaved events are emitted server-side by /api/user/rfp-status.
    // (No-op here: this v1 page's Save is session-local; see /matches/[rfpId] for
    // the server-persisted Save flow.)
  }, [id, savedRfpIds]);

  const handleToggleApplied = useCallback(async () => {
    if (!id) return;
    const currentlyApplied = appliedRfpIds.has(id);
    const currentlyInProgress = inProgressRfpIds.has(id);
    setAppliedRfpIds((prev) => {
      const next = new Set(prev);
      if (currentlyApplied) next.delete(id);
      else next.add(id);
      return next;
    });
    if (currentlyApplied) {
      setInProgressRfpIds((prev) => new Set([...prev, id]));
    } else if (currentlyInProgress) {
      setInProgressRfpIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    try {
      // Toggling "Applied" on the v1 detail page now maps to the new
      // bid_submitted ↔ in_progress pipeline transition in match_state.
      await setRfpStatus(id, currentlyApplied ? "in_progress" : "bid_submitted");
    } catch (e) {
      setAppliedRfpIds((prev) => {
        const next = new Set(prev);
        if (currentlyApplied) next.add(id);
        else next.delete(id);
        return next;
      });
      if (currentlyApplied) {
        setInProgressRfpIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else if (currentlyInProgress) {
        setInProgressRfpIds((prev) => new Set([...prev, id]));
      }
      console.error("Failed to update applied status:", e);
    }
  }, [id, appliedRfpIds, inProgressRfpIds]);

  // Match feedback — submit / change rating. "good" persists immediately
  // with no reason. "bad" persists immediately too; the reason input shows
  // up underneath and is saved separately on blur so the user isn't forced
  // to type before the rating sticks.
  const handleSubmitMatchFeedback = useCallback(
    async (rating: "good" | "bad") => {
      if (!id || !rfpData) return;
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
            rfp_id: id,
            rating,
            reason: rating === "bad" ? matchReason.trim() || undefined : undefined,
            match_score: rfp?.match?.score ?? 0,
            match_tier: rfp?.match?.tier ?? "low",
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
    [id, rfpData, matchRating, savedMatchReason, matchReason, rfp?.match?.score, rfp?.match?.tier],
  );

  const handleRemoveMatchFeedback = useCallback(async () => {
    if (!id) return;
    const previousRating = matchRating;
    const previousReason = savedMatchReason;
    setMatchRating(null);
    setMatchReason("");
    setSavedMatchReason("");
    setFeedbackError(null);
    try {
      await updateUserRfpStatus({ remove_match_feedback: id });
    } catch (err) {
      setMatchRating(previousRating);
      setSavedMatchReason(previousReason);
      setMatchReason(previousReason);
      setFeedbackError(err instanceof Error ? err.message : "Failed to remove feedback");
    }
  }, [id, matchRating, savedMatchReason]);

  // Re-save the reason text when the user edits it on a "bad" rating. We
  // wait until blur so we don't fire a write per keystroke; the rating
  // itself is already persisted by the time this runs.
  const handleSaveReason = useCallback(async () => {
    if (!id || matchRating !== "bad") return;
    const trimmed = matchReason.trim();
    if (trimmed === savedMatchReason.trim()) return;
    setFeedbackSaving(true);
    setFeedbackError(null);
    try {
      await updateUserRfpStatus({
        submit_match_feedback: {
          rfp_id: id,
          rating: "bad",
          reason: trimmed || undefined,
          match_score: rfp?.match?.score ?? 0,
          match_tier: rfp?.match?.tier ?? "low",
        },
      });
      setSavedMatchReason(trimmed);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to save reason");
    } finally {
      setFeedbackSaving(false);
    }
  }, [id, matchRating, matchReason, savedMatchReason, rfp?.match?.score, rfp?.match?.tier]);

  const handleGeneratePlanOfExecution = async (feedbackText?: string) => {
    if (!rfpData || planLoading) return;
    const trimmed = String(feedbackText ?? "").trim();
    setPlanLoading(true);
    setPlanError(null);
    if (!trimmed) setPlanOfExecution(null);

    // Mark in progress as soon as the button is pressed (even if POE generation fails or doesn't finish)
    setInProgressRfpIds((prev) => new Set([...prev, id]));
    setRfpStatus(id, "in_progress").catch(() => {});

    try {
      const res = await fetch("/api/generate-plan-of-execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planPayload(),
          ...(trimmed && {
            currentPlan: planOfExecution,
            feedback: trimmed,
          }),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || res.statusText);
      }
      const data = await res.json();
      setPlanOfExecution(data.plan ?? "");
      setPlanFeedback("");
      setViewMode("generated");
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : "Failed to generate plan"
      );
    } finally {
      setPlanLoading(false);
    }
  };

  const goToMatchView = () => {
    if (viewMode === "generated" && planOfExecution && id) {
      updateUserRfpStatus({
        save_generated_poe: { rfp_id: id, content: planOfExecution },
      }).catch(() => {});
    }
    setViewMode("match");
  };

  const goToGeneratedView = () => {
    setViewMode("generated");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f5f5f5] flex items-center justify-center">
        <p className="text-slate-600">Loading RFP…</p>
      </div>
    );
  }

  if (error || !rfp) {
    return (
      <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-slate-700">{error ?? "RFP not found"}</p>
        <Link
          href="/home"
          className="text-[#2563eb] hover:underline font-medium"
        >
          ← Back to Home
        </Link>
      </div>
    );
  }

  const displaySummary = summary ?? generateMatchSummary(rfp, rfp.match);

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10 shadow-sm">
        <div className="max-w-full mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/logo.png" alt="Civitas logo" className="h-10 w-10" />
            <span className="text-xl font-bold text-slate-900">Civitas</span>
          </Link>
          <Link
            href="/home"
            className="text-slate-600 hover:text-slate-900 text-sm font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Home
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <article className="rounded-2xl overflow-hidden bg-white shadow-sm border border-slate-200">
          {/* Header */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-3">
              <h1 className="text-2xl font-bold text-slate-900">{rfp.title}</h1>
              {rfp.match && !rfp.match.disqualified && (
                <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold shrink-0 ${
                  rfp.match.tier === "excellent" ? "bg-emerald-500 text-white" :
                  rfp.match.tier === "strong" ? "bg-blue-500 text-white" :
                  rfp.match.tier === "moderate" ? "bg-amber-400 text-amber-900" :
                  "bg-slate-200 text-slate-600"
                }`}>
                  {rfp.match.tier === "excellent" && <span className="mr-1">★</span>}
                  {Math.round(rfp.match.score)}% · {rfp.match.tier.charAt(0).toUpperCase() + rfp.match.tier.slice(1)}
                </span>
              )}
            </div>
            {/* Action buttons row */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <button
                type="button"
                onClick={handleToggleSave}
                className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
                  savedRfpIds.has(id)
                    ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                }`}
              >
                <svg className="w-4 h-4 shrink-0" fill={savedRfpIds.has(id) ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                {savedRfpIds.has(id) ? "Saved" : "Save"}
              </button>
              {userRfpStatusLoaded && (
                <button
                  type="button"
                  onClick={handleToggleApplied}
                  className={`text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
                    appliedRfpIds.has(id)
                      ? "text-emerald-600 bg-emerald-50 hover:bg-emerald-100"
                      : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {appliedRfpIds.has(id) ? (
                    <>
                      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Applied
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      I&apos;ve applied
                    </>
                  )}
                </button>
              )}
              {SHOW_AI_GENERATION && (
                <>
                  <span className="w-px h-5 bg-slate-200 mx-1" />
                  <button
                    type="button"
                    onClick={() => handleGenerateProposal()}
                    disabled={proposalLoading}
                    className="text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors text-[#2563eb] hover:bg-blue-50 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {proposalLoading ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Generating…
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Generate Proposal
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGeneratePlanOfExecution()}
                    disabled={planLoading}
                    className="text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors text-emerald-600 hover:bg-emerald-50 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {planLoading ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Generating…
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                        </svg>
                        Generate Plan of Execution
                      </>
                    )}
                  </button>
                </>
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
                <svg className="w-4 h-4 shrink-0" fill={matchRating === "good" ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
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
                <svg className="w-4 h-4 shrink-0" fill={matchRating === "bad" ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 15V19a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 2h3a2 2 0 012 2v7a2 2 0 01-2 2h-3" />
                </svg>
                Bad match
              </button>
              {(rfp.eventUrl || rfp.id) && (
                <a
                  href={rfp.eventUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                >
                  View on {portalLabel(rfp.sourceId)}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}
              {inProgressRfpIds.has(id) && (
                <span className="text-sm flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-50 text-violet-700 border border-violet-100">
                  In progress
                </span>
              )}
            </div>
            {/* Bad-match reason capture — appears only after the user marks
                bad, lets them tell us why so the matcher can use the signal.
                Saved on blur to avoid one write per keystroke. */}
            {matchRating === "bad" && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Why is this a bad match? <span className="text-slate-400">(optional, helps tune your matches)</span>
                </label>
                <textarea
                  value={matchReason}
                  onChange={(e) => setMatchReason(e.target.value)}
                  onBlur={() => void handleSaveReason()}
                  placeholder="e.g. Wrong region, contract type we don't bid on, license class we don't hold…"
                  rows={2}
                  className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-transparent placeholder:text-slate-400 resize-none"
                />
                {feedbackError && (
                  <p className="mt-1 text-xs text-red-600">{feedbackError}</p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mb-4">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600">
                {rfp.location}
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-pink-50 text-pink-600">
                {rfp.industry}
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-50 text-amber-600">
                {rfp.capabilities[0] || rfp.contractType || "Contract"}
              </span>
              {rfp.incumbentVendor && (
                <span
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-50 text-red-700"
                  title={
                    rfp.incumbentContractEnd
                      ? `Current contract ends ${rfp.incumbentContractEnd}`
                      : undefined
                  }
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Incumbent: {rfp.incumbentVendor}
                </span>
              )}
            </div>
            <ul className="text-sm text-slate-600 space-y-1">
              <li><span className="text-slate-400 font-medium">Requested by:</span> <span className="text-slate-900 font-medium">{rfp.agency}</span>{rfp.industry ? ` · ${rfp.industry}` : ""}</li>
              <li>Due {rfp.deadline} · {rfp.estimatedValue}</li>
            </ul>
            {/* Tab switcher — hidden when AI generation is disabled (no second view to switch to). */}
            {SHOW_AI_GENERATION && (
              <div className="mt-4 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={goToMatchView}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    viewMode === "match"
                      ? "bg-slate-200 text-slate-700 cursor-default"
                      : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 shadow-sm"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  RFP Match
                </button>
                <button
                  type="button"
                  onClick={goToGeneratedView}
                  className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    viewMode === "generated"
                      ? "bg-emerald-100 text-emerald-800 cursor-default"
                      : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 shadow-sm"
                  }`}
                >
                  Generated POE
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Disqualifier banner */}
          {rfp.match.disqualified && rfp.match.disqualifiers.length > 0 && (
            <div className="px-6 md:px-8 py-4 border-b border-red-100 bg-red-50">
              <h2 className="text-sm font-bold text-red-800 mb-2">Not Eligible</h2>
              <ul className="space-y-1">
                {rfp.match.disqualifiers.map((d, i) => (
                  <li key={i} className="text-sm text-red-700 flex items-start gap-2">
                    <span className="text-red-500 shrink-0 mt-0.5">✗</span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Groq-generated summary */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <div className={`rounded-xl border-2 ${rfp.match.disqualified ? "border-red-200" : "border-blue-200"} bg-white p-5`}>
              <button
                type="button"
                onClick={() => setMatchSummaryOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 text-left"
              >
                <h2 className="text-sm font-bold text-slate-900">
                  {rfp.match.disqualified ? "Match Analysis" : "Why this is a good match"}
                </h2>
                <div className="flex items-center gap-2 shrink-0">
                  {summaryLoading && (
                    <span className="text-xs text-slate-400 animate-pulse">AI summarizing…</span>
                  )}
                  <svg className={`w-4 h-4 text-slate-400 transition-transform ${matchSummaryOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
              </button>
              {matchSummaryOpen && (
                <div className="mt-3">
                  <p className="text-slate-700 leading-relaxed">{displaySummary}</p>
                  {summaryError && (
                    <p className="mt-2 text-xs text-amber-600">
                      AI summary unavailable. Showing rule-based summary.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Score Breakdown */}
          {rfp.match.breakdown.length > 0 && !rfp.match.disqualified && (
            <div className="p-6 md:p-8 border-b border-slate-100">
              <button
                type="button"
                onClick={() => setScoreBreakdownOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 text-left mb-3"
              >
                <h2 className="text-sm font-bold text-slate-900">Score Breakdown</h2>
                <svg className={`w-4 h-4 text-slate-400 transition-transform ${scoreBreakdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {scoreBreakdownOpen && (
              <div className="space-y-3">
                {rfp.match.breakdown.filter((b) => b.maxPoints > 0 || b.status !== "neutral").map((b, i) => {
                  const pct = b.maxPoints > 0 ? (b.points / b.maxPoints) * 100 : 0;
                  const barColor =
                    b.status === "strong" ? "bg-emerald-500" :
                    b.status === "partial" ? "bg-blue-400" :
                    b.status === "weak" ? "bg-amber-400" :
                    b.status === "missing" ? "bg-red-300" :
                    "bg-slate-200";
                  const textColor =
                    b.status === "strong" ? "text-emerald-700" :
                    b.status === "partial" ? "text-blue-700" :
                    b.status === "weak" ? "text-amber-700" :
                    b.status === "missing" ? "text-red-600" :
                    "text-slate-500";
                  const isExpanded = expandedBreakdownCategory === b.category;
                  const hasTokens = (b.rfpTokens && b.rfpTokens.length > 0) || (b.profileTokens && b.profileTokens.length > 0);

                  return (
                    <div key={i}>
                      <div
                        className={`${hasTokens ? "cursor-pointer rounded-md p-1 -m-1 hover:bg-slate-50 transition-colors" : ""}`}
                        onClick={() => hasTokens && setExpandedBreakdownCategory(isExpanded ? null : b.category)}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-slate-700 flex items-center gap-1">
                            {b.category}
                            {hasTokens && (
                              <svg className={`w-3 h-3 text-slate-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                            )}
                          </span>
                          {b.maxPoints > 0 && (
                            <span className={`text-xs font-bold ${textColor}`}>{b.points}/{b.maxPoints}</span>
                          )}
                        </div>
                        {b.maxPoints > 0 ? (
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                          </div>
                        ) : (
                          <p className={`text-xs ${textColor}`}>{b.detail}</p>
                        )}
                      </div>
                      {isExpanded && hasTokens && (
                        <div className="mt-2 mb-1 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-2">
                          {b.rfpTokens && b.rfpTokens.length > 0 && (
                            <div>
                              <span className="font-semibold text-slate-600">RFP requires:</span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {b.rfpTokens.map((t, j) => (
                                  <span key={j} className={`px-2 py-0.5 rounded-full ${b.matchedTokens?.includes(t) ? "bg-emerald-100 text-emerald-700 font-medium" : "bg-slate-200 text-slate-600"}`}>{t}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {b.profileTokens && b.profileTokens.length > 0 && (
                            <div>
                              <span className="font-semibold text-slate-600">Your profile:</span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {b.profileTokens.map((t, j) => (
                                  <span key={j} className={`px-2 py-0.5 rounded-full ${b.matchedTokens?.includes(t) ? "bg-emerald-100 text-emerald-700 font-medium" : "bg-blue-50 text-blue-600"}`}>{t}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {b.matchedTokens && b.matchedTokens.length > 0 && (
                            <div className="pt-1 border-t border-slate-200">
                              <span className="font-semibold text-emerald-700">Matched:</span>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {b.matchedTokens.map((t, j) => (
                                  <span key={j} className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">{t}</span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}

          {/* Generated content */}
          {(proposalError || planError || proposal || planOfExecution) && (
          <div className="p-6 md:p-8 border-b border-slate-100 space-y-3">
            {proposalError && (
              <p className="text-sm text-red-600">{proposalError}</p>
            )}
            {planError && (
              <p className="text-sm text-red-600">{planError}</p>
            )}
            {proposal && (
              <div className="mt-6 rounded-xl border-2 border-slate-200 bg-slate-50 overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setProposalExpanded((e) => !e)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProposalExpanded((v) => !v); } }}
                  className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-slate-100/50 transition-colors cursor-pointer"
                >
                  <h3 className="text-sm font-bold text-slate-900">Generated Proposal</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadProposal();
                      }}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Download
                    </button>
                    <svg
                      className={`w-5 h-5 text-slate-500 shrink-0 transition-transform ${proposalExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                {proposalExpanded && (
                  <div className="px-4 pb-4 pt-0">
                    <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                      {proposal}
                    </div>
                    <div className="mt-4 pt-4 border-t border-slate-200">
                      <label className="block text-xs font-medium text-slate-700 mb-2">
                        Add feedback to improve (optional)
                      </label>
                      <textarea
                        value={proposalFeedback}
                        onChange={(e) => setProposalFeedback(e.target.value)}
                        placeholder="e.g. Emphasize our cybersecurity certifications more, or add a section on local presence..."
                        rows={2}
                        className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563eb] focus:border-transparent placeholder:text-slate-600 resize-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleGenerateProposal(proposalFeedback)}
                        disabled={proposalLoading}
                        className="mt-2 inline-flex items-center justify-center gap-2 min-w-[200px] px-4 py-2 rounded-lg text-sm font-medium bg-[#2563eb] text-white hover:bg-[#1d4ed8] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {proposalLoading ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Regenerating…
                          </>
                        ) : (
                          "Regenerate with feedback"
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {planOfExecution && (
              <div className="mt-6 rounded-xl border-2 border-slate-200 bg-slate-50 overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setPlanExpanded((e) => !e)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPlanExpanded((v) => !v); } }}
                  className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-slate-100/50 transition-colors cursor-pointer"
                >
                  <h3 className="text-sm font-bold text-slate-900">Plan of Execution</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadPlanOfExecution();
                      }}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Download
                    </button>
                    <svg
                      className={`w-5 h-5 text-slate-500 shrink-0 transition-transform ${planExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                {planExpanded && (
                  <div className="px-4 pb-4 pt-0">
                    <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                      {planOfExecution}
                    </div>
                    <div className="mt-4 pt-4 border-t border-slate-200">
                      <label className="block text-xs font-medium text-slate-700 mb-2">
                        Add feedback to improve (optional)
                      </label>
                      <textarea
                        value={planFeedback}
                        onChange={(e) => setPlanFeedback(e.target.value)}
                        placeholder="e.g. Add more detail on certification timelines, or expand the risk section..."
                        rows={2}
                        className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent placeholder:text-slate-600 resize-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleGeneratePlanOfExecution(planFeedback)}
                        disabled={planLoading}
                        className="mt-2 inline-flex items-center justify-center gap-2 min-w-[200px] px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {planLoading ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Regenerating…
                          </>
                        ) : (
                          "Regenerate with feedback"
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Match view: generate button, summary, capabilities, about RFP, details. Generated view: POE content. */}
          {viewMode === "match" && (
            <>
          {/* About this RFP — AI-generated requirements summary + the
              structured key-requirements fields (deliverables, clearances,
              set-asides, evaluation criteria) extracted from the RFP PDFs by
              webscraping/v2/pipeline/enrich.py. Quality of the structured
              fields varies by source (Cal eProcure + OpenGov are reliable;
              PlanetBids leaves them empty — see COVERAGE.md). */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <button
              type="button"
              onClick={() => setAboutRfpOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 text-left mb-3"
            >
              <h2 className="text-sm font-bold text-slate-900">About this RFP</h2>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${aboutRfpOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {aboutRfpOpen && (() => {
              // Deliverables and evaluation criteria intentionally omitted —
              // the AI requirements summary above already covers both, with
              // Deliverables explicitly prioritized in the prompt as the most
              // important bullet list. The fields below stay as chips because
              // chip form is scannable in a way prose isn't.
              const hasClearances = (rfp.clearancesRequired?.length ?? 0) > 0;
              const hasSetAsides = (rfp.setAsideTypes?.length ?? 0) > 0;
              const anyKeyRequirement = hasClearances || hasSetAsides;
              return (
                <>
                  {requirementsSummaryLoading && !requirementsSummary ? (
                    <p className="text-slate-500 text-sm animate-pulse">Summarizing contract requirements…</p>
                  ) : requirementsSummary ? (
                    <MarkdownContent content={requirementsSummary} />
                  ) : rfp.description?.trim() ? (
                    <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                      {rfp.description}
                    </p>
                  ) : (
                    <p className="text-slate-500 text-sm">No description available for this RFP.</p>
                  )}
                  {requirementsSummaryError && rfp.description?.trim() && (
                    <p className="mt-2 text-xs text-amber-600">
                      AI summary unavailable. Showing original description.
                    </p>
                  )}
                  {rfp.contractDuration && (
                    <p className="mt-3 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">Contract duration:</span>{" "}
                      {rfp.contractDuration}
                    </p>
                  )}
                  {anyKeyRequirement && (
                    <div className="mt-5 pt-5 border-t border-slate-200 space-y-4 text-sm">
                      {hasClearances && (
                        <div>
                          <h4 className="font-semibold text-slate-700 mb-1.5">Clearances required</h4>
                          <div className="flex flex-wrap gap-1.5">
                            {rfp.clearancesRequired!.map((c, i) => (
                              <span key={i} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100">
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
                            {rfp.setAsideTypes!.map((s, i) => (
                              <span key={i} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-50 text-violet-700 border border-violet-100">
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Capabilities Analysis — LLM compares the user's company profile
              against the RFP's stated requirements to tell them where they're
              strong, partial, or missing. Distinct from the score breakdown
              above: that's deterministic + token-level; this is prose. */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <button
              type="button"
              onClick={() => setCapabilitiesOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 text-left mb-3"
            >
              <h2 className="text-sm font-bold text-slate-900">Capabilities Analysis</h2>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${capabilitiesOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {capabilitiesOpen && (
              <>
                {!profileLoaded ? (
                  <p className="text-slate-500 text-sm animate-pulse">Loading profile…</p>
                ) : !profile ? (
                  <p className="text-slate-500 text-sm">
                    Complete your company profile to see a capabilities analysis.
                  </p>
                ) : capabilitiesAnalysisLoading && !capabilitiesAnalysis ? (
                  <p className="text-slate-500 text-sm animate-pulse">
                    Analyzing your capabilities against the requirements…
                  </p>
                ) : capabilitiesAnalysis ? (
                  <MarkdownContent content={capabilitiesAnalysis} />
                ) : capabilitiesAnalysisError ? (
                  <p className="text-xs text-amber-600">Capabilities analysis unavailable right now.</p>
                ) : (
                  <p className="text-slate-500 text-sm">No analysis available.</p>
                )}
              </>
            )}
          </div>

          {/* Details */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900 mb-3">Details</h2>
            <div className="flex flex-wrap gap-2 mb-4">
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
            </div>
          </div>

          {/* Attachments — prefer S3-mirrored PDFs (stable, served via
              /api/attachments/) over source-portal URLs (most expire within
              hours). Fall back to attachmentUrls only when no mirror exists. */}
          {(() => {
            const mirrors = rfp.mirroredAttachments ?? [];
            const fallback = (rfp.attachmentUrls ?? []).filter((url) => {
              // Drop placeholder URLs (e.g. `planetbids://...`) — they aren't
              // clickable. If a mirror exists, it already covers this PDF.
              if (!url || url.startsWith("planetbids://")) return false;
              return true;
            });
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
              <div className="p-6 md:p-8 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-900 mb-3">
                  Attachments ({links.length})
                </h2>
                <ul className="space-y-2">
                  {links.map((link) => (
                    <li key={link.key}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200 transition-colors"
                      >
                        <svg className="w-4 h-4 text-red-500 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 7V3.5L19.5 9H14z" />
                        </svg>
                        <span className="truncate max-w-[40ch]">{link.label}</span>
                        <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
            </>
          )}

          {/* Generated POE / Plan view */}
          {viewMode === "generated" && (
            <div className="p-6 md:p-8 border-b border-slate-100">
              <h2 className="text-sm font-bold text-slate-900 mb-3">Generated POE / Plan</h2>
              {planLoading ? (
                <p className="text-slate-500 text-sm animate-pulse">Generating plan…</p>
              ) : planOfExecution ? (
                <div className="rounded-xl border-2 border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="p-4">
                    <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                      {planOfExecution}
                    </div>
                    <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap gap-3 items-end">
                      <button
                        type="button"
                        onClick={handleDownloadPlanOfExecution}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Download
                      </button>
                      <div className="flex-1 min-w-[200px]">
                        <label className="block text-xs font-medium text-slate-700 mb-1">Add feedback to improve (optional)</label>
                        <textarea
                          value={planFeedback}
                          onChange={(e) => setPlanFeedback(e.target.value)}
                          placeholder="e.g. Add more detail on certification timelines..."
                          rows={2}
                          className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent placeholder:text-slate-600 resize-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleGeneratePlanOfExecution(planFeedback)}
                        disabled={planLoading}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {planLoading ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Regenerating…
                          </>
                        ) : (
                          "Regenerate with feedback"
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-8 text-center">
                  <p className="text-slate-600 text-sm mb-4">No generated plan yet. Generate a Plan of Execution to see it here.</p>
                  <button
                    type="button"
                    onClick={() => handleGeneratePlanOfExecution()}
                    disabled={planLoading}
                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {planLoading ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Generating…
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                        </svg>
                        Generate POE / Plan
                      </>
                    )}
                  </button>
                </div>
              )}
              {planError && <p className="mt-3 text-sm text-red-600">{planError}</p>}
            </div>
          )}

        </article>
      </main>
    </div>
  );
}
