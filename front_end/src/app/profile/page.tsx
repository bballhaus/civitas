"use client";

import { useState, useEffect, useRef } from "react";
import type { ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CALIFORNIA_CITIES,
  CALIFORNIA_COUNTIES,
  NAICS_DISPLAY,
} from "@/data/filter-options";
import { AppHeader } from "@/components/AppHeader";
import { MeshBackground } from "@/components/MeshBackground";
import {
  getApiBase,
  getCurrentUser,
  getCachedUser,
  getCachedProfile,
  setCachedProfile,
  saveProfileToBackend,
  getProfileFromBackend,
  uploadContractDocument,
  deleteContractDocument,
  getAuthToken,
  mapBackendProfileToCompanyProfile,
  getEmptyCompanyProfile,
  type CurrentUser,
} from "@/lib/api";

type SectionId = "company" | "certifications" | "naics" | "capabilities" | "contract" | "documents" | null;

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
    uploadedAt: string;
    parsed?: boolean;
    uploadedToBackend?: boolean;
    contractId?: string;
  }>;
}

const inputClass =
  "w-full px-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent bg-white text-slate-700";
const labelClass = "block text-sm font-medium text-slate-700 mb-2";
const sectionTitleClass = "text-xl font-semibold text-slate-900 mb-4";
const sectionClass = "bg-white rounded-lg border border-slate-200 p-6";
const btnPrimary =
  "px-3 py-1.5 text-sm bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors";
const btnSecondary =
  "px-3 py-1.5 text-sm text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors";

const PROFILE_SECTIONS: { id: string; label: string }[] = [
  { id: "section-company", label: "Company Information" },
  { id: "section-certifications", label: "Certifications & Clearances" },
  { id: "section-naics", label: "NAICS & Geography" },
  { id: "section-capabilities", label: "Capabilities & Experience" },
  { id: "section-contract", label: "Contract History" },
  { id: "section-documents", label: "Uploaded Documents" },
];

function scrollToSection(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  const sidebarTopOffset = 128; // Match sidebar top-32 position (32 * 4px = 128px)
  const elementPosition = element.getBoundingClientRect().top;
  const offsetPosition = elementPosition + window.pageYOffset - sidebarTopOffset;
  window.scrollTo({
    top: offsetPosition,
    behavior: "smooth",
  });
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
  const router = useRouter();
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [editingSection, setEditingSection] = useState<SectionId>(null);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [profileLoadedFromBackend, setProfileLoadedFromBackend] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [dupMessage, setDupMessage] = useState("");
  const pendingFilesRef = useRef<Map<string, File>>(new Map());

  // Parse documents with backend API
  const parseDocumentsWithBackend = async (files: File[]): Promise<any> => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("documents", file);
    });

    try {
      const response = await fetch(`${getApiBase()}/profile/extract/`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorMessage = `HTTP error! status: ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.details && Array.isArray(errorData.details)) {
            const details = errorData.details.map((e: any) => 
              `${e.file || 'Unknown file'}: ${e.error || 'Unknown error'}`
            ).join('; ');
            errorMessage = errorData.error || errorMessage;
            if (details) {
              errorMessage += ` (${details})`;
            }
          } else {
            errorMessage = errorData.error || errorData.document || errorMessage;
          }
        } catch (e) {
          errorMessage = response.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      if (!data.profile) {
        throw new Error("Invalid response from server: missing profile data");
      }
      return data.profile;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error(
          `Cannot connect to backend server. Please make sure the Django server is running at ${getApiBase()}.`
        );
      }
      throw error;
    }
  };

  // Merge extracted data with existing profile
  const mergeProfileData = (existing: CompanyProfile, extracted: any): CompanyProfile => {
    // Helper to merge arrays (add unique values)
    const mergeArrays = (existing: string[], extracted: string[]): string[] => {
      const combined = [...existing, ...(extracted || [])];
      return Array.from(new Set(combined.filter(item => item && item.trim() !== "")));
    };

    // Helper to parse and sum contract values
    const parseContractValue = (value: string | number | undefined): number => {
      if (!value) return 0;
      if (typeof value === 'number') return value;
      // Remove currency symbols, commas, and whitespace, then parse
      const cleaned = String(value).replace(/[$,\s]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    };

    // Accumulate contract count (add together)
    const existingCount = existing.contractCount || 0;
    const extractedCount = extracted.contractCount || 0;
    const totalContractCount = existingCount + extractedCount;

    // Accumulate total past contract value (add together)
    const existingValue = parseContractValue(existing.totalPastContractValue);
    const extractedValue = parseContractValue(extracted.totalPastContractValue);
    const totalValue = existingValue + extractedValue;
    // Format as string (use numeric value if both exist, otherwise keep original format)
    const formattedTotalValue = totalValue > 0 
      ? totalValue.toString()
      : (existing.totalPastContractValue || extracted.totalPastContractValue || "");

    return {
      ...existing,
      // Merge company name (use extracted if existing is empty, otherwise keep existing)
      companyName: existing.companyName || extracted.companyName || "",
      // Merge arrays (add unique values)
      industry: mergeArrays(existing.industry, extracted.industry || []),
      sizeStatus: mergeArrays(existing.sizeStatus, extracted.sizeStatus || []),
      certifications: mergeArrays(existing.certifications, extracted.certifications || []),
      clearances: mergeArrays(existing.clearances, extracted.clearances || []),
      naicsCodes: mergeArrays(existing.naicsCodes, extracted.naicsCodes || []),
      workCities: mergeArrays(existing.workCities, extracted.workCities || []),
      workCounties: mergeArrays(existing.workCounties, extracted.workCounties || []),
      capabilities: mergeArrays(existing.capabilities, extracted.capabilities || []),
      agencyExperience: mergeArrays(existing.agencyExperience, extracted.agencyExperience || []),
      contractTypes: mergeArrays(existing.contractTypes, extracted.contractTypes || []),
      // Accumulate contract count and value
      contractCount: totalContractCount,
      totalPastContractValue: formattedTotalValue,
      pastPerformance: existing.pastPerformance || extracted.pastPerformance || "",
      strategicGoals: existing.strategicGoals || extracted.strategicGoals || "",
    };
  };

  /** Load profile from localStorage only when not logged in (fallback). When logged in we only trust backend/AWS. */
  const loadProfileFromStorage = () => {
    const saved = localStorage.getItem("companyProfile");
    const extracted = localStorage.getItem("extractedProfileData");
    if (saved) {
      try {
        setProfile(JSON.parse(saved));
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
          uploadedFiles: parsed.uploadedFiles ?? [],
        });
      } catch (e) {
        console.error("Error loading extracted data:", e);
      }
    }
    if (!saved && !extracted) setProfile(null);
  };

  // Parse and merge documents
  const parseAndMergeDocuments = async () => {
    if (!profile) return;

    const unparsedFiles = profile.uploadedFiles?.filter(file => !file.parsed) || [];
    
    if (unparsedFiles.length === 0) {
      alert("No new documents to parse. All uploaded files have already been processed.");
      return;
    }

    setIsParsing(true);
    try {
      // Get file objects from local storage
      const storedFiles = JSON.parse(localStorage.getItem("uploadedFiles") || "[]");
      const filesToParse: File[] = [];
      
      // Convert base64 files back to File objects
      for (const unparsedFile of unparsedFiles) {
        const storedFile = storedFiles.find((f: any) => f.name === unparsedFile.name);
        if (storedFile && storedFile.content) {
          // Convert base64 to blob then to File
          const base64Data = storedFile.content.split(',')[1];
          const byteCharacters = atob(base64Data);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: storedFile.type });
          const file = new File([blob], storedFile.name, { type: storedFile.type });
          filesToParse.push(file);
        }
      }

      if (filesToParse.length > 0) {
        // Parse the documents
        const extractedData = await parseDocumentsWithBackend(filesToParse);

        // Merge extracted data with existing profile
        const mergedProfile = mergeProfileData(profile, extractedData);

        // Mark files as parsed
        const updatedFiles = (mergedProfile.uploadedFiles ?? []).map((file) =>
          unparsedFiles.some((uf) => uf.name === file.name)
            ? { ...file, parsed: true }
            : file
        );
        mergedProfile.uploadedFiles = updatedFiles;
        
        // Update profile state
        setProfile(mergedProfile);

        // Save merged profile
        localStorage.setItem("companyProfile", JSON.stringify(mergedProfile));

        alert(`Successfully parsed ${filesToParse.length} document(s) and updated your profile!`);
      } else {
        alert("Could not find file data to parse. Please try uploading the files again.");
      }
    } catch (error) {
      console.error("Error parsing documents:", error);
      alert(`Error parsing documents: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    } finally {
      setIsParsing(false);
    }
  };

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Instant show when we have cached user + profile; otherwise load user then profile from backend.
  useEffect(() => {
    if (!isClient) return;
    const cachedUser = getCachedUser();
    const cachedProfile = cachedUser ? getCachedProfile(cachedUser.user_id) : null;
    if (cachedUser && cachedProfile) {
      setCurrentUser(cachedUser);
      setProfile(cachedProfile);
      setProfileLoadedFromBackend(true);
      setInitialLoadDone(true);
      setLoadingProfile(false);
      return;
    }
    setLoadingProfile(true);
    getCurrentUser(false)
      .then((data) => {
        if (!data) {
          setCurrentUser(null);
          setProfile(null);
          setInitialLoadDone(true);
          setLoadingProfile(false);
          return;
        }
        setCurrentUser(data);
        return getProfileFromBackend()
          .then((backendProfile) => {
            const mapped = mapBackendProfileToCompanyProfile(backendProfile) ?? getEmptyCompanyProfile();
            setProfile(mapped);
            setCachedProfile(data.user_id, mapped);
            setProfileLoadedFromBackend(true);
          })
          .catch((e) => {
            console.error("Failed to load profile from backend:", e);
            setProfile(getEmptyCompanyProfile());
          });
      })
      .catch((e) => {
        console.error("Failed to load user:", e);
      })
      .finally(() => {
        setInitialLoadDone(true);
        setLoadingProfile(false);
      });
  }, [isClient]);

  const ensureProfileLoaded = async (): Promise<boolean> => {
    if (profileLoadedFromBackend) return true;
    setLoadingProfile(true);
    try {
      const backendProfile = await getProfileFromBackend();
      const mapped = mapBackendProfileToCompanyProfile(backendProfile) ?? getEmptyCompanyProfile();
      setProfile(mapped);
      if (currentUser) setCachedProfile(currentUser.user_id, mapped);
      setProfileLoadedFromBackend(true);
      return true;
    } catch (e) {
      console.error("Failed to load profile from backend:", e);
      return false;
    } finally {
      setLoadingProfile(false);
    }
  };

  const handleInputChange = (field: keyof CompanyProfile, value: unknown) => {
    setProfile((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const handleMultiSelect = (
    field:
      | "industry"
      | "sizeStatus"
      | "certifications"
      | "clearances"
      | "naicsCodes"
      | "workCities"
      | "workCounties"
      | "capabilities"
      | "agencyExperience"
      | "contractTypes",
    value: string,
    valueToStore?: string
  ) => {
    const stored = valueToStore ?? value;
    setProfile((prev) => {
      if (!prev) return null;
      const current = prev[field] ?? [];
      const updated = current.includes(stored)
        ? current.filter((item) => item !== stored)
        : [...current, stored];
      return { ...prev, [field]: updated };
    });
  };

  const profileToBackendPayload = (p: CompanyProfile) => ({
    name: p.companyName,
    contract_count: p.contractCount,
    certifications: p.certifications ?? [],
    clearances: p.clearances ?? [],
    naics_codes: p.naicsCodes ?? [],
    industry_tags: p.industry ?? [],
    work_cities: p.workCities ?? [],
    work_counties: p.workCounties ?? [],
    capabilities: p.capabilities ?? [],
    agency_experience: p.agencyExperience ?? [],
  });

  const saveSection = async () => {
    if (!profile) return;
    setSectionSaving(true);
    let profileToSave = profile;
    try {
      if (editingSection === "documents") {
        if (currentUser && getAuthToken()) {
          for (const fileInfo of profileToSave.uploadedFiles ?? []) {
            if (fileInfo.uploadedToBackend) continue;
            const file = pendingFilesRef.current.get(fileInfo.name);
            if (file) {
              await uploadContractDocument(file, file.name);
            }
          }
          pendingFilesRef.current.clear();

          const backendProfile = await getProfileFromBackend();
          const mapped = mapBackendProfileToCompanyProfile(backendProfile) ?? getEmptyCompanyProfile();
          setProfile(mapped);
          setCachedProfile(currentUser.user_id, mapped);
          setEditingSection(null);
          setSectionSaving(false);
          return;
        }

        const storedFiles = JSON.parse(localStorage.getItem("uploadedFiles") || "[]");
        const unparsedFiles = profileToSave.uploadedFiles?.filter((file) => !file.parsed) || [];
        if (unparsedFiles.length > 0) {
          try {
            const filesToParse: File[] = [];
            for (const unparsedFile of unparsedFiles) {
              const storedFile = storedFiles.find((f: { name: string }) => f.name === unparsedFile.name);
              if (storedFile?.content) {
                const base64Data = storedFile.content.split(",")[1];
                if (base64Data) {
                  const byteCharacters = atob(base64Data);
                  const byteNumbers = new Array(byteCharacters.length);
                  for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                  }
                  const byteArray = new Uint8Array(byteNumbers);
                  const blob = new Blob([byteArray], { type: storedFile.type });
                  filesToParse.push(new File([blob], storedFile.name, { type: storedFile.type }));
                }
              }
            }
            if (filesToParse.length > 0) {
              const extractedData = await parseDocumentsWithBackend(filesToParse);
              const mergedProfile = mergeProfileData(profileToSave, extractedData);
              const updatedFiles = (mergedProfile.uploadedFiles ?? []).map((file) =>
                unparsedFiles.some((uf) => uf.name === file.name)
                  ? { ...file, parsed: true }
                  : file
              );
              mergedProfile.uploadedFiles = updatedFiles;
              setProfile(mergedProfile);
              profileToSave = mergedProfile;
            }
          } catch (error) {
            console.error("Error parsing documents:", error);
            alert(`Warning: Could not parse some documents. Profile saved without updates from those files.`);
          }
        }

        if (currentUser && (removalsToProcess.length > 0 || filesToUpload.length > 0)) {
          const backendProfile = await getProfileFromBackend();
          const mapped = mapBackendProfileToCompanyProfile(backendProfile) ?? getEmptyCompanyProfile();
          setProfile(mapped);
          setCachedProfile(currentUser.user_id, mapped);
          profileToSave = mapped;
        }
      } else {
        profileToSave = profile;
      }

      if (currentUser) {
        const saved = await saveProfileToBackend(profileToBackendPayload(profileToSave));
        const mapped = mapBackendProfileToCompanyProfile(saved);
        if (mapped) setCachedProfile(currentUser.user_id, mapped);
      } else {
        localStorage.setItem("companyProfile", JSON.stringify(profileToSave));
      }
      setEditingSection(null);
    } catch (error) {
      console.error("Error saving profile:", error);
      alert(`Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setSectionSaving(false);
    }
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !profile) return;
    const existingNames = new Set((profile.uploadedFiles ?? []).map((f) => f.name));
    const newFiles = Array.from(files).filter((f) => {
      if (existingNames.has(f.name)) return false;
      existingNames.add(f.name);
      return true;
    });
    const skipped = files.length - newFiles.length;
    if (skipped > 0) {
      setDupMessage(`${skipped} duplicate file(s) already uploaded — skipped.`);
    } else {
      setDupMessage("");
    }
    newFiles.forEach((file) => {
      const fileInfo = {
        name: file.name,
        type: file.type || "application/octet-stream",
        uploadedAt: new Date().toISOString(),
        parsed: false,
      };
      pendingFilesRef.current.set(file.name, file);
      setProfile((prev) =>
        prev
          ? { ...prev, uploadedFiles: [...(prev.uploadedFiles ?? []), fileInfo] }
          : null
      );
    });
  };

  const removeFile = (index: number) => {
    if (!profile?.uploadedFiles) return;
    const file = profile.uploadedFiles[index];
    const key = file.contractId || file.name;
    setPendingRemovals((prev) => [...prev, key]);
  };

  function SearchFirstDropdown({
    field,
    options,
    selectedValues,
    placeholder,
    getValueToStore,
    isOptionSelected,
  }: {
    field: keyof Pick<
      CompanyProfile,
      | "industry"
      | "sizeStatus"
      | "certifications"
      | "clearances"
      | "naicsCodes"
      | "workCities"
      | "workCounties"
      | "capabilities"
      | "agencyExperience"
      | "contractTypes"
    >;
    options: string[];
    selectedValues: string[];
    placeholder: string;
    getValueToStore?: (option: string) => string;
    isOptionSelected?: (option: string, selected: string[]) => boolean;
  }) {
    const [searchTerm, setSearchTerm] = useState("");
    const [isFocused, setIsFocused] = useState(false);
    const safeSelected = Array.isArray(selectedValues) ? selectedValues : [];
    const filtered = options.filter((o) =>
      o.toLowerCase().includes(searchTerm.toLowerCase())
    );
    const checked = (option: string) =>
      isOptionSelected ? isOptionSelected(option, safeSelected) : safeSelected.includes(option);
    const valueToStore = (option: string) => (getValueToStore ? getValueToStore(option) : option);

    return (
      <div className="relative w-full">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={searchTerm}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setTimeout(() => setIsFocused(false), 200)}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={placeholder}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent bg-white text-slate-700"
          />
        </div>
        {isFocused && (
          <div className="absolute z-20 w-full mt-1 bg-white border border-slate-300 rounded-md shadow-xl max-h-60 overflow-y-auto">
            <div className="p-2 space-y-1">
              {filtered.length > 0 ? (
                filtered.map((option) => (
                  <label
                    key={option}
                    className="flex items-center space-x-2 cursor-pointer p-2 rounded hover:bg-slate-50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked(option)}
                      onChange={() => handleMultiSelect(field, option, valueToStore(option))}
                      className="w-4 h-4 text-[#3C89C6] border-slate-300 rounded focus:ring-[#3C89C6]"
                    />
                    <span className="text-sm text-slate-700">{option}</span>
                  </label>
                ))
              ) : (
                <div className="p-3 text-sm text-slate-500 italic text-center">No matching results found</div>
              )}
            </div>
          </div>
        )}
        {safeSelected.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {safeSelected.map((value) => (
              <span
                key={value}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-[#3C89C6]/10 text-[#3C89C6] border border-[#3C89C6]/20"
              >
                {value}
                <button
                  type="button"
                  onClick={() => handleMultiSelect(field, value)}
                  className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-[#3C89C6] hover:text-white transition-colors"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!isClient) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff] flex items-center justify-center">
        <MeshBackground />
        <div className="relative animate-spin rounded-full h-12 w-12 border-b-2 border-[#3C89C6]"></div>
      </div>
    );
  }

  // Show loading until user + profile fetch is done (must be before profile === null check).
  if (!initialLoadDone) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative max-w-7xl mx-auto px-6 py-10 flex flex-col items-center justify-center min-h-[40vh] gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-300 border-t-[#3C89C6]"></div>
          <p className="text-slate-600 font-medium">Loading your profile…</p>
        </div>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
        <MeshBackground />
        <AppHeader />
        <div className="relative max-w-3xl mx-auto px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">No profile yet</h1>
          <p className="text-slate-600 mb-6">Create or save your company profile to see a summary here.</p>
          <button
            type="button"
            onClick={() => setProfile(getEmptyCompanyProfile())}
            className={"inline-flex px-6 py-3 " + btnPrimary}
          >
            Create profile
          </button>
        </div>
      </div>
    );
  }

  const hasAnyData =
    !!profile.companyName ||
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
    (profile.contractCount ?? 0) > 0 ||
    !!profile.totalPastContractValue ||
    !!profile.pastPerformance ||
    !!profile.strategicGoals ||
    (profile.uploadedFiles?.length ?? 0) > 0;

  const SectionHeader = ({
    title,
    sectionId,
  }: {
    title: string;
    sectionId: SectionId;
  }) => (
    <div className="flex items-start justify-between gap-4 mb-4">
      <h2 className={sectionTitleClass.replace(" mb-4", "")}>{title}</h2>
      {editingSection === sectionId ? (
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => {
            if (sectionId === "documents") {
              setProfile((prev) =>
                prev
                  ? { ...prev, uploadedFiles: (prev.uploadedFiles ?? []).filter((f) => f.parsed !== false) }
                  : null
              );
              setDupMessage("");
            }
            setEditingSection(null);
          }} className={btnSecondary}>
            Cancel
          </button>
          <button type="button" onClick={saveSection} disabled={sectionSaving} className={btnPrimary + " disabled:opacity-50"}>
            {sectionSaving ? (sectionId === "documents" ? "Parsing & Saving..." : "Saving...") : "Save"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={async () => {
            const ok = await ensureProfileLoaded();
            if (ok) setEditingSection(sectionId);
          }}
          disabled={loadingProfile}
          className={btnSecondary}
        >
          {loadingProfile ? "Loading…" : "Edit"}
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen relative overflow-hidden bg-[#f5f9ff]">
      <MeshBackground />
      <AppHeader />

      <div className="relative max-w-7xl mx-auto px-6 py-10 flex gap-10">
        {hasAnyData && (
          <aside className="hidden lg:block w-56 shrink-0">
            <nav className="sticky top-32">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Sections</p>
              <ul className="space-y-1">
                {PROFILE_SECTIONS.map(({ id, label }) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => scrollToSection(id)}
                      className="w-full text-left px-3 py-2 text-sm text-slate-700 rounded-md hover:bg-slate-100 hover:text-slate-900 transition-colors"
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}

        <div className="min-w-0 flex-1 max-w-4xl">
          <div className="mb-8 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 mb-2">Your profile</h1>
              <p className="text-slate-600">Click Edit on any section to change it here. Save updates your profile.</p>
            </div>
            {hasAnyData && (
              <Link
                href="/dashboard"
                className="shrink-0 w-full lg:w-auto flex items-center gap-3 p-4 rounded-lg border border-slate-200 bg-white hover:border-[#3C89C6]/40 hover:bg-slate-50/50 transition-colors group"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-md bg-[#3C89C6]/10 flex items-center justify-center">
                  <svg className="w-5 h-5 text-[#3C89C6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">View Matches</p>
                  <p className="text-sm text-slate-600">RFPs tailored to your profile</p>
                </div>
                <svg className="w-4 h-4 text-slate-400 group-hover:text-[#3C89C6] shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            )}
          </div>

          {!hasAnyData ? (
            <>
              <div className={sectionClass + " text-center text-slate-500"}>
                No data entered yet. <Link href="/profile" className="text-[#3C89C6] hover:underline">Create your profile</Link>.
              </div>
              <section id="section-account" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
                <h2 className={sectionTitleClass}>Account</h2>
                {currentUser ? (
                  <dl className="grid gap-4 sm:grid-cols-1 max-w-md">
                    <div>
                      <dt className="text-sm font-medium text-slate-500">Username</dt>
                      <dd className="mt-0.5 text-slate-900 font-medium">{currentUser.username}</dd>
                    </div>
                    {currentUser.email && (
                      <div>
                        <dt className="text-sm font-medium text-slate-500">Email</dt>
                        <dd className="mt-0.5 text-slate-700">{currentUser.email}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-sm font-medium text-slate-500">Account ID</dt>
                      <dd className="mt-0.5 text-slate-600 text-sm">{currentUser.user_id}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-slate-500 text-sm">Log in to see your account information.</p>
                )}
              </section>
            </>
          ) : (
            <div className="space-y-6">
              {/* Company Information */}
              <section id="section-company" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <SectionHeader title="Company Information" sectionId="company" />
              {editingSection === "company" ? (
                <div className="space-y-4">
                  <div>
                    <label className={labelClass}>Company Name *</label>
                    <input
                      type="text"
                      value={profile.companyName}
                      onChange={(e) => handleInputChange("companyName", e.target.value)}
                      className={inputClass}
                      placeholder="Enter your company name"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Industry *</label>
                    <SearchFirstDropdown
                      field="industry"
                      options={["Construction", "Consulting", "Education", "Engineering", "Healthcare", "IT Services", "Logistics", "Manufacturing", "Research & Development", "Security"]}
                      selectedValues={profile.industry ?? []}
                      placeholder="Type to search industries..."
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Business Size Status *</label>
                    <SearchFirstDropdown
                      field="sizeStatus"
                      options={["8(a) Business", "HUBZone", "Large Business", "Service-Disabled Veteran-Owned (SDVOSB)", "Small Business", "Small Disadvantaged Business (SDB)", "Veteran-Owned Small Business (VOSB)", "Women-Owned Small Business (WOSB)"]}
                      selectedValues={profile.sizeStatus ?? []}
                      placeholder="Type to search size status..."
                    />
                  </div>
                </div>
              ) : (
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
              )}
            </section>

            {/* Certifications & Clearances */}
            <section id="section-certifications" className={sectionClass}>
              <SectionHeader title="Certifications & Clearances" sectionId="certifications" />
              {editingSection === "certifications" ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Click to select certifications</p>
                    <SearchFirstDropdown
                      field="certifications"
                      options={["CMMI", "FedRAMP", "GSA Schedule", "HIPAA Compliance", "ISO 27001", "ISO 9001", "ITAR", "NAICS Codes", "NIST 800-53", "PCI DSS", "SOC 2"]}
                      selectedValues={profile.certifications ?? []}
                      placeholder="Type to search certifications..."
                    />
                  </div>
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Select security clearances</p>
                    <SearchFirstDropdown
                      field="clearances"
                      options={["Public Trust", "Secret", "Top Secret", "TS/SCI"]}
                      selectedValues={profile.clearances ?? []}
                      placeholder="Type to search clearances..."
                    />
                  </div>
                </div>
              ) : (
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
              )}
            </section>

            {/* NAICS & Geography */}
            <section id="section-naics" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <SectionHeader title="NAICS & Geography" sectionId="naics" />
              {editingSection === "naics" ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-slate-600 mb-2">NAICS codes</p>
                    <SearchFirstDropdown
                      field="naicsCodes"
                      options={NAICS_DISPLAY}
                      selectedValues={profile.naicsCodes ?? []}
                      placeholder="Type to search NAICS codes..."
                      getValueToStore={(opt) => (opt.includes(" - ") ? opt.split(" - ")[0].trim() : opt)}
                      isOptionSelected={(opt, sel) => {
                        const code = opt.includes(" - ") ? opt.split(" - ")[0].trim() : opt;
                        return sel.includes(code);
                      }}
                    />
                  </div>
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Work cities</p>
                    <SearchFirstDropdown
                      field="workCities"
                      options={CALIFORNIA_CITIES}
                      selectedValues={profile.workCities ?? []}
                      placeholder="Type to search cities..."
                    />
                  </div>
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Work counties</p>
                    <SearchFirstDropdown
                      field="workCounties"
                      options={CALIFORNIA_COUNTIES}
                      selectedValues={profile.workCounties ?? []}
                      placeholder="Type to search counties..."
                    />
                  </div>
                </div>
              ) : (
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
              )}
            </section>

            {/* Capabilities & Experience */}
            <section id="section-capabilities" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <SectionHeader title="Capabilities & Experience" sectionId="capabilities" />
              {editingSection === "capabilities" ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Core capabilities</p>
                    <SearchFirstDropdown
                      field="capabilities"
                      options={["AI/ML Services", "Cloud Services", "Cybersecurity", "Data Analytics", "Database Management", "DevOps", "Mobile Development", "Network Infrastructure", "Project Management", "Quality Assurance", "Software Development", "System Integration", "Technical Writing", "Training & Support", "Web Development"]}
                      selectedValues={profile.capabilities ?? []}
                      placeholder="Type to search capabilities..."
                    />
                  </div>
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Agency experience</p>
                    <SearchFirstDropdown
                      field="agencyExperience"
                      options={["California Dept of Forestry", "California Department of General Services", "California Department of Transportation", "City of Los Angeles", "City of Sacramento", "City of San Francisco", "County of Inyo", "State of California"]}
                      selectedValues={profile.agencyExperience ?? []}
                      placeholder="Type to search agencies..."
                    />
                  </div>
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Contract types</p>
                    <SearchFirstDropdown
                      field="contractTypes"
                      options={["BPA (Blanket Purchase Agreement)", "Competitive", "Cost Plus", "Fixed Price", "GSA Schedule", "IDIQ (Indefinite Delivery)", "Multi-year", "Small Business Set-Aside", "Sole Source", "Time & Materials"]}
                      selectedValues={profile.contractTypes ?? []}
                      placeholder="Type to search contract types..."
                    />
                  </div>
                </div>
              ) : (
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
              )}
            </section>

            {/* Contract History */}
            <section id="section-contract" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <SectionHeader title="Contract History" sectionId="contract" />
              {editingSection === "contract" ? (
                <div className="space-y-4">
                  <div>
                    <label className={labelClass}>Contract Count</label>
                    <input
                      type="number"
                      min={0}
                      value={profile.contractCount ?? 0}
                      onChange={(e) => handleInputChange("contractCount", parseInt(e.target.value) || 0)}
                      className={inputClass}
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Total Past Contract Value</label>
                    <input
                      type="text"
                      value={profile.totalPastContractValue ?? ""}
                      onChange={(e) => handleInputChange("totalPastContractValue", e.target.value)}
                      className={inputClass}
                      placeholder="e.g., 1500000 or $1,500,000"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Past Performance</label>
                    <textarea
                      value={profile.pastPerformance ?? ""}
                      onChange={(e) => handleInputChange("pastPerformance", e.target.value)}
                      className={inputClass + " min-h-[100px]"}
                      placeholder="Describe past performance..."
                      rows={4}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Strategic Goals</label>
                    <textarea
                      value={profile.strategicGoals ?? ""}
                      onChange={(e) => handleInputChange("strategicGoals", e.target.value)}
                      className={inputClass + " min-h-[100px]"}
                      placeholder="Describe strategic goals..."
                      rows={4}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Contract count</p>
                    <p className="text-slate-900">{profile.contractCount ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total past contract value</p>
                    <p className="text-slate-900">{profile.totalPastContractValue || "—"}</p>
                  </div>
                  {(profile.pastPerformance || profile.strategicGoals) && (
                    <>
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
                    </>
                  )}
                </div>
              )}
            </section>

            {/* Uploaded Documents - always show so user can add files */}
            <section id="section-documents" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <SectionHeader title="Uploaded Documents" sectionId="documents" />
              {editingSection === "documents" ? (
                <div className="space-y-4">
                  <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-[#3C89C6] transition-colors">
                    <input type="file" id="profile-file-upload" multiple accept=".pdf,.doc,.docx,.txt" onChange={handleFileUpload} className="hidden" />
                    <label htmlFor="profile-file-upload" className="cursor-pointer flex flex-col items-center">
                      <svg className="w-12 h-12 text-slate-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <span className="text-sm font-medium text-slate-700">Click to upload files</span>
                      <span className="text-xs text-slate-500 mt-1">PDF, DOC, DOCX, TXT</span>
                    </label>
                  </div>
                  {profile.uploadedFiles && profile.uploadedFiles.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <h3 className="text-sm font-medium text-slate-700 mb-2">
                        Uploaded Files ({profile.uploadedFiles.filter((f) => !pendingRemovals.includes(f.contractId || f.name)).length})
                      </h3>
                      {profile.uploadedFiles.map((file, index) => {
                        if (pendingRemovals.includes(file.contractId || file.name)) return null;
                        return (
                          <div key={index} className="flex items-center justify-between p-3 bg-slate-50 rounded-md">
                            <div className="flex items-center space-x-3">
                              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium text-slate-900">{file.name}</p>
                                  {file.parsed && (
                                    <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">Parsed</span>
                                  )}
                                  {!file.parsed && (
                                    <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">New</span>
                                  )}
                                </div>
                              <p className="text-xs text-slate-500">{file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString() : ""}</p>
                            </div>
                          </div>
                          <button type="button" onClick={() => removeFile(index)} className="text-red-600 hover:text-red-700 text-sm font-medium">
                            Remove
                          </button>
                        </div>
                      ))}
                      {dupMessage && (
                        <p className="text-sm text-amber-600 mt-2">{dupMessage}</p>
                      )}
                    </div>
                  )}
                </div>
              ) : (profile.uploadedFiles?.length ?? 0) > 0 ? (
                <ul className="space-y-2">
                  {profile.uploadedFiles?.map((file, i) => (
                    <li key={i} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                      <span className="text-slate-700 font-medium">{file.name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-500 italic text-sm">No documents uploaded. Click Edit to add files.</p>
              )}
            </section>

            {/* Account information (from logged-in session) */}
            <section id="section-account" className={sectionClass} style={{ scrollMarginTop: "128px" }}>
              <h2 className={sectionTitleClass}>Account</h2>
              {currentUser ? (
                <dl className="grid gap-4 sm:grid-cols-1 max-w-md">
                  <div>
                    <dt className="text-sm font-medium text-slate-500">Username</dt>
                    <dd className="mt-0.5 text-slate-900 font-medium">{currentUser.username}</dd>
                  </div>
                  {currentUser.email && (
                    <div>
                      <dt className="text-sm font-medium text-slate-500">Email</dt>
                      <dd className="mt-0.5 text-slate-700">{currentUser.email}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-sm font-medium text-slate-500">Account ID</dt>
                    <dd className="mt-0.5 text-slate-600 text-sm">{currentUser.user_id}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-slate-500 text-sm">Log in to see your account information.</p>
              )}
            </section>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
