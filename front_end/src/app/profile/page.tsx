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
  contractCount: number;
  totalPastContractValue: string;
  pastPerformance: string;
  strategicGoals: string;
  uploadedFiles?: Array<{
    name: string;
    type: string;
    size: number;
    uploadedAt: string;
    parsed?: boolean;
  }>;
}

function SummarySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-lg border border-slate-200 p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/profile-setup"
            className="px-3 py-1.5 text-sm text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
          >
            Edit
          </Link>
          <Link
            href="/profile-setup"
            className="px-3 py-1.5 text-sm bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors"
          >
            Save
          </Link>
        </div>
      </div>
      {children}
    </section>
  );
}

function ListOrEmpty({ items }: { items: string[] }) {
  if (!items?.length) return <p className="text-slate-500 italic text-sm">Not provided</p>;
  return (
    <ul className="list-disc list-inside text-slate-700 space-y-1">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    const saved = localStorage.getItem("companyProfile");
    const extracted = localStorage.getItem("extractedProfileData");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setProfile(parsed);
        return;
      } catch (e) {
        console.error("Error loading profile:", e);
      }
    }
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted);
        setProfile({
          ...parsed,
          uploadedFiles: [],
        });
      } catch (e) {
        console.error("Error loading extracted data:", e);
      }
    }
    if (!saved && !extracted) {
      setProfile(null);
    }
  }, []);

  if (!isClient) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#3C89C6]"></div>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="min-h-screen bg-slate-50">
        <nav className="sticky top-0 bg-white border-b border-slate-200 z-10">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <img src="/logo.png" alt="Civitas logo" className="h-12 w-12" />
              <span className="text-2xl font-bold text-slate-900">Civitas</span>
            </Link>
            <div className="flex items-center gap-3">
              <Link
                href="/profile-setup"
                className="px-4 py-2 bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors"
              >
                Save Profile
              </Link>
            </div>
          </div>
        </nav>
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">No profile yet</h1>
          <p className="text-slate-600 mb-6">
            Create or save your company profile to see a summary here.
          </p>
          <Link
            href="/profile-setup"
            className="inline-flex px-6 py-3 bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors"
          >
            Create profile
          </Link>
        </div>
      </div>
    );
  }

  const hasAnyData =
    profile.companyName ||
    (profile.industry?.length ?? 0) > 0 ||
    (profile.certifications?.length ?? 0) > 0 ||
    (profile.clearances?.length ?? 0) > 0 ||
    (profile.naicsCodes?.length ?? 0) > 0 ||
    (profile.workCities?.length ?? 0) > 0 ||
    (profile.workCounties?.length ?? 0) > 0 ||
    (profile.capabilities?.length ?? 0) > 0 ||
    (profile.agencyExperience?.length ?? 0) > 0 ||
    (profile.contractTypes?.length ?? 0) > 0 ||
    (profile.sizeStatus?.length ?? 0) > 0 ||
    profile.contractCount > 0 ||
    profile.totalPastContractValue ||
    profile.pastPerformance ||
    profile.strategicGoals ||
    (profile.uploadedFiles?.length ?? 0) > 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="Civitas logo" className="h-12 w-12" />
            <span className="text-2xl font-bold text-slate-900">Civitas</span>
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Your profile</h1>
          <p className="text-slate-600">
            Summary of the data you have entered. Use Edit or Save in each section to update.
          </p>
        </div>

        {!hasAnyData ? (
          <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-500">
            No data entered yet.{" "}
            <Link href="/profile-setup" className="text-[#3C89C6] hover:underline">
              Create your profile
            </Link>
            .
          </div>
        ) : (
          <div className="space-y-6">
            <SummarySection title="Company information">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Company name</p>
                  <p className="text-slate-900">{profile.companyName || "—"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Industry</p>
                  <ListOrEmpty items={profile.industry ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Size / status</p>
                  <ListOrEmpty items={profile.sizeStatus ?? []} />
                </div>
              </div>
            </SummarySection>

            <SummarySection title="Certifications & clearances">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Certifications</p>
                  <ListOrEmpty items={profile.certifications ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Clearances</p>
                  <ListOrEmpty items={profile.clearances ?? []} />
                </div>
              </div>
            </SummarySection>

            <SummarySection title="NAICS & geography">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">NAICS codes</p>
                  <ListOrEmpty items={profile.naicsCodes ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Work cities</p>
                  <ListOrEmpty items={profile.workCities ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Work counties</p>
                  <ListOrEmpty items={profile.workCounties ?? []} />
                </div>
              </div>
            </SummarySection>

            <SummarySection title="Capabilities & experience">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Capabilities</p>
                  <ListOrEmpty items={profile.capabilities ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Agency experience</p>
                  <ListOrEmpty items={profile.agencyExperience ?? []} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Contract types</p>
                  <ListOrEmpty items={profile.contractTypes ?? []} />
                </div>
              </div>
            </SummarySection>

            <SummarySection title="Contract history">
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Contract count</p>
                  <p className="text-slate-900">{profile.contractCount ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total past contract value</p>
                  <p className="text-slate-900">{profile.totalPastContractValue || "—"}</p>
                </div>
                {profile.pastPerformance && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Past performance</p>
                    <p className="text-slate-700 whitespace-pre-wrap">{profile.pastPerformance}</p>
                  </div>
                )}
                {profile.strategicGoals && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Strategic goals</p>
                    <p className="text-slate-700 whitespace-pre-wrap">{profile.strategicGoals}</p>
                  </div>
                )}
              </div>
            </SummarySection>

            {profile.uploadedFiles && profile.uploadedFiles.length > 0 && (
              <SummarySection title="Uploaded documents">
                <ul className="space-y-2">
                  {profile.uploadedFiles.map((file, i) => (
                    <li key={i} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                      <span className="text-slate-700 font-medium">{file.name}</span>
                      <span className="text-slate-500 text-sm">{(file.size / 1024).toFixed(2)} KB</span>
                    </li>
                  ))}
                </ul>
              </SummarySection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
