import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/lib/repo";
import type { Repo } from "../src/lib/repo";

export async function makeRepo(): Promise<{ repo: Repo; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "wl-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const provider = (process.env.DB_PROVIDER as "sqlite" | "postgres") ?? "sqlite";
  const realUrl = provider === "sqlite" ? url : process.env.DATABASE_URL!;
  const repo = await createRepo(provider, realUrl);
  await repo.bootstrap();
  return { repo, cleanup: async () => { await repo.close(); if (provider === "sqlite") rmSync(dir, { recursive: true, force: true }); } };
}
