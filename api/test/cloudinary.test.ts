import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeUpload } from "../src/lib/files";

const cfg = {
  ...env,
  FILE_STORAGE: "cloudinary",
  CLOUDINARY_CLOUD_NAME: "democloud",
  CLOUDINARY_API_KEY: "key123",
  CLOUDINARY_API_SECRET: "secret456",
  CLOUDINARY_FOLDER: "employee_documents",
};
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "p.png", { type: "image/png" });

async function sha1(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterEach(() => vi.restoreAllMocks());

describe("Cloudinary file storage (default, public URLs)", () => {
  it("uploads with a valid signature and stores the public secure_url", async () => {
    let captured: { url: string; form: FormData } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = { url: String(input), form: init!.body as FormData };
      return Response.json({ secure_url: "https://res.cloudinary.com/democloud/image/upload/v1/employee_documents/x.png" });
    });
    const ref = await storeUpload(cfg, png(), "help_tickets");
    expect(ref).toBe("https://res.cloudinary.com/democloud/image/upload/v1/employee_documents/x.png");
    expect(captured!.url).toBe("https://api.cloudinary.com/v1_1/democloud/auto/upload");
    const f = captured!.form;
    expect(f.get("api_key")).toBe("key123");
    expect(f.get("folder")).toBe("employee_documents");
    expect(String(f.get("public_id"))).toMatch(/^help_tickets_\d+_/);
    const expected = await sha1(`folder=${f.get("folder")}&public_id=${f.get("public_id")}&timestamp=${f.get("timestamp")}secret456`);
    expect(f.get("signature")).toBe(expected);
    expect(f.get("api_secret")).toBeNull(); // the secret itself is never sent
  });

  it("returns a clean 502 when Cloudinary rejects the upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "Invalid Signature" } }, { status: 401 }));
    await expect(storeUpload(cfg, png(), "x")).rejects.toMatchObject({ status: 502 });
  });

  it("returns 503 when Cloudinary keys are not configured", async () => {
    await expect(storeUpload({ ...cfg, CLOUDINARY_API_SECRET: undefined }, png(), "x")).rejects.toMatchObject({ status: 503 });
  });

  it("still enforces type and size limits before uploading", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(storeUpload(cfg, new File(["x"], "a.heic", { type: "image/heic" }), "x")).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });
});
