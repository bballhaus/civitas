"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

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
  uploadedFiles: Array<{
    name: string;
    type: string;
    size: number;
    uploadedAt: string;
    parsed?: boolean;
  }>;
}

export default function ProfileSetup() {
  const searchParams = useSearchParams();
  const isPrefilled = searchParams.get("prefilled") === "true";

  const [profile, setProfile] = useState<CompanyProfile>({
    companyName: "",
    industry: [],
    sizeStatus: [],
    certifications: [],
    clearances: [],
    naicsCodes: [],
    workCities: [],
    workCounties: [],
    capabilities: [],
    agencyExperience: [],
    contractTypes: [],
    contractCount: 0,
    totalPastContractValue: "",
    pastPerformance: "",
    strategicGoals: "",
    uploadedFiles: [],
  });

  const [isSaved, setIsSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);


  // Load profile from local storage on mount
  useEffect(() => {
    // First, check if we have extracted data from upload page
    if (isPrefilled) {
      const extracted = localStorage.getItem("extractedProfileData");
      const uploadedFiles = localStorage.getItem("uploadedFiles");

      if (extracted) {
        try {
          const parsed = JSON.parse(extracted);
          const fileInfo = uploadedFiles
            ? JSON.parse(uploadedFiles).map((file: any) => ({
                ...file,
                parsed: true, // Mark files from upload page as already parsed
              }))
            : [];

          // Merge extracted data with existing profile structure
          setProfile({
            companyName: parsed.companyName || "",
            industry: Array.isArray(parsed.industry) ? parsed.industry : [],
            sizeStatus: Array.isArray(parsed.sizeStatus)
              ? parsed.sizeStatus
              : [],
            certifications: Array.isArray(parsed.certifications)
              ? parsed.certifications
              : [],
            clearances: Array.isArray(parsed.clearances) ? parsed.clearances : [],
            naicsCodes: Array.isArray(parsed.naicsCodes) ? parsed.naicsCodes : [],
            workCities: Array.isArray(parsed.workCities) ? parsed.workCities : [],
            workCounties: Array.isArray(parsed.workCounties) ? parsed.workCounties : [],
            capabilities: Array.isArray(parsed.capabilities)
              ? parsed.capabilities
              : [],
            agencyExperience: Array.isArray(parsed.agencyExperience)
              ? parsed.agencyExperience
              : [],
            contractTypes: Array.isArray(parsed.contractTypes)
              ? parsed.contractTypes
              : [],
            contractCount: parsed.contractCount || 0,
            totalPastContractValue: parsed.totalPastContractValue || "",
            pastPerformance: parsed.pastPerformance || "",
            strategicGoals: parsed.strategicGoals || "",
            uploadedFiles: fileInfo,
          });

          // Clear the extracted data flag so it doesn't reload on refresh
          // localStorage.removeItem("extractedProfileData");
          return;
        } catch (e) {
          console.error("Error loading extracted data:", e);
        }
      }
    }

    // Otherwise, load saved profile
    const saved = localStorage.getItem("companyProfile");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Migrate old data: if industry is a string, convert to array
        if (parsed.industry && typeof parsed.industry === "string") {
          parsed.industry = parsed.industry ? [parsed.industry] : [];
        }
        // Migrate old data: if sizeStatus is a string, convert to array
        if (parsed.sizeStatus && typeof parsed.sizeStatus === "string") {
          parsed.sizeStatus = parsed.sizeStatus ? [parsed.sizeStatus] : [];
        }
        // Ensure all array fields are arrays
        if (!Array.isArray(parsed.industry)) parsed.industry = [];
        if (!Array.isArray(parsed.sizeStatus)) parsed.sizeStatus = [];
        if (!Array.isArray(parsed.certifications)) parsed.certifications = [];
        if (!Array.isArray(parsed.clearances)) parsed.clearances = [];
        if (!Array.isArray(parsed.naicsCodes)) parsed.naicsCodes = [];
        if (!Array.isArray(parsed.workCities)) parsed.workCities = [];
        if (!Array.isArray(parsed.workCounties)) parsed.workCounties = [];
        if (!Array.isArray(parsed.capabilities)) parsed.capabilities = [];
        if (!Array.isArray(parsed.agencyExperience)) parsed.agencyExperience = [];
        if (!Array.isArray(parsed.contractTypes)) parsed.contractTypes = [];
        // Ensure numeric fields
        if (typeof parsed.contractCount !== 'number') parsed.contractCount = 0;
        if (typeof parsed.totalPastContractValue !== 'string') parsed.totalPastContractValue = "";
        setProfile(parsed);
      } catch (e) {
        console.error("Error loading profile:", e);
      }
    }
  }, [isPrefilled]);

  // Parse documents with backend API
  const parseDocumentsWithBackend = async (files: File[]): Promise<any> => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("documents", file);
    });

    try {
      const response = await fetch("http://localhost:8000/api/profile/extract/", {
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
          "Cannot connect to backend server. Please make sure the Django server is running on http://localhost:8000"
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

  // Save to local storage and parse new documents
  const saveProfile = async () => {
    setIsSaving(true);
    try {
      // Check for unparsed files
      const unparsedFiles = profile.uploadedFiles.filter(file => !file.parsed);
      
      if (unparsedFiles.length > 0) {
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
          mergedProfile.uploadedFiles = mergedProfile.uploadedFiles.map(file => 
            unparsedFiles.some(uf => uf.name === file.name) 
              ? { ...file, parsed: true }
              : file
          );
          
          // Update profile state
          setProfile(mergedProfile);
          
          // Save merged profile
          localStorage.setItem("companyProfile", JSON.stringify(mergedProfile));
        } else {
          // No files to parse, just save
          localStorage.setItem("companyProfile", JSON.stringify(profile));
        }
      } else {
        // No unparsed files, just save
        localStorage.setItem("companyProfile", JSON.stringify(profile));
      }

      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 3000);
    } catch (error) {
      console.error("Error saving profile:", error);
      alert(`Error saving profile: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleInputChange = (field: keyof CompanyProfile, value: any) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  const handleMultiSelect = (
    field: "industry" | "sizeStatus" | "certifications" | "clearances" | "naicsCodes" | "workCities" | "workCounties" | "capabilities" | "agencyExperience" | "contractTypes",
    value: string
  ) => {
    setProfile((prev) => {
      const current = prev[field];
      const updated = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      return { ...prev, [field]: updated };
    });
  };


  // Search-First Multi-Select Component
  const SearchFirstDropdown = ({
    field,
    options,
    selectedValues,
    label,
    placeholder,
  }: {
    field: "industry" | "sizeStatus" | "certifications" | "clearances" | "naicsCodes" | "workCities" | "workCounties" | "capabilities" | "agencyExperience" | "contractTypes";
    options: string[];
    selectedValues: string[];
    label: string;
    placeholder: string;
  }) => {
    const [searchTerm, setSearchTerm] = useState("");
    const [isFocused, setIsFocused] = useState(false);
    
    const safeSelectedValues = Array.isArray(selectedValues) ? selectedValues : [];

    // Filter options based on search term
    const filteredOptions = options.filter((option) =>
      option.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
      <div className="relative w-full">
        {/* The Search Bar is now the Trigger */}
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
            onBlur={() => setTimeout(() => setIsFocused(false), 200)} // Delay to allow checkbox clicks
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={placeholder}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent bg-white text-slate-700"
          />
        </div>

        {/* Results appear when focused or typing */}
        {isFocused && (
          <div className="absolute z-20 w-full mt-1 bg-white border border-slate-300 rounded-md shadow-xl max-h-60 overflow-y-auto">
            <div className="p-2 space-y-1">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option) => (
                  <label
                    key={option}
                    className="flex items-center space-x-2 cursor-pointer p-2 rounded hover:bg-slate-50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={safeSelectedValues.includes(option)}
                      onChange={() => handleMultiSelect(field, option)}
                      className="w-4 h-4 text-[#3C89C6] border-slate-300 rounded focus:ring-[#3C89C6]"
                    />
                    <span className="text-sm text-slate-700">{option}</span>
                  </label>
                ))
              ) : (
                <div className="p-3 text-sm text-slate-500 italic text-center">
                  No matching results found
                </div>
              )}
            </div>
          </div>
        )}

        {/* Selected "Chips" stay visible below */}
        {safeSelectedValues.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {safeSelectedValues.map((value) => (
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
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const fileInfo = {
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        uploadedAt: new Date().toISOString(),
        parsed: false, // Mark as unparsed
      };

      setProfile((prev) => ({
        ...prev,
        uploadedFiles: [...prev.uploadedFiles, fileInfo],
      }));

      // Store file content in local storage (as base64 for small files)
      // Note: For large files, you might want to use IndexedDB instead
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const fileData = {
            ...fileInfo,
            content: event.target.result as string,
          };
          const existingFiles = JSON.parse(
            localStorage.getItem("uploadedFiles") || "[]"
          );
          existingFiles.push(fileData);
          localStorage.setItem("uploadedFiles", JSON.stringify(existingFiles));
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (index: number) => {
    setProfile((prev) => ({
      ...prev,
      uploadedFiles: prev.uploadedFiles.filter((_, i) => i !== index),
    }));

    // Also remove from local storage
    const existingFiles = JSON.parse(
      localStorage.getItem("uploadedFiles") || "[]"
    );
    existingFiles.splice(index, 1);
    localStorage.setItem("uploadedFiles", JSON.stringify(existingFiles));
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png"
              alt="Civitas logo"
              className="h-12 w-12"
            />
            <span className="text-2xl font-bold text-slate-900">Civitas</span>
          </div>
          <button
            onClick={() => (window.location.href = "/")}
            className="px-4 py-2 text-sm border rounded-md hover:bg-slate-50"
          >
            Back to Home
          </button>
        </div>
      </nav>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            Create Your Company Profile
          </h1>
          <p className="text-slate-600">
            Tell us about your company so we can match you with the right
            government contracts.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveProfile();
          }}
          className="space-y-8"
        >
          {/* Company Information */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Company Information
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Company Name *
                </label>
                <input
                  type="text"
                  required
                  value={profile.companyName}
                  onChange={(e) =>
                    handleInputChange("companyName", e.target.value)
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-500"
                  placeholder="Enter your company name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Industry *
                </label>
             
                <SearchFirstDropdown
                  field="industry"
                  options={[
                    "Construction",
                    "Consulting",
                    "Education",
                    "Engineering",
                    "Healthcare",
                    "IT Services",
                    "Logistics",
                    "Manufacturing",
                    "Research & Development",
                    "Security",
                  ]}
                  selectedValues={profile.industry}
                  label="Industries"
                  placeholder="Type to search industries..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Business Size Status *
                </label>
       
                <SearchFirstDropdown
                  field="sizeStatus"
                  options={[
                    "8(a) Business",
                    "HUBZone",
                    "Large Business",
                    "Service-Disabled Veteran-Owned (SDVOSB)",
                    "Small Business",
                    "Small Disadvantaged Business (SDB)",
                    "Veteran-Owned Small Business (VOSB)",
                    "Women-Owned Small Business (WOSB)",
                  ]}
                  selectedValues={profile.sizeStatus}
                  label="Size Status"
                  placeholder="Type to search size status..."
                />
              </div>
            </div>
          </section>

          {/* Certifications */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Certifications & Qualifications
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Click to select certifications
            </p>

            <SearchFirstDropdown
              field="certifications"
              options={[
                "CMMI",
                "FedRAMP",
                "GSA Schedule",
                "HIPAA Compliance",
                "ISO 27001",
                "ISO 9001",
                "ITAR",
                "NAICS Codes",
                "NIST 800-53",
                "PCI DSS",
                "SOC 2",
              ]}
              selectedValues={profile.certifications}
              label="Certifications"
              placeholder="Type to search certifications..."
            />
          </section>

          {/* Clearances */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Security Clearances
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select all security clearances your company holds
            </p>
            <SearchFirstDropdown
              field="clearances"
              options={[
                "Public Trust",
                "Secret",
                "Top Secret",
                "TS/SCI",
              ]}
              selectedValues={profile.clearances}
              label="Clearances"
              placeholder="Type to search clearances..."
            />
          </section>

          {/* NAICS Codes */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              NAICS Codes
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Enter NAICS codes (North American Industry Classification System)
            </p>
            <SearchFirstDropdown
              field="naicsCodes"
              options={[
                "236220",
                "541330",
                "541511",
                "541512",
                "541519",
                "541611",
                "541690",
              ]}
              selectedValues={profile.naicsCodes}
              label="NAICS Codes"
              placeholder="Type to search NAICS codes..."
            />
            <p className="text-xs text-slate-500 mt-2">
              You can also type custom NAICS codes
            </p>
          </section>

          {/* Work Locations - Cities */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Work Cities
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select cities where you have worked or can work
            </p>
            <SearchFirstDropdown
              field="workCities"
              options={[
                "Anaheim",
                "Bakersfield",
                "Fresno",
                "Long Beach",
                "Los Angeles",
                "Oakland",
                "Sacramento",
                "San Diego",
                "San Francisco",
                "San Jose",
              ]}
              selectedValues={profile.workCities}
              label="Work Cities"
              placeholder="Type to search cities..."
            />
          </section>

          {/* Work Locations - Counties */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Work Counties
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select counties where you have worked or can work
            </p>
            <SearchFirstDropdown
              field="workCounties"
              options={[
                "Alameda",
                "Contra Costa",
                "Fresno",
                "Los Angeles",
                "Orange",
                "Riverside",
                "Sacramento",
                "San Bernardino",
                "San Diego",
                "San Francisco",
                "San Mateo",
                "Santa Clara",
                "Ventura",
              ]}
              selectedValues={profile.workCounties}
              label="Work Counties"
              placeholder="Type to search counties..."
            />
          </section>

          {/* Agency Experience */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Agency Experience
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select government agencies you have worked with
            </p>
            <SearchFirstDropdown
              field="agencyExperience"
              options={[
                "California Dept of Forestry",
                "California Department of General Services",
                "California Department of Transportation",
                "City of Los Angeles",
                "City of Sacramento",
                "City of San Francisco",
                "County of Inyo",
                "State of California",
              ]}
              selectedValues={profile.agencyExperience}
              label="Agency Experience"
              placeholder="Type to search agencies..."
            />
          </section>

          {/* Contract Statistics */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Contract Statistics
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Contract Count
                </label>
                <input
                  type="number"
                  min="0"
                  value={profile.contractCount}
                  onChange={(e) =>
                    handleInputChange("contractCount", parseInt(e.target.value) || 0)
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Total Past Contract Value
                </label>
                <input
                  type="text"
                  value={profile.totalPastContractValue}
                  onChange={(e) =>
                    handleInputChange("totalPastContractValue", e.target.value)
                  }
                  className="w-full px-4 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:border-transparent text-slate-500"
                  placeholder="e.g., 1500000 or $1,500,000"
                />
              </div>
            </div>
          </section>

          {/* Capabilities */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Core Capabilities
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select all capabilities your company offers
            </p>

            <SearchFirstDropdown
              field="capabilities"
              options={[
                "AI/ML Services",
                "Cloud Services",
                "Cybersecurity",
                "Data Analytics",
                "Database Management",
                "DevOps",
                "Mobile Development",
                "Network Infrastructure",
                "Project Management",
                "Quality Assurance",
                "Software Development",
                "System Integration",
                "Technical Writing",
                "Training & Support",
                "Web Development",
              ]}
              selectedValues={profile.capabilities}
              label="Capabilities"
              placeholder="Type to search capabilities..."
            />
          </section>

          {/* Contract Types */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Types of Contracts You Pursue
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Select all contract types you're interested in
            </p>

            <SearchFirstDropdown
              field="contractTypes"
              options={[
                "BPA (Blanket Purchase Agreement)",
                "Competitive",
                "Cost Plus",
                "Fixed Price",
                "GSA Schedule",
                "IDIQ (Indefinite Delivery)",
                "Multi-year",
                "Small Business Set-Aside",
                "Sole Source",
                "Time & Materials",
              ]}
              selectedValues={profile.contractTypes}
              label="Contract Types"
              placeholder="Type to search contract types..."
            />
          </section>

       
        
          {/* File Upload */}
          <section className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">
              Upload Documents for Analysis
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              Upload past contracts, proposals, or other relevant documents
            </p>

            <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-[#3C89C6] transition-colors">
              <input
                type="file"
                id="file-upload"
                multiple
                accept=".pdf,.doc,.docx,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
              <label
                htmlFor="file-upload"
                className="cursor-pointer flex flex-col items-center"
              >
                <svg
                  className="w-12 h-12 text-slate-400 mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <span className="text-sm font-medium text-slate-700">
                  Click to upload files
                </span>
                <span className="text-xs text-slate-500 mt-1">
                  PDF, DOC, DOCX, TXT (Max 10MB per file)
                </span>
              </label>
            </div>

            {/* Uploaded Files List */}
            {profile.uploadedFiles.length > 0 && (
              <div className="mt-6 space-y-2">
                <h3 className="text-sm font-medium text-slate-700 mb-2">
                  Uploaded Files ({profile.uploadedFiles.length})
                </h3>
                {profile.uploadedFiles.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-md"
                  >
                    <div className="flex items-center space-x-3">
                      <svg
                        className="w-5 h-5 text-slate-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {file.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {(file.size / 1024).toFixed(2)} KB
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="text-red-600 hover:text-red-700 text-sm font-medium"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Save Button */}
          <div className="flex items-center justify-between pt-6 border-t border-slate-200">
            <div>
              {isSaved && (
                <p className="text-sm text-green-600 font-medium">
                  ✓ Profile saved successfully!
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={isSaving}
              className="px-6 py-3 bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  <span>Processing...</span>
                </>
              ) : (
                "Save Profile"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
