import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          r2Buckets: ["FILES"],
          bindings: {
            FILE_STORAGE: "r2",
            JWT_SECRET: "test-jwt-secret",
            FILE_URL_SECRET: "test-file-secret",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    // Test files share one D1 database; the Sheets-sync tests drain the shared sync queue,
    // so files run one at a time (tests inside a file were already sequential).
    test: { setupFiles: ["./test/apply-migrations.ts"], fileParallelism: false },
  };
});
