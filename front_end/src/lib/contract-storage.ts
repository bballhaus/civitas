/**
 * Contract CRUD operations using S3.
 * Port of back_end/contracts/services/contract_storage.py.
 *
 * Files stored at uploads/{userId}/{contractId}/{filename} in S3.
 * Contract metadata stored in users/{username}.json → profile.uploaded_documents[].
 */
import { uploadFile, deleteObject, getDocumentUrl, getBucket } from "./s3";
import { getUserData, saveUserData, getUserUploadPrefix, type StoredContract } from "./user-data";

function generateContractId(): string {
  // Match Django's uuid4().hex format (32 hex chars)
  return crypto.randomUUID().replace(/-/g, "");
}

function s3Key(uploadPrefix: string, contractId: string, filename: string): string {
  let base = (filename || "document").replace(/ /g, "_");
  if (!base.toLowerCase().endsWith(".pdf") && !base.includes(".")) {
    base = `${base}.pdf`;
  }
  return `${uploadPrefix}/${contractId}/${base}`;
}

function storedToContract(stored: Record<string, unknown>, username: string): StoredContract {
  if (!stored) return null as unknown as StoredContract;
  const cid = (stored.id as string) || (stored.contract_id as string) || "";
  const docKey = stored.document_s3_key as string | null;
  const docUrl = (stored.document as string) || (docKey ? getDocumentUrl(docKey) : "");

  return {
    id: cid,
    contract_id: cid,
    title: (stored.title as string) || "",
    contractor_name: (stored.contractor_name as string) || "",
    document: docUrl,
    document_s3_key: docKey || null,
    rfp_id: (stored.rfp_id as string) || "",
    issuing_agency: (stored.issuing_agency as string) || "",
    jurisdiction_state: (stored.jurisdiction_state as string) || "CA",
    jurisdiction_county: (stored.jurisdiction_county as string) || "",
    jurisdiction_city: (stored.jurisdiction_city as string) || "",
    required_certifications: (stored.required_certifications as string[]) || [],
    required_clearances: (stored.required_clearances as string[]) || [],
    onsite_required: (stored.onsite_required as boolean) ?? null,
    work_locations: (stored.work_locations as string[]) || [],
    naics_codes: (stored.naics_codes as string[]) || [],
    industry_tags: (stored.industry_tags as string[]) || [],
    min_past_performance: (stored.min_past_performance as string) || "",
    contract_value_estimate: (stored.contract_value_estimate as string) || "",
    timeline_duration: (stored.timeline_duration as string) || "",
    work_description: (stored.work_description as string) || "",
    technology_stack: (stored.technology_stack as string[]) || [],
    scope_keywords: (stored.scope_keywords as string[]) || [],
    contract_type: (stored.contract_type as string) || "",
    size_status: (stored.size_status as string[]) || [],
    award_date: (stored.award_date as string) || "",
    start_date: (stored.start_date as string) || "",
    end_date: (stored.end_date as string) || "",
    created_at: (stored.created_at as string) || "",
    updated_at: (stored.updated_at as string) || "",
  };
}

function contractToStored(c: Record<string, unknown>, contractId: string): Record<string, unknown> {
  return {
    id: contractId,
    contract_id: contractId,
    title: c.title || "",
    contractor_name: c.contractor_name || "",
    document: c.document || "",
    document_s3_key: c.document_s3_key || null,
    rfp_id: c.rfp_id || "",
    issuing_agency: c.issuing_agency || "",
    jurisdiction_state: c.jurisdiction_state || "CA",
    jurisdiction_county: c.jurisdiction_county || "",
    jurisdiction_city: c.jurisdiction_city || "",
    required_certifications: (c.required_certifications as string[]) || [],
    required_clearances: (c.required_clearances as string[]) || [],
    onsite_required: c.onsite_required ?? null,
    work_locations: (c.work_locations as string[]) || [],
    naics_codes: (c.naics_codes as string[]) || [],
    industry_tags: (c.industry_tags as string[]) || [],
    min_past_performance: c.min_past_performance || "",
    contract_value_estimate: c.contract_value_estimate || "",
    timeline_duration: c.timeline_duration || "",
    work_description: c.work_description || "",
    technology_stack: (c.technology_stack as string[]) || [],
    scope_keywords: (c.scope_keywords as string[]) || [],
    contract_type: c.contract_type || "",
    size_status: (c.size_status as string[]) || [],
    award_date: c.award_date || "",
    start_date: c.start_date || "",
    end_date: c.end_date || "",
    created_at: c.created_at || "",
    updated_at: c.updated_at || "",
  };
}

async function getContractsList(
  username: string
): Promise<{ docs: Record<string, unknown>[]; data: Record<string, unknown> }> {
  const data = (await getUserData(username)) as Record<string, unknown> | null;
  if (!data) return { docs: [], data: {} };
  const profile = (data.profile as Record<string, unknown>) || {};
  const docs = (profile.uploaded_documents as Record<string, unknown>[]) || [];
  return { docs, data };
}

async function saveContractsList(
  username: string,
  contractsList: Record<string, unknown>[]
): Promise<boolean> {
  const data = ((await getUserData(username)) as Record<string, unknown>) || {};
  const profile = (data.profile as Record<string, unknown>) || {};
  profile.uploaded_documents = contractsList;
  data.profile = profile;
  await saveUserData(username, data as any);
  return true;
}

// ── Public API ──

export async function listContracts(username: string): Promise<StoredContract[]> {
  const { docs } = await getContractsList(username);
  const out = docs
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => storedToContract(d, username));
  out.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return out;
}

export async function getContract(
  username: string,
  contractId: string
): Promise<StoredContract | null> {
  const { docs } = await getContractsList(username);
  for (const d of docs) {
    if (typeof d !== "object" || !d) continue;
    const cid = (d.id as string) || (d.contract_id as string);
    if (cid === contractId) return storedToContract(d, username);
  }
  return null;
}

export async function createContract(
  username: string,
  metadata: Record<string, unknown>,
  fileBuffer?: Buffer,
  fileName?: string,
  contentType?: string
): Promise<StoredContract | null> {
  if (!getBucket()) {
    console.warn("Contract storage unavailable: AWS_S3_BUCKET not set");
    return null;
  }

  const userData = await getUserData(username);
  if (!userData) {
    console.warn(`Contract storage: no user data for username=${username}`);
    return null;
  }

  try {
    const contractId = generateContractId();
    const now = new Date().toISOString();
    const meta: Record<string, unknown> = { ...metadata };
    meta.created_at = meta.created_at || now;
    meta.updated_at = now;
    meta.issuing_agency = meta.issuing_agency || "Unknown";

    let s3KeyValue: string | null = null;
    if (fileBuffer && fileName) {
      const uploadPrefix = getUserUploadPrefix(userData, username);
      const key = s3Key(uploadPrefix, contractId, fileName);
      const ok = await uploadFile(key, fileBuffer, contentType || "application/pdf");
      if (!ok) {
        console.warn(`createContract: S3 upload failed for username=${username}`);
        return null;
      }
      s3KeyValue = key;
    }

    meta.document_s3_key = s3KeyValue;
    meta.document = s3KeyValue ? getDocumentUrl(s3KeyValue) : "";
    meta.created_at = now;
    meta.updated_at = now;

    const stored = contractToStored(meta, contractId);
    stored.id = contractId;
    stored.contract_id = contractId;

    const { docs } = await getContractsList(username);
    const updatedDocs = [...docs, stored];
    await saveContractsList(username, updatedDocs);

    return storedToContract(stored, username);
  } catch (err) {
    console.error(`createContract failed for username=${username}:`, err);
    return null;
  }
}

export async function updateContract(
  username: string,
  contractId: string,
  metadata: Record<string, unknown>,
  fileBuffer?: Buffer,
  fileName?: string,
  contentType?: string
): Promise<StoredContract | null> {
  const { docs } = await getContractsList(username);
  const idx = docs.findIndex((d) => {
    if (typeof d !== "object" || !d) return false;
    return (d.id as string) === contractId || (d.contract_id as string) === contractId;
  });
  if (idx === -1) return null;

  const existing = storedToContract(docs[idx], username);
  const now = new Date().toISOString();
  const merged: Record<string, unknown> = { ...existing, ...metadata, updated_at: now };

  if (fileBuffer && fileName && getBucket()) {
    const userData = await getUserData(username);
    if (userData) {
      const uploadPrefix = getUserUploadPrefix(userData, username);
      const key = s3Key(uploadPrefix, contractId, fileName);
      const ok = await uploadFile(key, fileBuffer, contentType || "application/pdf");
      if (ok) {
        merged.document_s3_key = key;
        merged.document = getDocumentUrl(key);
      }
    }
  }

  const stored = contractToStored(merged, contractId);
  stored.id = contractId;
  stored.contract_id = contractId;

  const updatedDocs = [...docs];
  updatedDocs[idx] = stored;
  await saveContractsList(username, updatedDocs);

  return storedToContract(stored, username);
}

export async function deleteContract(
  username: string,
  contractId: string
): Promise<boolean> {
  const { docs } = await getContractsList(username);
  const idx = docs.findIndex((d) => {
    if (typeof d !== "object" || !d) return false;
    return (d.id as string) === contractId || (d.contract_id as string) === contractId;
  });
  if (idx === -1) return false;

  const s3KeyValue = docs[idx].document_s3_key as string | undefined;
  if (s3KeyValue) {
    await deleteObject(s3KeyValue);
  }

  const updatedDocs = [...docs];
  updatedDocs.splice(idx, 1);
  return saveContractsList(username, updatedDocs);
}
