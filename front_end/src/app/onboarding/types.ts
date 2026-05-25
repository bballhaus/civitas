// Snapshot shape returned by GET /api/onboarding/state/. Mirrors the subset
// of profile data the wizard needs to pre-fill — kept here as the wizard's
// view-model contract so route + UI stay aligned.

export interface OnboardingSnapshot {
  companyName: string | null;
  yearFounded: number | null;
  employeeBand: string | null;
  website: string | null;
  scopeMinUsd: number | null;
  scopeMaxUsd: number | null;
  durationPref: string | null;
  complexityPref: string | null;
  // Multi-select: a contractor may bid as both prime and sub. Values:
  // 'prime' | 'sub'. null/empty array == not answered.
  primeVsSub: string[] | null;
  // Multi-select: contractor may have experience at several tiers. Values:
  // 'none' | 'local' | 'state' | 'federal'.
  govExperience: string[] | null;
  // Federal NAICS codes the contractor self-identifies with (e.g. '561720').
  // Drives the direct code-overlap score in the matcher and feeds NAICS
  // titles into the RFP embedding text for semantic capability matching.
  naicsCodes: string[] | null;
  specialties: { id: string; value: string; weight: string }[];
  capabilities: { id: string; value: string }[];
  licenses: {
    id: string;
    licenseClass: string;
    licenseNumber: string | null;
    expiresOn: string | null;
  }[];
  certifications: {
    id: string;
    canonicalId: string;
    displayName: string;
    kind: string;
  }[];
  workAreas: {
    id: string;
    kind: string;
    name: string;
    isHard: boolean;
    radiusMiles: number | null;
  }[];
  agencyRelationships: {
    id: string;
    agencyCanonical: string;
    agencyDisplay: string;
    role: string;
    strength: number;
  }[];
  // Notification preferences — surfaced on Step 9 (Review) as an inline
  // opt-in. Timezone is captured from the browser when the toggle flips on.
  dailyRoundupEnabled: boolean;
  dailyRoundupTimezone: string | null;
}
