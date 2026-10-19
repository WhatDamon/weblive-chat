import { describe, expect, test } from "bun:test";
import type { ChatRepo } from "../../src/lib/ports";
import type { StreamRepo } from "../../src/lib/stream";

describe("窄接口", () => {
  test("StreamRepo 只需要 5 个方法就能构造替身", () => {
    const fake: StreamRepo = {
      eventsSince: async () => [],
      eventsMaxId: async () => 0,
      presenceUpsert: async () => {},
      presenceCount: async () => 0,
      banGet: async () => null,
    };
    expect(Object.keys(fake)).toHaveLength(5);
  });

  test("ChatRepo 不要求 purge/maintenance 能力", () => {
    const stub = {} as ChatRepo;
    // @ts-expect-error ChatRepo 上不存在 purgeCounts（能编译过即说明收窄成功）
    const leak = stub.purgeCounts;
    expect(leak).toBeUndefined();
  });
});
