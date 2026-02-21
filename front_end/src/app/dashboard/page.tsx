"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

// Filter options - same as profile-setup page
const FILTER_OPTIONS = {
  industry: [
    "Construction", "Consulting", "Education", "Engineering", "Healthcare",
    "IT Services", "Logistics", "Manufacturing", "Research & Development", "Security",
  ],
  certifications: [
    "CMMI", "FedRAMP", "GSA Schedule", "HIPAA Compliance", "ISO 27001", "ISO 9001",
    "ITAR", "NAICS Codes", "NIST 800-53", "PCI DSS", "SOC 2",
  ],
  clearances: ["Public Trust", "Secret", "Top Secret", "TS/SCI"],
  naicsCodes: ["236220", "541330", "541511", "541512", "541519", "541611", "541690"],
  workCities: [
    "Anaheim", "Bakersfield", "Fresno", "Long Beach", "Los Angeles", "Oakland",
    "Sacramento", "San Diego", "San Francisco", "San Jose",
  ],
  workCounties: [
    "Alameda", "Contra Costa", "Fresno", "Los Angeles", "Orange", "Riverside",
    "Sacramento", "San Bernardino", "San Diego", "San Francisco", "San Mateo",
    "Santa Clara", "Ventura",
  ],
  agencies: [
    "California Dept of Forestry", "California Department of General Services",
    "California Department of Transportation", "City of Los Angeles",
    "City of Sacramento", "City of San Francisco", "County of Inyo", "State of California",
  ],
  contractValueRanges: ["Under $100K", "$100K–$500K", "$500K–$1M", "$1M–$5M", "$5M+", "TBD/Unknown"],
  capabilities: [
    "AI/ML Services", "Cloud Services", "Cybersecurity", "Data Analytics", "Database Management",
    "DevOps", "Mobile Development", "Network Infrastructure", "Project Management",
    "Quality Assurance", "Software Development", "System Integration", "Technical Writing",
    "Training & Support", "Web Development",
  ],
  contractTypes: [
    "BPA (Blanket Purchase Agreement)", "Competitive", "Cost Plus", "Fixed Price",
    "GSA Schedule", "IDIQ (Indefinite Delivery)", "Multi-year", "Small Business Set-Aside",
    "Sole Source", "Time & Materials",
  ],
  sizeStatus: [
    "8(a) Business", "HUBZone", "Large Business", "Service-Disabled Veteran-Owned (SDVOSB)",
    "Small Business", "Small Disadvantaged Business (SDB)", "Veteran-Owned Small Business (VOSB)",
    "Women-Owned Small Business (WOSB)",
  ],
  deadlineStatus: ["Still open", "Deadline passed", "Unknown/TBD"],
} as const;

interface RFPFilters {
  industry: string[];
  certifications: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  agencies: string[];
  contractValueRanges: string[];
  capabilities: string[];
  contractTypes: string[];
  sizeStatus: string[];
  deadlineStatus: string[];
}

const EMPTY_FILTERS: RFPFilters = {
  industry: [],
  certifications: [],
  clearances: [],
  naicsCodes: [],
  workCities: [],
  workCounties: [],
  agencies: [],
  contractValueRanges: [],
  capabilities: [],
  contractTypes: [],
  sizeStatus: [],
  deadlineStatus: [],
};

// Primary filters (top 4 most-used) - shown as individual buttons
const PRIMARY_FILTERS: { key: keyof RFPFilters; label: string }[] = [
  { key: "industry", label: "Industry" },
  { key: "agencies", label: "Agencies" },
  { key: "contractValueRanges", label: "Value" },
  { key: "capabilities", label: "Services" },
];

// Secondary filters - inside "More filters" dropdown
const SECONDARY_FILTERS: { key: keyof RFPFilters; label: string }[] = [
  { key: "contractTypes", label: "Contract type" },
  { key: "deadlineStatus", label: "Deadline" },
  { key: "sizeStatus", label: "Size" },
  { key: "workCities", label: "Cities" },
  { key: "workCounties", label: "Counties" },
  { key: "certifications", label: "Certifications" },
  { key: "clearances", label: "Clearances" },
  { key: "naicsCodes", label: "NAICS" },
];

const FILTER_OPTIONS_MAP: Record<keyof RFPFilters, readonly string[]> = {
  industry: FILTER_OPTIONS.industry,
  agencies: FILTER_OPTIONS.agencies,
  contractValueRanges: FILTER_OPTIONS.contractValueRanges,
  capabilities: FILTER_OPTIONS.capabilities,
  workCities: FILTER_OPTIONS.workCities,
  workCounties: FILTER_OPTIONS.workCounties,
  contractTypes: FILTER_OPTIONS.contractTypes,
  sizeStatus: FILTER_OPTIONS.sizeStatus,
  certifications: FILTER_OPTIONS.certifications,
  clearances: FILTER_OPTIONS.clearances,
  naicsCodes: FILTER_OPTIONS.naicsCodes,
  deadlineStatus: FILTER_OPTIONS.deadlineStatus,
};

function deriveFilterOptionsFromRfps(rfps: RFP[]): Record<keyof RFPFilters, string[]> {
  const merge = (staticList: readonly string[], dynamic: string[]) => {
    const set = new Set([...staticList, ...dynamic.map((s) => s.trim()).filter(Boolean)]);
    return [...set].sort();
  };
  const locations = rfps.flatMap((r) =>
    (r.location || "")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2)
  );
  return {
    industry: merge(FILTER_OPTIONS.industry, rfps.map((r) => r.industry || "").filter(Boolean)),
    agencies: merge(FILTER_OPTIONS.agencies, rfps.map((r) => r.agency || "").filter(Boolean)),
    contractValueRanges: [...FILTER_OPTIONS.contractValueRanges],
    capabilities: merge(FILTER_OPTIONS.capabilities, rfps.flatMap((r) => r.capabilities || [])),
    workCities: merge(FILTER_OPTIONS.workCities, locations),
    workCounties: merge(FILTER_OPTIONS.workCounties, locations),
    contractTypes: merge(FILTER_OPTIONS.contractTypes, rfps.map((r) => r.contractType || "").filter(Boolean)),
    sizeStatus: [...FILTER_OPTIONS.sizeStatus],
    certifications: merge(FILTER_OPTIONS.certifications, rfps.flatMap((r) => r.certifications || [])),
    clearances: [...FILTER_OPTIONS.clearances],
    naicsCodes: merge(
      FILTER_OPTIONS.naicsCodes,
      rfps.flatMap((r) => (r.naicsCodes || []).map(String))
    ),
    deadlineStatus: [...FILTER_OPTIONS.deadlineStatus],
  };
}

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

function getDeadlineStatus(deadline: string): "Still open" | "Deadline passed" | "Unknown/TBD" {
  const due = parseDeadline(deadline);
  if (!due) return "Unknown/TBD";
  return new Date() > due ? "Deadline passed" : "Still open";
}

function getContractValueRange(estimatedValue: string): string {
  const v = (estimatedValue || "").trim();
  if (!v || v.toUpperCase() === "TBD") return "TBD/Unknown";
  const cleaned = v.replace(/[$,\s]/g, "").toLowerCase();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|m)?/);
  if (!match) return "TBD/Unknown";
  let num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "k") num *= 1000;
  else if (suffix === "m") num *= 1000000;
  if (num < 100000) return "Under $100K";
  if (num < 500000) return "$100K–$500K";
  if (num < 1000000) return "$500K–$1M";
  if (num < 5000000) return "$1M–$5M";
  return "$5M+";
}

function getContractValueNumeric(estimatedValue: string): number {
  const v = (estimatedValue || "").trim();
  if (!v || v.toUpperCase() === "TBD") return 0;
  const cleaned = v.replace(/[$,\s]/g, "").toLowerCase();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|m)?/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "k") num *= 1000;
  else if (suffix === "m") num *= 1000000;
  return num;
}

function rfpMatchesSearch(rfp: RFP, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const searchable = [
    rfp.title,
    rfp.agency,
    rfp.industry,
    rfp.location,
    rfp.contractType,
    rfp.description,
    (rfp.capabilities || []).join(" "),
    (rfp.certifications || []).join(" "),
  ].join(" ").toLowerCase();
  return searchable.includes(q);
}

function rfpMatchesFilters(rfp: RFP, f: RFPFilters): boolean {
  const loc = (rfp.location || "").toLowerCase();
  const desc = ((rfp.description || "") + " " + (rfp.title || "")).toLowerCase();

  if (f.industry.length > 0 && !f.industry.some((i) => (rfp.industry || "").toLowerCase() === i.toLowerCase() || (rfp.industry || "").toLowerCase().includes(i.toLowerCase()))) return false;
  if (f.sizeStatus.length > 0 && !f.sizeStatus.some((s) => desc.includes(s.toLowerCase().replace(/[()]/g, "")) || desc.includes(s.toLowerCase()))) return false;
  if (f.certifications.length > 0) {
    const rfpCerts = (rfp.certifications || []).map((c) => c.toLowerCase());
    if (!f.certifications.some((c) => rfpCerts.some((rc) => rc.includes(c.toLowerCase()) || c.toLowerCase().includes(rc)))) return false;
  }
  if (f.clearances.length > 0 && !f.clearances.some((c) => desc.includes(c.toLowerCase()))) return false;
  if (f.naicsCodes.length > 0) {
    const rfpNaics = (rfp.naicsCodes || []).map((n) => n.trim());
    if (!f.naicsCodes.some((n) => rfpNaics.some((rn) => rn === n || rn.startsWith(n) || n.startsWith(rn)))) return false;
  }
  if (f.workCities.length > 0 && !f.workCities.some((c) => loc.includes(c.toLowerCase()))) return false;
  if (f.workCounties.length > 0 && !f.workCounties.some((c) => loc.includes(c.toLowerCase()))) return false;
  if (f.agencies.length > 0) {
    const rfpAgency = (rfp.agency || "").toLowerCase();
    if (!f.agencies.some((a) => {
      const filterAgency = a.toLowerCase();
      return rfpAgency.includes(filterAgency) || filterAgency.includes(rfpAgency);
    })) return false;
  }
  if (f.contractValueRanges.length > 0) {
    const range = getContractValueRange(rfp.estimatedValue);
    if (!f.contractValueRanges.includes(range)) return false;
  }
  if (f.capabilities.length > 0) {
    const rfpCaps = (rfp.capabilities || []).map((c) => c.toLowerCase());
    if (!f.capabilities.some((c) => rfpCaps.some((rc) => rc.includes(c.toLowerCase()) || c.toLowerCase().includes(rc)))) return false;
  }
  if (f.contractTypes.length > 0 && !f.contractTypes.some((t) => (rfp.contractType || "").toLowerCase().includes(t.toLowerCase()))) return false;
  if (f.deadlineStatus.length > 0) {
    const status = getDeadlineStatus(rfp.deadline);
    if (!f.deadlineStatus.includes(status)) return false;
  }
  return true;
}

function countActiveFilters(f: RFPFilters): number {
  return (
    f.industry.length + f.certifications.length + f.clearances.length + f.naicsCodes.length +
    f.workCities.length + f.workCounties.length + f.agencies.length + f.contractValueRanges.length +
    f.capabilities.length + f.contractTypes.length + f.sizeStatus.length + f.deadlineStatus.length
  );
}

function countSecondaryFilters(f: RFPFilters): number {
  return SECONDARY_FILTERS.reduce((sum, { key }) => sum + f[key].length, 0);
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
  score = Math.round(score);

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

const SEARCHABLE_FILTER_THRESHOLD = 8;

function FilterDropdown({
  keyName,
  label,
  options,
  filters,
  onFiltersChange,
  onClose,
  containerRef,
}: {
  keyName: keyof RFPFilters;
  label: string;
  options: readonly string[];
  filters: RFPFilters;
  onFiltersChange: (f: RFPFilters) => void;
  onClose: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef?.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose, containerRef]);

  const toggle = (value: string) => {
    const arr = filters[keyName];
    const next = arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
    onFiltersChange({ ...filters, [keyName]: next });
  };

  const searchLower = search.trim().toLowerCase();
  const selected = filters[keyName];
  const filteredOptions = searchLower
    ? options.filter((o) => o.toLowerCase().includes(searchLower))
    : options;
  const showOptions = options.length >= SEARCHABLE_FILTER_THRESHOLD
    ? [...new Set([...selected.filter((s) => options.includes(s)), ...filteredOptions])]
    : options;
  const hasSearch = options.length >= SEARCHABLE_FILTER_THRESHOLD;

  return (
    <div
      className="absolute left-0 top-full mt-1 z-[100] w-[240px] max-h-72 overflow-y-auto overscroll-contain bg-white border border-slate-200 rounded-lg shadow-xl"
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 bg-white border-b border-slate-200 px-3 py-2 flex flex-col gap-2 z-10">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-800">Filter by {label}</span>
          {filters[keyName].length > 0 && (
            <button
              type="button"
              onClick={() => onFiltersChange({ ...filters, [keyName]: [] })}
              className="text-xs text-[#2563eb] hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {hasSearch && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type to filter..."
            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2563eb] focus:border-[#2563eb] placeholder:text-slate-400"
          />
        )}
      </div>
      <div className="p-2 max-h-52 overflow-y-auto space-y-0.5">
        {showOptions.length > 0 ? (
          showOptions.map((opt) => (
            <label key={opt} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-2 py-1.5">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="w-3.5 h-3.5 text-[#2563eb] border-slate-300 rounded shrink-0"
              />
              <span className="text-xs text-slate-700 truncate">{opt}</span>
            </label>
          ))
        ) : (
          <p className="text-xs text-slate-500 italic py-2 px-2">No matches</p>
        )}
      </div>
    </div>
  );
}

function SearchableFilterSection({
  label,
  keyName,
  options,
  filters,
  onToggle,
}: {
  label: string;
  keyName: keyof RFPFilters;
  options: readonly string[];
  filters: RFPFilters;
  onToggle: (keyName: keyof RFPFilters, value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();
  const selected = filters[keyName];
  const filteredOptions = searchLower
    ? options.filter((o) => o.toLowerCase().includes(searchLower))
    : options;
  const showOptions = [...new Set([...selected.filter((s) => options.includes(s)), ...filteredOptions])];

  return (
    <div className="border-b border-slate-100 last:border-0 pb-3 last:pb-0">
      <p className="text-xs font-semibold text-slate-600 mb-1.5">{label}</p>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Type to filter..."
        className="w-full px-2.5 py-1.5 mb-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2563eb] focus:border-[#2563eb] placeholder:text-slate-400"
      />
      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {showOptions.length > 0 ? (
          showOptions.map((opt) => (
            <label key={opt} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-2 py-1">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => onToggle(keyName, opt)}
                className="w-3.5 h-3.5 text-[#2563eb] border-slate-300 rounded shrink-0"
              />
              <span className="text-xs text-slate-700 truncate">{opt}</span>
            </label>
          ))
        ) : (
          <p className="text-xs text-slate-500 italic py-2 px-2">No matches</p>
        )}
      </div>
    </div>
  );
}

function MoreFiltersDropdown({
  filterOptions,
  filters,
  onFiltersChange,
  onClose,
  containerRef,
}: {
  filterOptions: Record<keyof RFPFilters, string[]>;
  filters: RFPFilters;
  onFiltersChange: (f: RFPFilters) => void;
  onClose: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef?.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose, containerRef]);

  const toggle = (keyName: keyof RFPFilters, value: string) => {
    const arr = filters[keyName];
    const next = arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
    onFiltersChange({ ...filters, [keyName]: next });
  };

  const secondaryCount = countSecondaryFilters(filters);

  return (
    <div
      className="absolute left-0 top-full mt-1 z-[100] w-[340px] max-h-[75vh] overflow-y-auto overscroll-contain bg-white border border-slate-200 rounded-lg shadow-xl"
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 bg-white border-b border-slate-200 px-3 py-2 flex items-center justify-between z-10">
        <span className="text-sm font-semibold text-slate-800">More filters</span>
        {secondaryCount > 0 && (
          <button
            type="button"
            onClick={() => {
              const cleared = { ...filters };
              SECONDARY_FILTERS.forEach(({ key }) => { cleared[key] = []; });
              onFiltersChange(cleared);
            }}
            className="text-xs text-[#2563eb] hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <div className="p-3 flex flex-col gap-3">
        {SECONDARY_FILTERS.map(({ key, label }) => {
          const options = filterOptions[key];
          return (
            <SearchableFilterSection
              key={key}
              label={label}
              keyName={key}
              options={options}
              filters={filters}
              onToggle={toggle}
            />
          );
        })}
      </div>
    </div>
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
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});

  const handleSummaryReady = useCallback((rfpId: string, summary: string) => {
    setSummaryCache((prev) => ({ ...prev, [rfpId]: summary }));
  }, []);

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
  const [filters, setFilters] = useState<RFPFilters>(EMPTY_FILTERS);
  const [openFilterKey, setOpenFilterKey] = useState<keyof RFPFilters | "more" | null>(null);
  const [minScore, setMinScore] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"score" | "deadline" | "value">("score");
  const filtersContainerRef = useRef<HTMLDivElement>(null);
  const scrollLockYRef = useRef(0);

  useEffect(() => {
    if (openFilterKey) {
      scrollLockYRef.current = window.scrollY;
      const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollLockYRef.current}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.width = "100%";
      if (scrollBarWidth > 0) {
        document.body.style.paddingRight = `${scrollBarWidth}px`;
      }
      return () => {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        document.body.style.paddingRight = "";
        window.scrollTo(0, scrollLockYRef.current);
      };
    }
  }, [openFilterKey]);

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

  const baseDisplayedRfps = listFilter === "saved"
    ? rfpsWithMatch.filter((r) => savedRfpIds.has(r.id))
    : rfpsWithMatch;
  let displayedRfps = countActiveFilters(filters) > 0
    ? baseDisplayedRfps.filter((r) => rfpMatchesFilters(r, filters))
    : baseDisplayedRfps;
  displayedRfps = displayedRfps.filter((r) => rfpMatchesSearch(r, searchQuery));
  if (minScore != null) {
    displayedRfps = displayedRfps.filter((r) => r.match.score >= minScore);
  }
  displayedRfps = [...displayedRfps].sort((a, b) => {
    if (sortBy === "score") return b.match.score - a.match.score;
    if (sortBy === "deadline") {
      const dueA = parseDeadline(a.deadline)?.getTime() ?? Infinity;
      const dueB = parseDeadline(b.deadline)?.getTime() ?? Infinity;
      return dueA - dueB;
    }
    if (sortBy === "value") {
      const valA = getContractValueNumeric(a.estimatedValue);
      const valB = getContractValueNumeric(b.estimatedValue);
      return valB - valA;
    }
    return 0;
  });

  const dynamicFilterOptions = React.useMemo(
    () => deriveFilterOptionsFromRfps(rfpsWithMatch),
    [rfpsWithMatch]
  );

  const displayName = profile?.companyName?.trim() || "there";
  const matchCount = displayedRfps.length;
  const selectedId =
    (selectedRfpId && displayedRfps.some((r) => r.id === selectedRfpId))
      ? selectedRfpId
      : displayedRfps[0]?.id ?? null;
  const selectedRfp = displayedRfps.find((r) => r.id === selectedId);

  useEffect(() => {
    if (selectedRfpId && !displayedRfps.some((r) => r.id === selectedRfpId)) {
      setSelectedRfpId(displayedRfps[0]?.id ?? null);
    }
  }, [displayedRfps, selectedRfpId]);

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
        <aside className="w-full lg:w-[440px] shrink-0 flex flex-col border-r border-slate-200 bg-[#fafafa] overflow-visible">
          <div className="p-6 border-b border-slate-200 bg-white">
            <h1 className="text-lg font-bold text-slate-800 mb-3">
              Hi{displayName !== "there" ? ` ${displayName}` : " there"}! You have{" "}
              <span className="text-[#2563eb]">{matchCount}</span> {listFilter === "saved" ? "saved" : ""} match{matchCount !== 1 ? "es" : ""} to review.
            </h1>
            <div className="mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search RFPs by title, agency, location..."
                className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563eb] focus:border-transparent placeholder:text-slate-600"
              />
            </div>
            <div className="flex flex-wrap gap-2 mb-2 items-center">
              <span className="text-xs font-medium text-slate-500 shrink-0">Min score:</span>
              {([null, 25, 55, 75] as const).map((s) => (
                <button
                  key={s ?? "all"}
                  type="button"
                  onClick={() => setMinScore(s)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    minScore === s ? "bg-[#2563eb] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {s == null ? "All" : `${s}%+`}
                </button>
              ))}
              <span className="text-xs font-medium text-slate-700 shrink-0 ml-1">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "score" | "deadline" | "value")}
                className="px-2.5 py-1 text-xs text-slate-800 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
              >
                <option value="score">Best match</option>
                <option value="deadline">Soonest deadline</option>
                <option value="value">Highest value</option>
              </select>
            </div>
            <div ref={filtersContainerRef} className="flex flex-wrap gap-2 mb-3 items-center">
              <span className="text-xs font-medium text-slate-500 mr-1 shrink-0">Filter by:</span>
              {PRIMARY_FILTERS.map(({ key, label }) => {
                const count = filters[key].length;
                const isOpen = openFilterKey === key;
                return (
                  <div key={key} className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenFilterKey((prev) => (prev === key ? null : key))}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                        count > 0
                          ? "bg-[#2563eb] text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {label}
                      {count > 0 && (
                        <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                          {count}
                        </span>
                      )}
                      <svg
                        className={`w-3.5 h-3.5 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      <FilterDropdown
                        keyName={key}
                        label={label}
                        options={dynamicFilterOptions[key]}
                        filters={filters}
                        onFiltersChange={setFilters}
                        onClose={() => setOpenFilterKey(null)}
                        containerRef={filtersContainerRef}
                      />
                    )}
                  </div>
                );
              })}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setOpenFilterKey((prev) => (prev === "more" ? null : "more"))}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                    countSecondaryFilters(filters) > 0
                      ? "bg-[#2563eb] text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  More filters
                  {countSecondaryFilters(filters) > 0 && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                      {countSecondaryFilters(filters)}
                    </span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 shrink-0 transition-transform ${openFilterKey === "more" ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openFilterKey === "more" && (
                  <MoreFiltersDropdown
                    filterOptions={dynamicFilterOptions}
                    filters={filters}
                    onFiltersChange={setFilters}
                    onClose={() => setOpenFilterKey(null)}
                    containerRef={filtersContainerRef}
                  />
                )}
              </div>
              {countActiveFilters(filters) > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:underline shrink-0"
                >
                  Clear all
                </button>
              )}
              <div className="flex items-center gap-2 border-l border-slate-200 pl-2 ml-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setListFilter("all")}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    listFilter === "all" && countActiveFilters(filters) === 0
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
          <div
            className={`flex-1 min-h-0 p-3 space-y-3 ${openFilterKey ? "overflow-hidden" : "overflow-y-auto"}`}
          >
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
        <main
          className={`flex-1 min-w-0 bg-[#f5f5f5] relative ${openFilterKey ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {toast && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium shadow-lg">
              {toast}
            </div>
          )}
          {selectedRfp ? (
            <RFPDetailPanel
              rfp={selectedRfp}
              profile={profile}
              generateSummary={generateMatchSummary}
              MatchBadge={MatchBadge}
              isSaved={savedRfpIds.has(selectedRfp.id)}
              hasExpressedInterest={expressedInterestRfpIds.has(selectedRfp.id)}
              onSave={() => handleSaveRfp(selectedRfp.id)}
              onNotInterested={() => handleNotInterested(selectedRfp.id)}
              onExpressInterest={() => handleExpressInterest(selectedRfp.id)}
              cachedSummary={summaryCache[selectedRfp.id]}
              onSummaryReady={handleSummaryReady}
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
  profile,
  generateSummary,
  MatchBadge,
  isSaved,
  hasExpressedInterest,
  onSave,
  onNotInterested,
  onExpressInterest,
  cachedSummary,
  onSummaryReady,
}: {
  rfp: RFPWithMatch;
  profile: CompanyProfile | null;
  generateSummary: (rfp: RFP, match: RFPMatch) => string;
  MatchBadge: React.ComponentType<{ score: number }>;
  isSaved: boolean;
  hasExpressedInterest: boolean;
  onSave: () => void;
  onNotInterested: () => void;
  onExpressInterest: () => void;
  cachedSummary?: string;
  onSummaryReady: (rfpId: string, summary: string) => void;
}) {
  const { match } = rfp;
  const isHighMatch = match.score >= 75;
  const initialSummary = generateSummary(rfp, match);
  const [llmSummary, setLlmSummary] = useState<string | null>(cachedSummary ?? null);
  const [summaryError, setSummaryError] = useState(false);

  useEffect(() => {
    if (cachedSummary) {
      setLlmSummary(cachedSummary);
      setSummaryError(false);
      return;
    }

    setLlmSummary(null);
    setSummaryError(false);
    let cancelled = false;

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
            profile: profile ? {
              companyName: profile.companyName,
              industry: profile.industry,
              capabilities: profile.capabilities,
              certifications: profile.certifications,
              workCities: profile.workCities,
              workCounties: profile.workCounties,
              agencyExperience: profile.agencyExperience,
              contractTypes: profile.contractTypes,
            } : null,
            currentSummary: initialSummary,
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
        const summary = data.summary ?? initialSummary;
        setLlmSummary(summary);
        onSummaryReady(rfp.id, summary);
      } catch (err) {
        console.error("[match-summary] Fetch failed:", err);
        if (!cancelled) setSummaryError(true);
      }
    }

    fetchSummary();
    return () => { cancelled = true; };
  }, [rfp.id, rfp.title, rfp.agency, rfp.industry, rfp.location, rfp.deadline, rfp.capabilities, rfp.certifications, rfp.contractType, rfp.description, profile, initialSummary, cachedSummary, onSummaryReady]);

  const summary = llmSummary ?? initialSummary;
  const isLoadingSummary = llmSummary === null && !summaryError;

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
              {isLoadingSummary ? (
                <span className="text-xs text-slate-400 animate-pulse">AI summarizing…</span>
              ) : (
                <svg className="w-5 h-5 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
            </div>
            <p className="text-slate-700 leading-relaxed">{summary}</p>
            {summaryError && (
              <p className="mt-2 text-xs text-amber-600">AI summary unavailable (check console). Using rule-based summary.</p>
            )}
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
