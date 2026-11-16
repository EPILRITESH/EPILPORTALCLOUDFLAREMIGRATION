export interface Env {
  DB: D1Database;
  /** Optional: only bound when FILE_STORAGE = "r2". */
  FILES?: R2Bucket;

  // vars
  CORS_ORIGINS: string;
  MAX_UPLOAD_BYTES: string;
  WHATSAPP_TEMPLATE_PENDING: string;
  WHATSAPP_TEMPLATE_WORKREPORT: string;
  WHATSAPP_API_VERSION: string;
  PUBLIC_API_URL?: string;
  /** "cloudinary" (default: public URLs, like the legacy system) or "r2" (private bucket + signed URLs). */
  FILE_STORAGE?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_FOLDER?: string;
  /** "true" turns on the D1 → Google Sheets backup sync. */
  SHEETS_SYNC_ENABLED?: string;
  /** "true" while the old portal still writes to the sheets: pull those changes into D1 every 5 minutes. */
  SHEETS_PULL_ENABLED?: string;
  /** Optional tab-name prefix (e.g. "ZZTEST_") to target test/staging tabs instead of the real ones. */
  SHEETS_TAB_PREFIX?: string;
  EM_SHEET_TAB_NAME?: string;

  // secrets
  JWT_SECRET: string;
  FILE_URL_SECRET: string;
  META_WA_TOKEN?: string;
  CLOUDINARY_API_KEY?: string;
  // Google Sheets backup (service account + legacy spreadsheet IDs) — Worker secrets
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SHEET_ID_CHECKLIST?: string;
  GOOGLE_SHEET_ID_DELEGATION?: string;
  GOOGLE_SHEET_ID_HELPTICKET?: string;
  GOOGLE_SHEET_ID_SUPPORTTICKET?: string;
  GOOGLE_SHEET_ID_WORKLIST?: string;
  GOOGLE_SHEET_ID_TRAINING?: string;
  GOOGLE_SHEET_ID_EMSHEET?: string;
  CLOUDINARY_API_SECRET?: string;
  META_WA_PHONE_ID?: string;
  ADMIN_REGISTRATION_KEY?: string;
}

export type Role = "admin" | "employee";

/** Claims carried in the session JWT. Field names match the legacy token. */
export interface SessionUser {
  employeeID: string;
  name: string;
  department: string;
  designation: string;
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser };
};
