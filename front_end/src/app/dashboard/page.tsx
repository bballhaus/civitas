"use client";

import React, { useState, useEffect, useCallback, useRef, useDeferredValue, useLayoutEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CALIFORNIA_CITIES,
  CALIFORNIA_COUNTIES,
  NAICS_CODES,
  NAICS_DISPLAY,
  NAICS_MAP,
} from "@/data/filter-options";

// Filter options - cities, counties, NAICS from real data; others static
import { MarkdownContent } from "@/components/MarkdownContent";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import {
  getCurrentUser,
  getCachedUser,
  getCachedProfile,
  setCachedProfile,
  setCachedUser,
  clearCachedUser,
  mapBackendProfileToCompanyProfile,
  getEmptyCompanyProfile,
  updateUserRfpStatus,
  getGeneratedPoe,
} from "@/lib/api";
import { getCachedEvents, setCachedEvents, clearCachedEvents } from "@/lib/events-cache";
import {
  type RFP as RFPType,
  type RFPMatch as RFPMatchType,
  type CompanyProfile as CompanyProfileType,
  type ScoreBreakdown,
  computeMatch as computeMatchLib,
  generateMatchSummary as generateMatchSummaryLib,
  parseDeadline as parseDeadlineLib,
} from "@/lib/rfp-matching";

// Normalize a localStorage profile (snake_case) to CompanyProfile (camelCase)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeLocalProfile(raw: any): CompanyProfile {
  return {
    companyName: raw.companyName ?? raw.company_name ?? "",
    industry: raw.industry ?? raw.industry_tags ?? [],
    sizeStatus: raw.sizeStatus ?? (raw.size_status ? [raw.size_status] : []),
    certifications: raw.certifications ?? [],
    clearances: raw.clearances ?? [],
    naicsCodes: raw.naicsCodes ?? raw.naics_codes ?? [],
    workCities: raw.workCities ?? raw.work_cities ?? [],
    workCounties: raw.workCounties ?? raw.work_counties ?? [],
    capabilities: raw.capabilities ?? [],
    agencyExperience: raw.agencyExperience ?? raw.agency_experience ?? [],
    contractTypes: raw.contractTypes ?? raw.contract_types ?? [],
    contractCount: raw.contractCount ?? raw.contract_count ?? 0,
    totalPastContractValue: raw.totalPastContractValue ?? String(raw.total_contract_value ?? "0"),
    pastContracts: raw.pastContracts ?? raw.past_contracts ?? [],
  };
}

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
  naicsCodes: NAICS_CODES,
  workCities: CALIFORNIA_CITIES,
  workCounties: CALIFORNIA_COUNTIES,
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

// Secondary filters - inside Filter panel
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

// All filter sections for the single Filter panel (collapsible, start minimized)
const ALL_FILTER_SECTIONS: { key: keyof RFPFilters; label: string }[] = [
  ...PRIMARY_FILTERS,
  ...SECONDARY_FILTERS,
];

type SortByField = "score" | "deadline" | "value";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { sortBy: SortByField; direction: SortDir; label: string }[] = [
  { sortBy: "score", direction: "desc", label: "Best match first" },
  { sortBy: "score", direction: "asc", label: "Lowest match first" },
  { sortBy: "deadline", direction: "asc", label: "Soonest deadline first" },
  { sortBy: "deadline", direction: "desc", label: "Latest deadline first" },
  { sortBy: "value", direction: "desc", label: "Highest value first" },
  { sortBy: "value", direction: "asc", label: "Lowest value first" },
];

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
  const rfpNaicsCodes = rfps.flatMap((r) => (r.naicsCodes || []).map(String).map((c) => c.trim()).filter(Boolean));
  const allNaicsCodes = merge(FILTER_OPTIONS.naicsCodes, rfpNaicsCodes);
  const naicsDisplay = allNaicsCodes.map((code) => (NAICS_MAP[code] ? `${code} - ${NAICS_MAP[code]}` : code));
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
    naicsCodes: naicsDisplay,
    deadlineStatus: [...FILTER_OPTIONS.deadlineStatus],
  };
}

// Use the shared types from rfp-matching.ts
type CompanyProfile = CompanyProfileType;
type RFP = RFPType;
type RFPMatch = RFPMatchType;
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

// Use parseDeadline from rfp-matching.ts
const parseDeadline = parseDeadlineLib;

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

// Use shared matching functions from rfp-matching.ts
const computeMatch = computeMatchLib;
const generateMatchSummary = generateMatchSummaryLib;

function MatchBadge({ score, tier, disqualified, size = "sm" }: { score: number; tier?: RFPMatch["tier"]; disqualified?: boolean; size?: "sm" | "lg" }) {
  const isLarge = size === "lg";
  const pillClass = isLarge ? "px-3.5 py-1.5 rounded-full text-base font-bold" : "px-2.5 py-1 rounded-full text-sm font-bold";

  if (disqualified) {
    return (
      <span className={`inline-flex items-center ${pillClass} bg-red-100 text-red-700`}>
        <span className="mr-1">✗</span>
        Not Eligible
      </span>
    );
  }

  const t = tier ?? (score >= 75 ? "excellent" : score >= 55 ? "strong" : score >= 35 ? "moderate" : "low");

  const styles = {
    excellent: "bg-emerald-500 text-white",
    strong: "bg-blue-500 text-white",
    moderate: "bg-amber-400 text-amber-900",
    low: "bg-orange-100 text-orange-800",
    disqualified: "bg-red-100 text-red-700",
  };

  const labels = {
    excellent: "Excellent",
    strong: "Strong",
    moderate: "Moderate",
    low: "Low",
    disqualified: "Not Eligible",
  };

  return (
    <span className={`inline-flex items-center ${pillClass} ${styles[t]}`}>
      {t === "excellent" && <span className="mr-1">★</span>}
      {score}% · {labels[t]}
    </span>
  );
}

const MATCH_SCORE_OPTIONS = [
  { value: null as number | null, label: "All matches" },
  { value: 75, label: "Excellent fit (75%+)" },
  { value: 50, label: "Strong fit (50–75%)" },
  { value: 25, label: "Worth a look (25–50%)" },
] as const;

const SEARCHABLE_FILTER_KEYS: (keyof RFPFilters)[] = ["workCities", "workCounties", "naicsCodes"];

function getFilterValue(key: keyof RFPFilters, opt: string): string {
  if (key === "naicsCodes" && opt.includes(" - ")) return opt.split(" - ")[0].trim();
  return opt;
}

function FilterPanel({
  filterOptions,
  filters,
  onFiltersChange,
  onClose,
  expandedSections,
  onToggleSection,
  itemCount,
  minScore,
  onMinScoreChange,
}: {
  filterOptions: Record<keyof RFPFilters, string[]>;
  filters: RFPFilters;
  onFiltersChange: (f: RFPFilters) => void;
  onClose: () => void;
  expandedSections: Set<keyof RFPFilters>;
  onToggleSection: (key: keyof RFPFilters) => void;
  itemCount: number;
  minScore: number | null;
  onMinScoreChange: (v: number | null) => void;
}) {
  const [matchExpanded, setMatchExpanded] = useState(false);
  const [sectionSearch, setSectionSearch] = useState<Partial<Record<keyof RFPFilters, string>>>({});

  const toggle = (keyName: keyof RFPFilters, value: string) => {
    const arr = filters[keyName];
    const next = arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
    onFiltersChange({ ...filters, [keyName]: next });
  };

  const handleClear = () => {
    onFiltersChange(EMPTY_FILTERS);
    onMinScoreChange(null);
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/20 md:bg-transparent md:relative md:inset-auto"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-[min(100vw-2rem,22rem)] min-w-[18rem] max-h-[85vh] flex flex-col bg-white border border-slate-200 rounded-lg shadow-xl md:absolute md:left-0 md:top-full md:mt-1 md:w-[22rem] md:min-w-[22rem] md:max-h-[75vh]"
        onWheel={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 shrink-0">
          <span className="text-sm font-semibold text-slate-800">Filter</span>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close filter"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-2">
          {/* Match score section */}
          <div className="border-b border-slate-100">
            <button
              type="button"
              onClick={() => setMatchExpanded((e) => !e)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-50 rounded"
            >
              <span>Match</span>
              <span className="text-slate-400 text-lg leading-none select-none">{matchExpanded ? "−" : "+"}</span>
            </button>
            {matchExpanded && (
              <div className="px-2 pb-2 pt-0 max-h-52 overflow-y-auto space-y-0.5">
                {MATCH_SCORE_OPTIONS.map(({ value, label }) => (
                  <label key={value ?? "all"} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={minScore === value}
                      onChange={() => onMinScoreChange(value)}
                      className="w-3.5 h-3.5 text-[#2563eb] border-slate-300 rounded shrink-0"
                    />
                    <span className="text-xs text-slate-700 truncate">{label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {ALL_FILTER_SECTIONS.map(({ key, label }) => {
            const isExpanded = expandedSections.has(key);
            const options = filterOptions[key] || [];
            const selected = filters[key] || [];
            return (
              <div key={key} className="border-b border-slate-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => onToggleSection(key)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-50 rounded"
                >
                  <span>{label}</span>
                  <span className="text-slate-400 text-lg leading-none select-none">{isExpanded ? "−" : "+"}</span>
                </button>
                {isExpanded && (
                  <div className="px-2 pb-2 pt-0">
                    {SEARCHABLE_FILTER_KEYS.includes(key) && (
                      <input
                        type="text"
                        value={sectionSearch[key] ?? ""}
                        onChange={(e) => setSectionSearch((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder={`Search ${label.toLowerCase()}...`}
                        className="w-full px-2.5 py-1.5 mb-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2563eb] focus:border-[#2563eb] placeholder:text-slate-400"
                      />
                    )}
                    <div className="max-h-52 overflow-y-auto space-y-0.5">
                      {(() => {
                        const q = (sectionSearch[key] ?? "").trim().toLowerCase();
                        const filtered = q
                          ? options.filter((o) => o.toLowerCase().includes(q))
                          : options;
                        const showOptions = [...new Set([...selected.filter((s) => options.some((o) => getFilterValue(key, o) === s)), ...filtered])];
                        const getVal = (opt: string) => getFilterValue(key, opt);
                        return showOptions.length > 0 ? (
                          showOptions.map((opt) => (
                            <label key={opt} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-2 py-1.5">
                              <input
                                type="checkbox"
                                checked={selected.includes(getVal(opt))}
                                onChange={() => toggle(key, getVal(opt))}
                                className="w-3.5 h-3.5 text-[#2563eb] border-slate-300 rounded shrink-0"
                              />
                              <span className="text-xs text-slate-700 truncate">{opt}</span>
                            </label>
                          ))
                        ) : (
                          <p className="text-xs text-slate-500 italic py-2 px-2">No matches</p>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex gap-2 p-3 border-t border-slate-200 shrink-0">
          <button
            type="button"
            onClick={handleClear}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-white bg-[#2563eb] hover:bg-[#1d4ed8] transition-colors"
          >
            View {itemCount} item{itemCount !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function SortByDropdown({
  sortBy,
  sortDirection,
  onSortChange,
  isOpen,
  onClose,
  onToggle,
  containerRef,
}: {
  sortBy: SortByField;
  sortDirection: SortDir;
  onSortChange: (sortBy: SortByField, direction: SortDir) => void;
  isOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
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

  const current = SORT_OPTIONS.find((o) => o.sortBy === sortBy && o.direction === sortDirection);
  const buttonLabel = current?.label ?? "Sort by";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center justify-between gap-2 min-w-0 max-w-[14rem] px-3 py-2 text-sm text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#2563eb] focus:border-[#2563eb]"
      >
        <span className="truncate">{buttonLabel}</span>
        <svg className="w-4 h-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full mt-1 z-[100] w-full min-w-[14rem] py-1 bg-white border border-slate-200 rounded-md shadow-lg">
          {SORT_OPTIONS.map((option) => {
            const isSelected = sortBy === option.sortBy && sortDirection === option.direction;
            return (
              <button
                key={`${option.sortBy}-${option.direction}`}
                type="button"
                onClick={() => {
                  onSortChange(option.sortBy, option.direction);
                  onClose();
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                  isSelected ? "bg-slate-50 text-slate-900 font-medium" : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                {isSelected ? (
                  <span className="text-[#2563eb]" aria-hidden>✓</span>
                ) : (
                  <span className="w-4" aria-hidden />
                )}
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const pathname = usePathname();
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [currentUser, setCurrentUser] = useState<{ user_id: number; username: string } | null>(null);
  const [selectedRfpId, setSelectedRfpId] = useState<string | null>(null);
  const [rfps, setRfps] = useState<RFP[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileLoadDone, setProfileLoadDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRfpIds, setSavedRfpIds] = useState<Set<string>>(new Set());
  const [notInterestedRfpIds, setNotInterestedRfpIds] = useState<Set<string>>(new Set());
  const [expressedInterestRfpIds, setExpressedInterestRfpIds] = useState<Set<string>>(new Set());
  const [appliedRfpIds, setAppliedRfpIds] = useState<Set<string>>(new Set());
  const [inProgressRfpIds, setInProgressRfpIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});

  // Load RFP lists from localStorage after mount to avoid hydration mismatch (server has no localStorage)
  useEffect(() => {
    setSavedRfpIds(loadSet(STORAGE_KEYS.SAVED));
    setNotInterestedRfpIds(loadSet(STORAGE_KEYS.NOT_INTERESTED));
    setExpressedInterestRfpIds(loadSet(STORAGE_KEYS.EXPRESSED_INTEREST));
  }, []);

  // Keep saved/not-interested/expressed in sync with current RFP list so we don't show counts for stale IDs
  const currentRfpIds = React.useMemo(
    () => (rfps.length > 0 ? new Set(rfps.map((r) => r.id)) : null),
    [rfps]
  );
  useEffect(() => {
    if (!currentRfpIds || currentRfpIds.size === 0) return;
    const saved = loadSet(STORAGE_KEYS.SAVED);
    const notInt = loadSet(STORAGE_KEYS.NOT_INTERESTED);
    const expressed = loadSet(STORAGE_KEYS.EXPRESSED_INTEREST);
    const savedFiltered = new Set([...saved].filter((id) => currentRfpIds.has(id)));
    const notIntFiltered = new Set([...notInt].filter((id) => currentRfpIds.has(id)));
    const expressedFiltered = new Set([...expressed].filter((id) => currentRfpIds.has(id)));
    if (
      savedFiltered.size !== saved.size ||
      notIntFiltered.size !== notInt.size ||
      expressedFiltered.size !== expressed.size
    ) {
      saveSet(STORAGE_KEYS.SAVED, savedFiltered);
      saveSet(STORAGE_KEYS.NOT_INTERESTED, notIntFiltered);
      saveSet(STORAGE_KEYS.EXPRESSED_INTEREST, expressedFiltered);
      setSavedRfpIds(savedFiltered);
      setNotInterestedRfpIds(notIntFiltered);
      setExpressedInterestRfpIds(expressedFiltered);
    }
  }, [currentRfpIds]);

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
      if (next.has(rfpId)) {
        next.delete(rfpId);
        showToast("Interest removed");
      } else {
        next.add(rfpId);
        showToast("Interest expressed — we'll use this to improve your matches");
      }
      saveSet(STORAGE_KEYS.EXPRESSED_INTEREST, next);
      return next;
    });
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

  const handleToggleApplied = useCallback(async (rfpId: string) => {
    const currentlyApplied = appliedRfpIds.has(rfpId);
    const currentlyInProgress = inProgressRfpIds.has(rfpId);
    setAppliedRfpIds((prev) => {
      const next = new Set(prev);
      if (currentlyApplied) next.delete(rfpId);
      else next.add(rfpId);
      return next;
    });
    if (!currentlyApplied && currentlyInProgress) {
      setInProgressRfpIds((prev) => {
        const next = new Set(prev);
        next.delete(rfpId);
        return next;
      });
    }
    if (currentlyApplied) {
      setInProgressRfpIds((prev) => new Set([...prev, rfpId]));
    }
    try {
      if (currentlyApplied) {
        await updateUserRfpStatus({ remove_applied: rfpId, mark_in_progress: rfpId });
        showToast("Removed from applied");
      } else {
        await updateUserRfpStatus({
          mark_applied: rfpId,
          ...(currentlyInProgress ? { remove_in_progress: rfpId } : {}),
        });
        showToast("Marked as applied");
      }
    } catch (e) {
      setAppliedRfpIds((prev) => {
        const next = new Set(prev);
        if (currentlyApplied) next.add(rfpId);
        else next.delete(rfpId);
        return next;
      });
      if (!currentlyApplied && currentlyInProgress) {
        setInProgressRfpIds((prev) => new Set([...prev, rfpId]));
      }
      if (currentlyApplied) {
        setInProgressRfpIds((prev) => {
          const next = new Set(prev);
          next.delete(rfpId);
          return next;
        });
      }
      console.error("Failed to update applied status:", e);
      showToast(e instanceof Error ? e.message : "Failed to update — try again");
    }
  }, [appliedRfpIds, inProgressRfpIds]);

  const handleMarkInProgress = useCallback(async (rfpId: string) => {
    try {
      await updateUserRfpStatus({ mark_in_progress: rfpId });
      setInProgressRfpIds((prev) => new Set([...prev, rfpId]));
    } catch (e) {
      console.error("Failed to mark RFP in progress:", e);
    }
  }, []);

  const [showNotInterestedList, setShowNotInterestedList] = useState(false);
  const [listFilter, setListFilter] = useState<"all" | "saved">("all");
  const [filters, setFilters] = useState<RFPFilters>(EMPTY_FILTERS);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [expandedFilterSections, setExpandedFilterSections] = useState<Set<keyof RFPFilters>>(new Set());
  const [minScore, setMinScore] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [sortBy, setSortBy] = useState<"score" | "deadline" | "value">("score");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const filtersContainerRef = useRef<HTMLDivElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const scrollLockYRef = useRef(0);

  const toggleFilterSection = (key: keyof RFPFilters) => {
    setExpandedFilterSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resetBodyScrollLock = useCallback(() => {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    document.body.style.paddingRight = "";
  }, []);

  // When pathname changes away from dashboard (e.g. user navigated), close filter and reset body
  useEffect(() => {
    if (pathname && !pathname.startsWith("/dashboard")) {
      setFilterPanelOpen(false);
      resetBodyScrollLock();
    }
  }, [pathname, resetBodyScrollLock]);

  useLayoutEffect(() => {
    if (filterPanelOpen) {
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
        resetBodyScrollLock();
        window.scrollTo(0, scrollLockYRef.current);
      };
    }
  }, [filterPanelOpen, resetBodyScrollLock]);

  // Ensure body scroll lock is always cleared on unmount
  useLayoutEffect(() => {
    return resetBodyScrollLock;
  }, [resetBodyScrollLock]);

  // Instant load when we have full cache (no network); otherwise load user + profile, then events.
  useEffect(() => {
    let cancelled = false;
    const cachedUser = getCachedUser();
    const cachedProfile = cachedUser ? getCachedProfile(cachedUser.user_id) : null;
    const events = getCachedEvents();
    const hasEvents = events && events.length > 0;
    if (cachedUser && cachedProfile && hasEvents) {
      setCurrentUser(cachedUser);
      setProfile(cachedProfile);
      setRfps(events ?? []);
      setProfileLoadDone(true);
      setLoading(false);
      getCurrentUser(false).then((data) => {
        if (cancelled) return;
        if (!data) {
          clearCachedUser();
          clearCachedEvents();
          setCurrentUser(null);
          setProfile(null);
        } else {
          setCachedUser(data);
        }
      });
      getCurrentUser(true).then((full) => {
        if (cancelled || !full) return;
        setAppliedRfpIds(new Set(full.applied_rfp_ids ?? []));
        setInProgressRfpIds(new Set(full.in_progress_rfp_ids ?? []));
      });
      return () => { cancelled = true; };
    }
    // Single API call: getCurrentUser(true) returns user + profile + applied ids
    getCurrentUser(true)
      .then((full) => {
        if (cancelled) return;
        if (full) {
          setCurrentUser({ user_id: full.user_id, username: full.username });
          setCachedUser(full);
          const cached = getCachedProfile(full.user_id);
          const apiProfile = mapBackendProfileToCompanyProfile(full.profile ?? null);
          const mapped = cached ?? apiProfile ?? getEmptyCompanyProfile();
          setProfile(mapped);
          if (apiProfile) setCachedProfile(full.user_id, apiProfile);
          setAppliedRfpIds(new Set(full.applied_rfp_ids ?? []));
          setInProgressRfpIds(new Set(full.in_progress_rfp_ids ?? []));
          setProfileLoadDone(true);
        } else {
        setCurrentUser(null);
        const saved = localStorage.getItem("companyProfile");
        const extracted = localStorage.getItem("extractedProfileData");
        if (saved) {
          try {
            setProfile(normalizeLocalProfile(JSON.parse(saved)));
          } catch {
            // ignore
          }
        }
        if (extracted) {
          try {
            setProfile(normalizeLocalProfile(JSON.parse(extracted)));
          } catch {
            // ignore
          }
        }
        setProfileLoadDone(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Backend unreachable (e.g. CORS on localhost) — fall back to localStorage
        setCurrentUser(null);
        const saved = localStorage.getItem("companyProfile");
        const extracted = localStorage.getItem("extractedProfileData");
        if (saved) {
          try { setProfile(normalizeLocalProfile(JSON.parse(saved))); } catch { /* ignore */ }
        }
        if (extracted) {
          try { setProfile(normalizeLocalProfile(JSON.parse(extracted))); } catch { /* ignore */ }
        }
        setProfileLoadDone(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function fetchEvents() {
      const cached = getCachedEvents();
      if (cached && cached.length > 0) {
        setRfps(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await fetch("/api/events", { signal: controller.signal });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const events = data.events ?? [];
        setRfps(events);
        if (events.length > 0) setCachedEvents(events);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load events");
        if (!cached?.length) setRfps(FALLBACK_RFPS);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    fetchEvents();
    return () => { controller.abort(); };
  }, []);

  const allRfpsWithMatch = React.useMemo(() => {
    const effectiveProfile = profile ?? getEmptyCompanyProfile();
    const list: RFPWithMatch[] = (rfps.length > 0 ? rfps : FALLBACK_RFPS).map((rfp) => ({
      ...rfp,
      match: computeMatch(rfp, effectiveProfile),
    }));
    return [...list].sort((a, b) => b.match.score - a.match.score);
  }, [rfps, profile]);

  const { rfpsWithMatch, hiddenRfps, hiddenCount, displayedRfps } = React.useMemo(() => {
    const rfpsWithMatch = allRfpsWithMatch.filter((r) => !notInterestedRfpIds.has(r.id));
    const hiddenRfps = allRfpsWithMatch.filter((r) => notInterestedRfpIds.has(r.id));
    const hiddenCount = hiddenRfps.length;
    const baseDisplayedRfps = listFilter === "saved"
      ? rfpsWithMatch.filter((r) => savedRfpIds.has(r.id))
      : rfpsWithMatch;
    let displayed = countActiveFilters(filters) > 0
      ? baseDisplayedRfps.filter((r) => rfpMatchesFilters(r, filters))
      : baseDisplayedRfps;
    displayed = displayed.filter((r) => rfpMatchesSearch(r, searchQuery));
    if (minScore != null) {
      displayed = displayed.filter((r) => r.match.score >= minScore);
    }
    displayed = [...displayed].sort((a, b) => {
      let cmp = 0;
      if (sortBy === "score") {
        cmp = a.match.score - b.match.score;
      } else if (sortBy === "deadline") {
        const dueA = parseDeadline(a.deadline)?.getTime() ?? Infinity;
        const dueB = parseDeadline(b.deadline)?.getTime() ?? Infinity;
        cmp = dueA - dueB;
      } else if (sortBy === "value") {
        const valA = getContractValueNumeric(a.estimatedValue);
        const valB = getContractValueNumeric(b.estimatedValue);
        cmp = valA - valB;
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });
    return { rfpsWithMatch, hiddenRfps, hiddenCount, displayedRfps: displayed };
  }, [allRfpsWithMatch, notInterestedRfpIds, listFilter, savedRfpIds, filters, deferredSearchQuery, minScore, sortBy, sortDirection]);

  const dynamicFilterOptions = React.useMemo(
    () => deriveFilterOptionsFromRfps(rfpsWithMatch),
    [rfpsWithMatch]
  );

  const displayName = profile?.companyName?.trim() || currentUser?.username || "there";
  const matchCount = displayedRfps.length;
  const selectedId =
    (selectedRfpId && displayedRfps.some((r) => r.id === selectedRfpId))
      ? selectedRfpId
      : displayedRfps[0]?.id ?? null;
  const selectedRfp = displayedRfps.find((r) => r.id === selectedId);
  // Defer heavy panel content so card selection (border) updates immediately
  const deferredSelectedRfp = useDeferredValue(selectedRfp ?? null);

  useEffect(() => {
    if (selectedRfpId && !displayedRfps.some((r) => r.id === selectedRfpId)) {
      setSelectedRfpId(displayedRfps[0]?.id ?? null);
    }
  }, [displayedRfps, selectedRfpId]);

  // Show list as soon as events are ready; profile loads in background (matches update when it arrives).
  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#2563eb]" />
          <p className="text-slate-600 font-medium">Loading matches…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      {/* Split view */}
      <div className="relative z-[1] flex flex-col lg:flex-row h-[calc(100vh-65px)]">
        {/* Left: RFP list */}
        <aside className="w-full lg:w-[440px] shrink-0 flex flex-col border-r border-slate-200 bg-[#fafafa] overflow-visible">
          <div ref={filtersContainerRef} className="p-4 border-b border-slate-200 bg-white space-y-3">
            <h1 className="text-base font-bold text-slate-800">
              Hi{displayName !== "there" ? ` ${displayName}` : " there"}!{" "}
              <span className="text-[#2563eb]">{matchCount}</span> {listFilter === "saved" ? "saved" : ""} match{matchCount !== 1 ? "es" : ""} to review.
            </h1>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search RFPs by title, agency, location..."
              className="w-full px-3 py-2 text-sm text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563eb] focus:border-transparent placeholder:text-slate-500"
            />
            <div className="flex flex-nowrap items-center gap-2">
              <SortByDropdown
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSortChange={(by, dir) => {
                  setSortBy(by);
                  setSortDirection(dir);
                }}
                isOpen={sortDropdownOpen}
                onClose={() => setSortDropdownOpen(false)}
                onToggle={() => setSortDropdownOpen((prev) => !prev)}
                containerRef={sortDropdownRef}
              />
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setFilterPanelOpen((prev) => !prev)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                    countActiveFilters(filters) > 0 || minScore != null
                      ? "bg-[#2563eb] text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  Filter
                  {(countActiveFilters(filters) > 0 || minScore != null) && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-white/20 text-xs font-bold">
                      {countActiveFilters(filters) + (minScore != null ? 1 : 0)}
                    </span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 shrink-0 transition-transform ${filterPanelOpen ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {filterPanelOpen && (
                  <FilterPanel
                    filterOptions={dynamicFilterOptions}
                    filters={filters}
                    onFiltersChange={setFilters}
                    onClose={() => setFilterPanelOpen(false)}
                    expandedSections={expandedFilterSections}
                    onToggleSection={toggleFilterSection}
                    itemCount={displayedRfps.length}
                    minScore={minScore}
                    onMinScoreChange={setMinScore}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => setListFilter(listFilter === "saved" ? "all" : "saved")}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
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
          <div
            className={`flex-1 min-h-0 p-3 space-y-3 ${filterPanelOpen ? "overflow-hidden" : "overflow-y-auto"}`}
          >
            {error ? (
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
              const isSaved = savedRfpIds.has(rfp.id);
              const isApplied = appliedRfpIds.has(rfp.id);
              const isInProgress = inProgressRfpIds.has(rfp.id);
              const reasonSnippet = generateMatchSummary(rfp, match);

              return (
                <div
                  key={rfp.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedRfpId(rfp.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedRfpId(rfp.id); } }}
                  className={`block w-full text-left p-4 rounded-xl bg-white border-2 transition-all shadow-sm hover:shadow-md cursor-pointer ${
                    match.disqualified ? "opacity-60 " : ""
                  }${isSelected ? "border-[#2563eb] shadow-md" : "border-transparent hover:border-slate-200"}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-800 mb-0.5">{rfp.agency}</p>
                      <p className="text-xs text-slate-500 mb-1">{rfp.industry}</p>
                      <h2 className="text-sm font-bold text-[#2563eb] line-clamp-2">{rfp.title}</h2>
                    </div>
                    <div className="shrink-0">
                      <MatchBadge score={match.score} tier={match.tier} disqualified={match.disqualified} />
                    </div>
                  </div>
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
                    {match.tier === "excellent" && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-600">
                        <span className="text-emerald-500">★</span> Excellent Match
                      </span>
                    )}
                    {match.tier === "strong" && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700">
                        Strong Match
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
                    {isApplied && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-600">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Applied
                      </span>
                    )}
                    
                  </div>
                  {reasonSnippet && (
                    <p className="text-xs text-slate-500 mt-2 line-clamp-2">
                      {reasonSnippet}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right: RFP detail */}
        <main
          className={`flex-1 min-w-0 bg-transparent relative ${filterPanelOpen ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {toast && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium shadow-lg">
              {toast}
            </div>
          )}
          {selectedRfp && selectedRfp.id !== deferredSelectedRfp?.id ? (
            <div className="p-6 flex flex-col items-center justify-center min-h-[200px] text-slate-500">
              <p className="font-semibold text-slate-700 truncate max-w-full text-center">{selectedRfp.title}</p>
              <p className="mt-2 text-sm">Loading…</p>
            </div>
          ) : deferredSelectedRfp ? (
            <RFPDetailPanel
              rfp={deferredSelectedRfp}
              profile={profile}
              generateSummary={generateMatchSummary}
              MatchBadge={MatchBadge}
              isSaved={savedRfpIds.has(deferredSelectedRfp.id)}
              onSave={() => handleSaveRfp(deferredSelectedRfp.id)}
              isApplied={appliedRfpIds.has(deferredSelectedRfp.id)}
              onToggleApplied={() => handleToggleApplied(deferredSelectedRfp.id)}
              isInProgress={inProgressRfpIds.has(deferredSelectedRfp.id)}
              cachedSummary={summaryCache[deferredSelectedRfp.id]}
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
  onSave,
  isApplied,
  onToggleApplied,
  isInProgress,
  cachedSummary,
  onSummaryReady,
}: {
  rfp: RFPWithMatch;
  profile: CompanyProfile | null;
  generateSummary: (rfp: RFP, match: RFPMatch) => string;
  MatchBadge: React.ComponentType<{ score: number; tier?: RFPMatch["tier"]; disqualified?: boolean; size?: "sm" | "lg" }>;
  isSaved: boolean;
  onSave: () => void;
  isApplied: boolean;
  onToggleApplied: () => void;
  isInProgress: boolean;
  cachedSummary?: string;
  onSummaryReady: (rfpId: string, summary: string) => void;
}) {
  const { match } = rfp;
  const isHighMatch = match.tier === "excellent" || match.tier === "strong";
  const initialSummary = generateSummary(rfp, match);
  const [llmSummary, setLlmSummary] = useState<string | null>(cachedSummary ?? null);
  const [summaryError, setSummaryError] = useState(false);
  const [requirementsSummary, setRequirementsSummary] = useState<string | null>(null);
  const [requirementsSummaryLoading, setRequirementsSummaryLoading] = useState(false);
  const [expandedBreakdownCategory, setExpandedBreakdownCategory] = useState<string | null>(null);
  const [requirementsSummaryError, setRequirementsSummaryError] = useState(false);
  const [capabilitiesAnalysis, setCapabilitiesAnalysis] = useState<string | null>(null);
  const [capabilitiesAnalysisLoading, setCapabilitiesAnalysisLoading] = useState(false);
  const [capabilitiesAnalysisError, setCapabilitiesAnalysisError] = useState(false);
  const [planOfExecution, setPlanOfExecution] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planFeedback, setPlanFeedback] = useState("");
  const [poeDropdownOpen, setPoeDropdownOpen] = useState(false);

  useEffect(() => {
    if (!rfp.id) return;
    getGeneratedPoe(rfp.id).then((saved) => {
      if (saved) setPlanOfExecution(saved);
    });
  }, [rfp.id]);

  const planPayload = () => ({
    rfp: {
      title: rfp.title,
      agency: rfp.agency,
      industry: rfp.industry,
      location: rfp.location,
      deadline: rfp.deadline,
      estimatedValue: rfp.estimatedValue,
      capabilities: rfp.capabilities,
      certifications: rfp.certifications,
      contractType: rfp.contractType,
      description: rfp.description,
      naicsCodes: (rfp as any).naicsCodes,
      eventUrl: rfp.eventUrl,
      contactName: (rfp as any).contactName,
      contactEmail: (rfp as any).contactEmail,
      contactPhone: (rfp as any).contactPhone,
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

  const handleGeneratePlanOfExecution = useCallback(async (feedbackText?: string) => {
    if (planLoading) return;
    const trimmed = String(feedbackText ?? "").trim();
    setPlanLoading(true);
    setPlanError(null);
    if (!trimmed) setPlanOfExecution(null);
    updateUserRfpStatus({ mark_in_progress: rfp.id }).catch(() => {});
    try {
      const res = await fetch("/api/generate-plan-of-execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planPayload(),
          ...(trimmed && { currentPlan: planOfExecution, feedback: trimmed }),
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
      setPlanError(err instanceof Error ? err.message : "Failed to generate plan");
    } finally {
      setPlanLoading(false);
    }
  }, [rfp, profile, planOfExecution, planLoading]);

  const handleDownloadPlanOfExecution = useCallback(async () => {
    if (!planOfExecution || !rfp.title) return;
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
    const { saveAs } = await import("file-saver");
    const lines = planOfExecution.split(/\n/);
    const children = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return new Paragraph({ text: "", spacing: { after: 120 } });
      const isHeading = /^\d+\.\s*\*\*/.test(trimmed) || (/^\*\*.*\*\*$/.test(trimmed) && trimmed.length < 80);
      const text = trimmed.replace(/\*\*/g, "");
      return isHeading
        ? new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } })
        : new Paragraph({ children: [new TextRun({ text: trimmed })], spacing: { after: 120 } });
    });
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({ text: rfp.title, heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
          new Paragraph({ text: rfp.agency, spacing: { after: 360 } }),
          ...children,
        ],
      }],
    });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, `Plan-of-Execution-${rfp.title.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "-")}.docx`);
  }, [planOfExecution, rfp.title, rfp.agency]);

  useEffect(() => {
    if (cachedSummary) {
      setLlmSummary(cachedSummary);
      setSummaryError(false);
      return;
    }

    setLlmSummary(null);
    setSummaryError(false);
    const controller = new AbortController();

    async function fetchSummary() {
      try {
        const res = await fetch("/api/match-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
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
            positiveReasons: match.positiveReasons,
            negativeReasons: match.negativeReasons,
            disqualifiers: match.disqualifiers,
            breakdown: match.breakdown,
            score: match.score,
            tier: match.tier,
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error("[match-summary] API error:", res.status, errText);
          throw new Error(errText);
        }
        const data = await res.json();
        const summary = data.summary ?? initialSummary;
        setLlmSummary(summary);
        onSummaryReady(rfp.id, summary);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[match-summary] Fetch failed:", err);
        if (!controller.signal.aborted) setSummaryError(true);
      }
    }

    fetchSummary();
    return () => { controller.abort(); };
  }, [rfp.id, rfp.title, rfp.agency, rfp.industry, rfp.location, rfp.deadline, rfp.capabilities, rfp.certifications, rfp.contractType, rfp.description, profile, initialSummary, cachedSummary, onSummaryReady]);

  useEffect(() => {
    if (!rfp.description?.trim()) return;

    const controller = new AbortController();
    setRequirementsSummaryLoading(true);
    setRequirementsSummaryError(false);

    async function fetchRequirementsSummary() {
      try {
        const res = await fetch("/api/rfp-requirements-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
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
              attachmentRollup: rfp.attachmentRollup,
            },
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setRequirementsSummary(data.summary ?? rfp.description);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[rfp-requirements-summary] Fetch failed:", err);
        if (!controller.signal.aborted) {
          setRequirementsSummaryError(true);
          setRequirementsSummary(null);
        }
      } finally {
        if (!controller.signal.aborted) setRequirementsSummaryLoading(false);
      }
    }

    fetchRequirementsSummary();
    return () => { controller.abort(); };
  }, [rfp.id, rfp.description, rfp.title, rfp.agency, rfp.industry, rfp.location, rfp.deadline, rfp.contractType, rfp.capabilities, rfp.certifications, rfp.estimatedValue]);

  // Fetch capabilities analysis (compares RFP requirements against company profile)
  useEffect(() => {
    const controller = new AbortController();
    setCapabilitiesAnalysisLoading(true);
    setCapabilitiesAnalysisError(false);

    async function fetchCapabilitiesAnalysis() {
      try {
        const res = await fetch("/api/capabilities-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
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
                  technologyStack: profile.technologyStack,
                }
              : null,
            breakdown: match.breakdown,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setCapabilitiesAnalysis(data.analysis ?? null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[capabilities-analysis] Fetch failed:", err);
        if (!controller.signal.aborted) {
          setCapabilitiesAnalysisError(true);
          setCapabilitiesAnalysis(null);
        }
      } finally {
        if (!controller.signal.aborted) setCapabilitiesAnalysisLoading(false);
      }
    }

    fetchCapabilitiesAnalysis();
    return () => { controller.abort(); };
  }, [rfp.id, profile]);

  const summary = llmSummary ?? initialSummary;
  const isLoadingSummary = llmSummary === null && !summaryError;

  return (
    <article className="w-full p-4 md:p-6">
      <div className="rounded-2xl overflow-hidden bg-white shadow-sm border border-slate-200">
        {/* Hero: title + match score; Save / I've applied */}
        <div className="p-5 md:p-6 border-b border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
            <h2 className="text-xl md:text-2xl font-bold text-slate-900 leading-tight min-w-0">{rfp.title}</h2>
            <div className="shrink-0">
              <MatchBadge score={match.score} tier={match.tier} disqualified={match.disqualified} size="lg" />
            </div>
          </div>
          {/* Save + I've applied — right under the title */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSave(); }}
              className={`text-sm flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg transition-colors ${isSaved ? "text-emerald-600 bg-emerald-50 hover:bg-emerald-100" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"}`}
            >
              <svg className={`w-4 h-4 ${isSaved ? "fill-current" : ""}`} fill={isSaved ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
              {isSaved ? "Saved" : "Save"}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleApplied(); }}
              className={`text-sm flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg transition-colors ${isApplied ? "text-emerald-600 bg-emerald-50 hover:bg-emerald-100" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"}`}
            >
              {isApplied ? (<><svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Applied</>) : (<><svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> I&apos;ve applied</>)}
            </button>
            
          </div>
        </div>

        {/* Important information (left) + Match Summary (right) */}
        <div className="p-5 md:p-6 border-b border-slate-100">
          <div className="flex flex-col gap-y-4 md:flex-row md:items-start md:gap-0">
            <div className="min-w-0 md:w-64 md:shrink-0 md:pr-6">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Important information</h3>
              <div className="space-y-4 text-left">
                {[
                  { label: "Due", value: rfp.deadline?.trim() || "TBD" },
                  { label: "Location", value: rfp.location },
                  { label: "Est. value", value: rfp.estimatedValue },
                  { label: "Requested by", value: `${rfp.agency}${rfp.industry ? ` · ${rfp.industry}` : ""}` },
                ].map((row, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">{row.label}</div>
                    <div className="text-sm text-slate-800 break-words leading-snug">{row.value}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="min-w-0 flex-1 md:border-l md:border-slate-200 md:pl-6">
              <div className={`rounded-lg border-2 ${match.disqualified ? "border-red-200 bg-red-50/30" : "border-blue-200 bg-blue-50"} p-4`}>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Match Summary</h3>
                {isLoadingSummary && <span className="text-xs text-slate-400 animate-pulse">Summarizing…</span>}
                <p className="text-sm text-slate-700 leading-relaxed mt-1">{summary}</p>
                {summaryError && (
                  <p className="mt-2 text-xs text-amber-600">AI summary unavailable. Using rule-based summary.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* About this RFP — in a contained text box */}
        <div className="p-5 md:p-6 border-b border-slate-100">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">About this RFP</h3>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            {requirementsSummaryLoading ? (
              <p className="text-slate-500 text-sm animate-pulse">Summarizing contract requirements…</p>
            ) : requirementsSummary ? (
              <MarkdownContent content={requirementsSummary} />
            ) : (
              <p className="text-sm text-slate-700 leading-relaxed">{rfp.description || "—"}</p>
            )}
            {requirementsSummaryError && (
              <p className="mt-2 text-xs text-amber-600">AI summary unavailable. Showing original description.</p>
            )}
          </div>
        </div>

        {/* Score Breakdown */}
        {match.breakdown.length > 0 && !match.disqualified && (
          <div className="p-5 md:p-6 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Score Breakdown</h3>
            <div className="space-y-3">
              {match.breakdown.map((b, i) => {
                const isNeutral = b.status === "neutral";
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
                        {isNeutral ? (
                          <span className="text-xs font-medium text-slate-400 italic">Not Applicable</span>
                        ) : b.maxPoints > 0 ? (
                          <span className={`text-xs font-bold ${textColor}`}>{b.points}/{b.maxPoints}</span>
                        ) : null}
                      </div>
                      {isNeutral ? (
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-slate-200" style={{ width: "100%" }} />
                        </div>
                      ) : b.maxPoints > 0 ? (
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
          </div>
        )}

        {/* Capabilities Analysis — in a contained text box */}
        <div className="p-5 md:p-6 border-b border-slate-100">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Capabilities Analysis</h3>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            {capabilitiesAnalysisLoading ? (
              <p className="text-slate-500 text-sm animate-pulse">Analyzing capabilities against requirements…</p>
            ) : capabilitiesAnalysis ? (
              <MarkdownContent content={capabilitiesAnalysis} />
            ) : capabilitiesAnalysisError ? (
              <p className="text-xs text-amber-600">Capabilities analysis unavailable.</p>
            ) : (
              <p className="text-slate-500 text-sm">No company profile available for analysis.</p>
            )}
          </div>
        </div>

        {/* Disqualifier banner */}
        {match.disqualified && match.disqualifiers.length > 0 && (
          <div className="p-5 md:p-6 border-t border-red-100 bg-red-50">
            <h3 className="text-xs font-semibold text-red-800 uppercase tracking-wider mb-2">Not Eligible</h3>
            <ul className="space-y-1">
              {match.disqualifiers.map((d, i) => (
                <li key={i} className="text-sm text-red-700 flex items-start gap-2">
                  <span className="text-red-500 shrink-0 mt-0.5">✗</span>
                  {d}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Capabilities Analysis */}
        {/* <div className="p-5 md:p-6 border-t border-slate-100">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Capabilities Analysis</h3>
          {capabilitiesAnalysisLoading ? (
            <p className="text-slate-500 text-sm animate-pulse">Analyzing capabilities against requirements…</p>
          ) : capabilitiesAnalysis ? (
            <MarkdownContent content={capabilitiesAnalysis} />
          ) : capabilitiesAnalysisError ? (
            <p className="text-xs text-amber-600">Capabilities analysis unavailable.</p>
          ) : (
            <p className="text-slate-500 text-sm">No company profile available for analysis.</p>
          )}
        </div> */}

        {/* Score Breakdown */}
        {/* {match.breakdown.length > 0 && !match.disqualified && (
          <div className="p-6 md:p-8 border-t border-slate-100">
            <h4 className="text-sm font-bold text-slate-900 mb-3">Score Breakdown</h4>
            <div className="space-y-2">
              {match.breakdown.filter((b) => b.maxPoints > 0 || b.status !== "neutral").map((b, i) => {
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
                      className={`flex items-center gap-3 ${hasTokens ? "cursor-pointer rounded-md px-1 -mx-1 hover:bg-slate-50 transition-colors" : ""}`}
                      onClick={() => hasTokens && setExpandedBreakdownCategory(isExpanded ? null : b.category)}
                    >
                      <span className="text-xs font-medium text-slate-700 w-28 shrink-0 truncate" title={b.category}>{b.category}</span>
                      {b.maxPoints > 0 ? (
                        <>
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`text-xs font-bold w-12 text-right shrink-0 ${textColor}`}>
                            {b.points}/{b.maxPoints}
                          </span>
                        </>
                      ) : (
                        <span className={`text-xs ${textColor} flex-1`}>{b.detail}</span>
                      )}
                      {hasTokens && (
                        <svg className={`w-3 h-3 text-slate-400 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      )}
                    </div>
                    {isExpanded && hasTokens && (
                      <div className="mt-2 mb-1 ml-1 p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs space-y-2">
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
          </div>
        )} */}

        {/* About this RFP - AI summary of contract requirements */}
        {/* <div className="p-6 md:p-8 border-t border-slate-100">
          <h4 className="text-sm font-bold text-slate-900 mb-3">About this RFP</h4>
          {requirementsSummaryLoading ? (
            <p className="text-slate-500 text-sm animate-pulse">Summarizing contract requirements…</p>
          ) : requirementsSummary ? (
            <MarkdownContent content={requirementsSummary} />
          ) : (
            <p className="text-sm text-slate-700 leading-relaxed">{rfp.description}</p>
          )}
          {requirementsSummaryError && (
            <p className="mt-2 text-xs text-amber-600">AI summary unavailable. Showing original description.</p>
          )}
        </div> */}

        {/* Contact */}
        {(rfp.contactEmail || rfp.contactName) && (
          <div className="p-5 md:p-6 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Contact</h3>
            {rfp.contactName && <p className="text-sm text-slate-700">{rfp.contactName}</p>}
            {rfp.contactEmail && (
              <a href={`mailto:${rfp.contactEmail}`} className="text-sm text-[#2563eb] hover:underline">{rfp.contactEmail}</a>
            )}
          </div>
        )}

        {/* Generated Plan of Execution dropdown — when open, appears above the bottom buttons */}
        {poeDropdownOpen && (
          <div className="border-t border-slate-100 bg-slate-50/50">
            <div className="p-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900">Generated Plan of Execution</h3>
              <div className="flex items-center gap-2">
                {planOfExecution && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDownloadPlanOfExecution(); }}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    Download
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (planOfExecution) {
                      updateUserRfpStatus({ save_generated_poe: { rfp_id: rfp.id, content: planOfExecution } }).catch(() => {});
                    }
                    setPoeDropdownOpen(false);
                  }}
                  className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                  aria-label="Close"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
              </div>
            </div>
            <div className="px-4 pb-4 max-h-[60vh] overflow-y-auto">
              {planLoading && !planOfExecution ? (
                <p className="text-sm text-slate-500 animate-pulse">Generating plan…</p>
              ) : planError ? (
                <p className="text-sm text-red-600">{planError}</p>
              ) : planOfExecution ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                      {planOfExecution}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-start">
                    <div className="flex-1 min-w-[180px]">
                      <label className="block text-xs font-medium text-slate-600 mb-1">Improve with feedback (optional)</label>
                      <textarea
                        value={planFeedback}
                        onChange={(e) => setPlanFeedback(e.target.value)}
                        placeholder="e.g. Add more detail on timelines..."
                        rows={2}
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#2563eb] focus:border-transparent resize-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleGeneratePlanOfExecution(planFeedback); }}
                      disabled={planLoading}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 mt-5"
                    >
                      {planLoading ? "Regenerating…" : "Regenerate with feedback"}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Click &quot;Generate Plan of Execution&quot; below to create a plan. It will appear here.</p>
              )}
            </div>
          </div>
        )}

        {/* Bottom: Generate Plan of Execution + View on Cal eProcure */}
        <div className="p-5 md:p-6 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPoeDropdownOpen((open) => !open);
              if (!planOfExecution && !planLoading) handleGeneratePlanOfExecution();
            }}
            className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg text-sm font-semibold bg-[#2563eb] text-white hover:bg-[#1d4ed8] transition-colors"
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
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Generate Plan of Execution
              </>
            )}
          </button>
          {(rfp.eventUrl || rfp.id) && (
            <a href={rfp.eventUrl || "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors">
              View on Cal eProcure <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
