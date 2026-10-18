import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { makeRepo, testCfg } from "../helpers";

describe("健康检查", () => {
  test("DB 正常 200，DB 异常 503", async () => {
    const { repo, cleanup } = await makeRepo("memory");
    const app = createApp({ cfg: testCfg(), repo });
    const ok = await app.fetch(new Request("http://x/api/health"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, provider: "memory" });
    expect(typeof body.mode).toBe("string");

    (repo as unknown as Record<string, unknown>).ping = async () => {
      throw new Error("down");
    };
    const bad = await app.fetch(new Request("http://x/api/health"));
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as Record<string, unknown>).ok).toBe(false);
    await cleanup();
  });
});
