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

  // secrets
  JWT_SECRET: string;
  FILE_URL_SECRET: string;
  META_WA_TOKEN?: string;
  CLOUDINARY_API_KEY?: string;
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
