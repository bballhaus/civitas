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

  const rfpsWithMatch = MOCK_RFPS.map((rfp) => ({
    ...rfp,
    match: computeMatch(rfp, profile),
  }));
  rfpsWithMatch.sort((a, b) => b.match.score - a.match.score);

  const displayName = profile?.companyName?.trim() || "there";
  const matchCount = rfpsWithMatch.length;

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="Civitas logo" className="h-12 w-12" />
            <span className="text-2xl font-bold text-slate-900">Civitas</span>
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

      <div className="max-w-6xl mx-auto px-6 py-10">
        {/* For You header - RippleMatch style */}
        <div className="mb-10">
          <p className="text-sm font-semibold text-[#3C89C6] uppercase tracking-wider mb-1">For You</p>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Hi{displayName !== "there" ? ` ${displayName}` : " there"}! You have{" "}
            <span className="text-[#3C89C6]">{matchCount}</span> matches to review.
          </h1>
          <p className="text-slate-600">RFPs tailored to your profile. High-match opportunities are highlighted.</p>
        </div>

        <div className="space-y-5">
          {rfpsWithMatch.map((rfp) => {
            const { match } = rfp;
            const isHighMatch = match.score >= 75;
            const summary = generateMatchSummary(rfp, match);

            return (
              <article
                key={rfp.id}
                className={`rounded-xl border-2 overflow-hidden bg-white transition-all hover:shadow-lg ${
                  isHighMatch ? "border-emerald-400 shadow-emerald-50" : "border-slate-200"
                }`}
              >
                <div className={`p-6 ${isHighMatch ? "bg-gradient-to-r from-emerald-50 to-white" : ""}`}>
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-xl font-bold text-slate-900">{rfp.title}</h2>
                        <MatchBadge score={match.score} />
                        {isHighMatch && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500 text-white">
                            Great fit
                          </span>
                        )}
                      </div>
                      <p className="text-slate-600 font-medium">{rfp.agency}</p>
                    </div>
                  </div>

                  {/* Short bullet points - key info */}
                  <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 mb-4">
                    <li className="flex items-center gap-1.5">
                      <span className="text-slate-400">•</span>
                      Due {rfp.deadline}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="text-slate-400">•</span>
                      {rfp.estimatedValue}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="text-slate-400">•</span>
                      {rfp.contractType}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="text-slate-400">•</span>
                      {rfp.location}
                    </li>
                  </ul>

                  {/* Tags */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700">
                      {rfp.industry}
                    </span>
                    {rfp.naicsCodes.slice(0, 2).map((n) => (
                      <span key={n} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600">
                        NAICS {n}
                      </span>
                    ))}
                    {rfp.capabilities.slice(0, 3).map((c) => (
                      <span key={c} className="px-2.5 py-1 rounded-md text-xs font-medium bg-[#3C89C6]/10 text-[#3C89C6]">
                        {c}
                      </span>
                    ))}
                  </div>

                  {/* AI-generated readable summary */}
                  <div className="rounded-lg bg-slate-50 border border-slate-100 p-4">
                    <p className="text-sm text-slate-700 leading-relaxed">{summary}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
