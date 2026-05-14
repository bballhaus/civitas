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
  primeVsSub: string | null;
  govExperience: string | null;
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
  }[];
  agencyRelationships: {
    id: string;
    agencyCanonical: string;
    agencyDisplay: string;
    role: string;
    strength: number;
  }[];
}
