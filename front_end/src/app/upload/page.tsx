"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getApiBase, getAuthToken, uploadContractDocument } from "@/lib/api";

interface ExtractedData {
  companyName: string;
  industry: string[];
  sizeStatus: string[];
  certifications: string[];
  capabilities: string[];
  contractTypes: string[];
  clearances: string[];
  naicsCodes: string[];
  workCities: string[];
  workCounties: string[];
  agencyExperience: string[];
  contractCount: number;
  totalPastContractValue: string;
  pastPerformance: string;
  strategicGoals: string;
}

// Remove the old helper functions - they're no longer needed
// The backend handles all the extraction logic

export default function UploadPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dupMessage, setDupMessage] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(true);

  useEffect(() => {
    setIsLoggedIn(!!getAuthToken());
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles) return;

    const fileArray = Array.from(selectedFiles);
    setDupMessage("");
    setFiles((prev) => {
      const existingNames = new Set(prev.map((f) => f.name));
      const newFiles = fileArray.filter((f) => !existingNames.has(f.name));
      const skipped = fileArray.length - newFiles.length;
      if (skipped > 0) {
        setDupMessage(`${skipped} duplicate file(s) already uploaded — skipped.`);
      }
      return [...prev, ...newFiles];
    });
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Call backend API to parse documents
  const parseDocumentsWithBackend = async (files: File[]): Promise<ExtractedData> => {
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
          // Include details if available
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
          // If response isn't JSON, use status text
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
      // Handle network errors (backend not running, CORS, etc.)
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error(
          `Cannot connect to backend server. Please make sure the Django server is running at ${getApiBase()}.`
        );
      }
      throw error;
    }
  };

  // All extraction logic is now handled by the backend API

  const handleProcess = async () => {
    if (files.length === 0) {
      alert("Please upload at least one document");
      return;
    }

    setIsProcessing(true);
    setProgress(0);

    try {
      const isLoggedIn = !!getAuthToken();
      if (isLoggedIn) {
        setProgress(10);
        for (let i = 0; i < files.length; i++) {
          await uploadContractDocument(files[i], files[i].name);
          setProgress(10 + Math.round((40 * (i + 1)) / files.length));
        }
      }

      setProgress(50);
      const extractedData = await parseDocumentsWithBackend(files);
      setProgress(90);

      const fileInfo = files.map((file) => ({
        name: file.name,
        type: file.type || "application/octet-stream",
        uploadedAt: new Date().toISOString(),
        parsed: true,
      }));

      const profileData = {
        ...extractedData,
        uploadedFiles: fileInfo,
      };

      localStorage.setItem("companyProfile", JSON.stringify(profileData));
      localStorage.setItem("uploadedFiles", JSON.stringify(fileInfo.map((f) => ({ ...f, content: "" }))));

      setProgress(100);

      setTimeout(() => {
        router.push("/profile");
      }, 500);
    } catch (error) {
      console.error("Error processing files:", error);
      alert(`Error processing files: ${error instanceof Error ? error.message : "Unknown error"}. Please try again.`);
    } finally {
      setIsProcessing(false);
      setProgress(0);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="sticky top-0 bg-white border-b border-slate-200 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-2">
              <img src="/logo.png" alt="Civitas logo" className="h-12 w-12" />
              <span className="text-2xl font-bold text-slate-900">Civitas</span>
            </Link>
          <Link
            href="/profile"
            className="px-4 py-2 bg-[#3C89C6] text-white font-medium rounded-md hover:bg-[#2d6fa0] transition-colors"
          >
            Save Profile
          </Link>
        </div>
      </nav>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            Upload Your Past Contracts & Documents
          </h1>
          <p className="text-slate-600">
            Our AI will analyze your documents to automatically fill in your
            company profile details.
          </p>
          {!isLoggedIn && (
            <p className="text-amber-700 text-sm mt-2">
              Log in to save documents to your profile (stored in your account so they sync across devices).
            </p>
          )}
        </div>

        {/* Upload Area */}
        <div className="bg-white rounded-lg border border-slate-200 p-8 mb-6">
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-12 text-center hover:border-[#3C89C6] transition-colors">
            <input
              type="file"
              id="file-upload"
              multiple
              accept=".pdf,.doc,.docx,.txt"
              onChange={handleFileUpload}
              className="hidden"
              disabled={isProcessing}
            />
            <label
              htmlFor="file-upload"
              className={`cursor-pointer flex flex-col items-center ${
                isProcessing ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              <svg
                className="w-16 h-16 text-slate-400 mb-4"
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
              <span className="text-lg font-medium text-slate-700 mb-2">
                Click to upload files
              </span>
              <span className="text-sm text-slate-500">
                PDF, DOC, DOCX, TXT (Multiple files supported)
              </span>
            </label>
          </div>

          {/* Uploaded Files List */}
          {files.length > 0 && (
            <div className="mt-6 space-y-2">
              <h3 className="text-sm font-medium text-slate-700 mb-2">
                Uploaded Files ({files.length})
              </h3>
              {files.map((file, index) => (
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
                    </div>
                  </div>
                  {!isProcessing && (
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="text-red-600 hover:text-red-700 text-sm font-medium"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {dupMessage && (
                <p className="text-sm text-amber-600 mt-2">{dupMessage}</p>
              )}
            </div>
          )}

          {/* Processing Progress */}
          {isProcessing && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-700">
                  Processing documents..
                </span>
                <span className="text-sm text-slate-500">{progress}%</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2">
                <div
                  className="bg-[#3C89C6] h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>

        {/* Process Button */}
        <div className="flex justify-center">
          <button
            onClick={handleProcess}
            disabled={files.length === 0 || isProcessing}
            className={`px-8 py-3 rounded-md font-medium transition-colors ${
              files.length === 0 || isProcessing
                ? "bg-slate-300 text-slate-500 cursor-not-allowed"
                : "bg-[#3C89C6] text-white hover:bg-[#2d6fa0]"
            } focus:outline-none focus:ring-2 focus:ring-[#3C89C6] focus:ring-offset-2`}
          >
            {isProcessing ? "Processing..." : "Process Documents & Continue"}
          </button>
        </div>

        {/* Skip Option */}
        {!isProcessing && (
          <div className="text-center mt-4">
            <button
              onClick={() => router.push("/profile")}
              className="text-sm text-slate-600 hover:text-slate-900 underline"
            >
              Skip and fill out manually
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
