import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/lib/config";
import { pgOptions } from "../../src/lib/repo";

const base = { NODE_ENV: "test", ADMIN_SECRET: "s3cret" };

describe("pgOptions", () => {
  test("映射到 postgres.js 参数，prepare 可关", () => {
    expect(
      pgOptions({
        pgPoolMax: 2,
        pgPrepare: false,
        pgIdleTimeoutS: 5,
        pgConnectTimeoutS: 3,
      }),
    ).toEqual({
      max: 2,
      prepare: false,
      idleTimeoutSec: 5,
      connectTimeoutSec: 3,
    });
  });

  test("默认值：池 1、prepare 开、空闲 20s、连接 10s", () => {
    const cfg = loadConfig({ ...base });
    expect(pgOptions(cfg)).toEqual({
      max: 1,
      prepare: true,
      idleTimeoutSec: 20,
      connectTimeoutSec: 10,
    });
    expect(cfg.pgPrepare).toBe(true);
    expect(loadConfig({ ...base, PG_PREPARE: "0" }).pgPrepare).toBe(false);
  });
});
