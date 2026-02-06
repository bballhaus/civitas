"use client";

import { useState, useEffect } from "react";
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

interface MockRFP {
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
}

const MOCK_RFPS: MockRFP[] = [
  { id: "1", title: "Cybersecurity Infrastructure Modernization", agency: "California Department of Technology", location: "Sacramento, CA", deadline: "2025-03-15", estimatedValue: "$2.4M", industry: "IT Services", naicsCodes: ["541512", "541690"], capabilities: ["Cybersecurity", "Cloud Services", "Network Infrastructure"], certifications: ["FedRAMP", "ISO 27001"], contractType: "Fixed Price", description: "Modernization of statewide cybersecurity infrastructure including cloud migration and threat detection systems." },
  { id: "2", title: "Healthcare Data Analytics Platform", agency: "California Department of Health Care Services", location: "Sacramento, CA", deadline: "2025-04-01", estimatedValue: "$1.8M", industry: "Healthcare", naicsCodes: ["541511", "541519"], capabilities: ["Data Analytics", "Software Development", "Cloud Services"], certifications: ["HIPAA Compliance", "SOC 2"], contractType: "Time & Materials", description: "Development of a comprehensive data analytics platform for healthcare service delivery metrics." },
  { id: "3", title: "Transportation Management System", agency: "California Department of Transportation", location: "Sacramento, CA", deadline: "2025-03-28", estimatedValue: "$3.1M", industry: "IT Services", naicsCodes: ["541511", "541512"], capabilities: ["Software Development", "System Integration", "Database Management"], certifications: ["ISO 9001"], contractType: "IDIQ (Indefinite Delivery)", description: "Integrated transportation management system for traffic monitoring and incident response." },
  { id: "4", title: "Construction Project Management Services", agency: "California Department of General Services", location: "Sacramento, CA", deadline: "2025-05-10", estimatedValue: "$950K", industry: "Construction", naicsCodes: ["236220"], capabilities: ["Project Management"], certifications: [], contractType: "Competitive", description: "Project management oversight for state facility construction and renovation projects." },
  { id: "5", title: "Cloud Migration and DevOps Support", agency: "City of San Francisco", location: "San Francisco, CA", deadline: "2025-04-15", estimatedValue: "$1.2M", industry: "IT Services", naicsCodes: ["541511", "541512"], capabilities: ["Cloud Services", "DevOps", "System Integration"], certifications: ["GSA Schedule", "FedRAMP"], contractType: "BPA (Blanket Purchase Agreement)", description: "Cloud migration services and ongoing DevOps support for city enterprise applications." },
  { id: "6", title: "AI/ML Research and Development", agency: "State of California", location: "Sacramento, CA", deadline: "2025-06-01", estimatedValue: "$4.2M", industry: "Research & Development", naicsCodes: ["541519", "541611"], capabilities: ["AI/ML Services", "Data Analytics", "Software Development"], certifications: ["CMMI"], contractType: "Cost Plus", description: "Research and development of AI/ML solutions for state government operations." },
  { id: "7", title: "Small Business IT Support Services", agency: "City of Los Angeles", location: "Los Angeles, CA", deadline: "2025-04-20", estimatedValue: "$680K", industry: "IT Services", naicsCodes: ["541512", "541519"], capabilities: ["Technical Writing", "Training & Support", "Software Development"], certifications: [], contractType: "Small Business Set-Aside", description: "IT support and training services for city department staff." },
  { id: "8", title: "Emergency Response System Upgrade", agency: "County of Los Angeles", location: "Los Angeles, CA", deadline: "2025-03-30", estimatedValue: "$1.5M", industry: "IT Services", naicsCodes: ["541511"], capabilities: ["Software Development", "System Integration", "Cybersecurity"], certifications: ["NIST 800-53"], contractType: "Fixed Price", description: "Upgrade of county emergency response and 911 dispatch systems." },
  { id: "9", title: "Consulting Services for Education Technology", agency: "California Department of Education", location: "Sacramento, CA", deadline: "2025-05-25", estimatedValue: "$520K", industry: "Education", naicsCodes: ["541611"], capabilities: ["Consulting", "Training & Support"], certifications: [], contractType: "Sole Source", description: "Strategic consulting for statewide education technology initiatives." },
  { id: "10", title: "Logistics and Supply Chain Optimization", agency: "California Department of Forestry", location: "Sacramento, CA", deadline: "2025-04-08", estimatedValue: "$890K", industry: "Logistics", naicsCodes: ["541690"], capabilities: ["Data Analytics", "Project Management"], certifications: ["ISO 9001"], contractType: "Competitive", description: "Supply chain optimization and logistics planning for wildfire response operations." },
];

interface RFPMatch {
  score: number;
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
}

type RFPWithMatch = MockRFP & { match: RFPMatch };

function computeMatch(rfp: MockRFP, profile: CompanyProfile | null): RFPMatch {
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  let score = 50;

  if (!profile) {
    return { score: 50, reasons: ["Complete your profile for personalized match scores"], positiveReasons: [], negativeReasons: [] };
  }

  const profileIndustry = (profile.industry ?? []).map((i) => i.toLowerCase());
  const profileNaics = profile.naicsCodes ?? [];
  const profileCaps = (profile.capabilities ?? []).map((c) => c.toLowerCase());
  const profileCerts = (profile.certifications ?? []).map((c) => c.toLowerCase());
  const profileContractTypes = (profile.contractTypes ?? []).map((t) => t.toLowerCase());
  const profileAgencies = (profile.agencyExperience ?? []).map((a) => a.toLowerCase());
  const profileCities = (profile.workCities ?? []).map((c) => c.toLowerCase());
  const profileCounties = (profile.workCounties ?? []).map((c) => c.toLowerCase());

  if (profileIndustry.includes(rfp.industry.toLowerCase())) {
    score += 15;
    positiveReasons.push(`Matches your ${rfp.industry} industry`);
  } else {
    negativeReasons.push(`Industry (${rfp.industry}) not in your profile`);
  }

  const naicsOverlap = rfp.naicsCodes.filter((n) => profileNaics.includes(n));
  if (naicsOverlap.length > 0) {
    score += 12;
    positiveReasons.push(`NAICS ${naicsOverlap.join(", ")} aligns with your experience`);
  } else {
    negativeReasons.push(`No NAICS overlap`);
  }

  const capOverlap = rfp.capabilities.filter((c) => {
    const cLower = c.toLowerCase();
    return profileCaps.some((p) => p.includes(cLower) || cLower.includes(p));
  });
  if (capOverlap.length >= 2) {
    score += 15;
    positiveReasons.push(`Strong capability match: ${capOverlap.slice(0, 2).join(", ")}`);
  } else if (capOverlap.length === 1) {
    score += 8;
    positiveReasons.push(`Capability match: ${capOverlap[0]}`);
  } else {
    negativeReasons.push(`Limited capability overlap`);
  }

  const certOverlap = rfp.certifications.filter((c) =>
    profileCerts.some((p) => p.includes(c.toLowerCase()) || c.toLowerCase().includes(p))
  );
  if (certOverlap.length > 0) {
    score += 10;
    positiveReasons.push(`You have ${certOverlap.join(", ")}`);
  } else if (rfp.certifications.length > 0) {
    negativeReasons.push(`RFP requires certifications you may not have`);
  }

  if (profileContractTypes.some((t) => rfp.contractType.toLowerCase().includes(t))) {
    score += 5;
    positiveReasons.push(`Contract type matches your preferences`);
  }

  if (profileAgencies.some((a) => rfp.agency.toLowerCase().includes(a))) {
    score += 8;
    positiveReasons.push(`You have experience with this agency`);
  }

  const locationMatch = profileCities.some((c) => rfp.location.toLowerCase().includes(c)) ||
    profileCounties.some((c) => rfp.location.toLowerCase().includes(c));
  if (locationMatch) {
    score += 5;
    positiveReasons.push(`Location aligns with your service area`);
  }

  const reasons = [...positiveReasons.map((r) => `✓ ${r}`), ...negativeReasons.map((r) => `✗ ${r}`)];

  return {
    score: Math.min(98, Math.max(12, score)),
    reasons,
    positiveReasons,
    negativeReasons,
  };
}

function generateMatchSummary(_rfp: MockRFP, match: RFPMatch): string {
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

  const rfpsWithMatch: RFPWithMatch[] = MOCK_RFPS.map((rfp) => ({
    ...rfp,
    match: computeMatch(rfp, profile),
  }));
  rfpsWithMatch.sort((a, b) => b.match.score - a.match.score);

  const displayName = profile?.companyName?.trim() || "there";
  const matchCount = rfpsWithMatch.length;
  const selectedId = selectedRfpId ?? rfpsWithMatch[0]?.id ?? null;
  const selectedRfp = rfpsWithMatch.find((r) => r.id === selectedId);

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10 shadow-sm">
        <div className="max-w-full mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="Civitas logo" className="h-10 w-10" />
            <span className="text-xl font-bold text-slate-900">Civitas</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/profile" className="text-slate-600 hover:text-slate-900 text-sm font-medium">
              Profile
            </Link>
            <Link href="/upload" className="text-slate-600 hover:text-slate-900 text-sm font-medium">
              Upload
            </Link>
          </div>
        </div>
      </nav>

      {/* Split view */}
      <div className="flex flex-col lg:flex-row h-[calc(100vh-65px)]">
        {/* Left: RFP list */}
        <aside className="w-full lg:w-[440px] shrink-0 flex flex-col border-r border-slate-200 bg-[#fafafa] overflow-hidden">
          <div className="p-6 border-b border-slate-200 bg-white">
            <h1 className="text-lg font-bold text-slate-800 mb-4">
              Hi{displayName !== "there" ? ` ${displayName}` : " there"}! You have{" "}
              <span className="text-[#2563eb]">{matchCount}</span> matches to review.
            </h1>
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
            {rfpsWithMatch.map((rfp) => {
              const { match } = rfp;
              const isSelected = rfp.id === selectedId;
              const isHighMatch = match.score >= 75;

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
                      {rfp.capabilities[0] || "Contract"}
                    </span>
                    {isHighMatch && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-600">
                        <span className="text-emerald-500">✓</span> High Match
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <MatchBadge score={match.score} />
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right: RFP detail */}
        <main className="flex-1 min-w-0 overflow-y-auto bg-[#f5f5f5]">
          {selectedRfp ? (
            <RFPDetailPanel rfp={selectedRfp} generateSummary={generateMatchSummary} MatchBadge={MatchBadge} />
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
}: {
  rfp: RFPWithMatch;
  generateSummary: (rfp: MockRFP, match: RFPMatch) => string;
  MatchBadge: ({ score }: { score: number }) => JSX.Element;
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
            <div className="flex items-center gap-3 shrink-0">
              <button type="button" className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                Save
              </button>
              <button type="button" className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1.5">
                Not Interested
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#2563eb] text-white text-sm font-semibold hover:bg-[#1d4ed8] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Express Interest
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
              {rfp.capabilities[0] || rfp.contractType}
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
            <Link href="#" className="text-sm font-medium text-[#2563eb] hover:underline flex items-center gap-1">
              View Agency
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </Link>
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
            {rfp.naicsCodes.map((n) => (
              <span key={n} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-600">
                NAICS {n}
              </span>
            ))}
            {rfp.capabilities.map((c) => (
              <span key={c} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-600">
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
