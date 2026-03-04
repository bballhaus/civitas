"use client";

import React, { useState, useEffect } from "react";
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

type RFPWithMatch = RFP & { match: RFPMatch };

export default function RFPDetailPage() {
  const params = useParams();
  const id = params?.id ? decodeURIComponent(String(params.id)) : "";
  const [rfpData, setRfpData] = useState<RFP | null>(null);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
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

  const rfp: RFPWithMatch | null = rfpData
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
  }, []);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setError("Invalid RFP ID");
      return;
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
            },
            profile: profile
              ? {
                  companyName: profile.companyName,
                  industry: profile.industry,
                  capabilities: profile.capabilities,
                  certifications: profile.certifications,
                  workCities: profile.workCities,
                  workCounties: profile.workCounties,
                  agencyExperience: profile.agencyExperience,
                  contractTypes: profile.contractTypes,
                }
              : null,
            currentSummary: initialSummary,
            positiveReasons: match.positiveReasons,
            negativeReasons: match.negativeReasons,
            disqualifiers: match.disqualifiers,
            breakdown: match.breakdown,
            score: match.score,
            tier: match.tier,
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const errText = await res.text();
          console.error("[match-summary] API error:", res.status, errText);
          throw new Error(errText);
        }
        const data = await res.json();
        if (cancelled) return;
        setSummary(data.summary ?? initialSummary);
      } catch (err) {
        console.error("[match-summary] Fetch failed:", err);
        if (!cancelled) {
          setSummaryError(true);
          setSummary(generateMatchSummary(rfp, match));
        }
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    }

    fetchSummary();
    return () => {
      cancelled = true;
    };
  }, [rfpData?.id, profile]);

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
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (cancelled) return;
        setRequirementsSummary(data.summary ?? rfp.description);
      } catch (err) {
        console.error("[rfp-requirements-summary] Fetch failed:", err);
        if (!cancelled) {
          setRequirementsSummaryError(true);
          setRequirementsSummary(null);
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
                workCities: profile.workCities,
                workCounties: profile.workCounties,
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
    try {
      const res = await fetch("/api/generate-proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...proposalPayload(),
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
          workCities: profile.workCities,
          workCounties: profile.workCounties,
          capabilities: profile.capabilities,
          agencyExperience: profile.agencyExperience,
          contractTypes: profile.contractTypes,
        }
      : null,
  });

  const handleGeneratePlanOfExecution = async (feedbackText?: string) => {
    if (!rfpData || planLoading) return;
    const trimmed = String(feedbackText ?? "").trim();
    setPlanLoading(true);
    setPlanError(null);
    if (!trimmed) setPlanOfExecution(null);
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
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : "Failed to generate plan"
      );
    } finally {
      setPlanLoading(false);
    }
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
          href="/dashboard"
          className="text-[#2563eb] hover:underline font-medium"
        >
          ← Back to Dashboard
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
            href="/dashboard"
            className="text-slate-600 hover:text-slate-900 text-sm font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Dashboard
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <article className="rounded-2xl overflow-hidden bg-white shadow-sm border border-slate-200">
          {/* Header */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <h1 className="text-2xl font-bold text-slate-900 mb-4">{rfp.title}</h1>
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
              {rfp.match.disqualified ? (
                <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold bg-red-100 text-red-700">
                  <span className="mr-1">✗</span> Not Eligible
                </span>
              ) : (
                <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold ${
                  rfp.match.tier === "excellent" ? "bg-emerald-500 text-white" :
                  rfp.match.tier === "strong" ? "bg-blue-500 text-white" :
                  rfp.match.tier === "moderate" ? "bg-amber-400 text-amber-900" :
                  "bg-slate-200 text-slate-600"
                }`}>
                  {rfp.match.tier === "excellent" && <span className="mr-1">★</span>}
                  {rfp.match.score}% · {rfp.match.tier.charAt(0).toUpperCase() + rfp.match.tier.slice(1)}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600">{rfp.agency} · Due {rfp.deadline} · {rfp.estimatedValue}</p>
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
              <div className="flex items-start justify-between gap-2 mb-3">
                <h2 className="text-sm font-bold text-slate-900">
                  {rfp.match.disqualified ? "Match Analysis" : "Why this is a good match"}
                </h2>
                {summaryLoading ? (
                  <span className="text-xs text-slate-400 animate-pulse">AI summarizing…</span>
                ) : (
                  <svg className={`w-5 h-5 ${rfp.match.disqualified ? "text-red-400" : "text-blue-500"} shrink-0`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>
              <p className="text-slate-700 leading-relaxed">{displaySummary}</p>
              {summaryError && (
                <p className="mt-2 text-xs text-amber-600">
                  AI summary unavailable. Showing rule-based summary.
                </p>
              )}
            </div>
          </div>

          {/* Score Breakdown */}
          {rfp.match.breakdown.length > 0 && !rfp.match.disqualified && (
            <div className="p-6 md:p-8 border-b border-slate-100">
              <h2 className="text-sm font-bold text-slate-900 mb-3">Score Breakdown</h2>
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

                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-700">{b.category}</span>
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
                  );
                })}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="p-6 md:p-8 border-b border-slate-100 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 mb-4">Actions</h2>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => handleGenerateProposal()}
                disabled={proposalLoading}
                className="inline-flex items-center justify-center gap-2 min-w-[240px] px-6 py-3 rounded-lg text-sm font-semibold bg-[#2563eb] text-white hover:bg-[#1d4ed8] transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {proposalLoading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
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
                className="inline-flex items-center justify-center gap-2 min-w-[260px] px-6 py-3 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {planLoading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
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
            </div>
            {proposalError && (
              <p className="mt-3 text-sm text-red-600">{proposalError}</p>
            )}
            {planError && (
              <p className="mt-3 text-sm text-red-600">{planError}</p>
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

          {/* About this RFP - AI summary of contract requirements */}
          <div className="p-6 md:p-8 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900 mb-3">About this RFP</h2>
            {requirementsSummaryLoading ? (
              <p className="text-slate-500 text-sm animate-pulse">Summarizing contract requirements…</p>
            ) : requirementsSummary ? (
              <MarkdownContent content={requirementsSummary} />
            ) : (
              <p className="text-slate-700 leading-relaxed">{rfp.description}</p>
            )}
            {requirementsSummaryError && (
              <p className="mt-2 text-xs text-amber-600">AI summary unavailable. Showing original description.</p>
            )}
          </div>

          {/* Details & link */}
          <div className="p-6 md:p-8">
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
            {rfp.eventUrl && (
              <a
                href={rfp.eventUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-[#2563eb] hover:underline"
              >
                View on Cal eProcure
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            )}
          </div>
        </article>
      </main>
    </div>
  );
}
