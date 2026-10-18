import { describe, expect, test } from "bun:test";
import {
  decMetric,
  incMetric,
  metricsSnapshot,
  resetMetrics,
} from "../../src/lib/metrics";

describe("metrics", () => {
  test("指标可增可减且快照是拷贝", () => {
    resetMetrics();
    incMetric("activeStreams");
    incMetric("activeStreams");
    decMetric("activeStreams");
    expect(metricsSnapshot().active_streams).toBe(1);
    const snap = metricsSnapshot();
    (snap as unknown as Record<string, number>).active_streams = 99;
    expect(metricsSnapshot().active_streams).toBe(1);
  });

  test("计数不会被减成负数", () => {
    resetMetrics();
    decMetric("activeStreams");
    expect(metricsSnapshot().active_streams).toBe(0);
  });
});
