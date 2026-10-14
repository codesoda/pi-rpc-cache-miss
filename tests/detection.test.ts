import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateMissedTokens, formatNotice } from "../src/detection.ts";
import { boundary, entry, message } from "./fixtures.ts";

describe("inferred cache reuse", () => {
  it("does not report a cold start", () => {
    expect(estimateMissedTokens([], message(50_000, 0, 0))).toBeUndefined();
  });
  it("reports a partial miss with normalized Codex usage", () => {
    expect(estimateMissedTokens([entry(message(1_000, 50_000))], message(43_000, 9_000))).toBe(42_000);
  });
  it("counts Claude cache writes in prompt size, without claiming a charge", () => {
    const previous = message(1_000, 40_000, 10_000);
    const current = message(1_000, 9_000, 42_000);
    for (const value of [previous, current]) {
      value.api = "anthropic-messages"; value.provider = "anthropic"; value.model = "fixture-claude";
    }
    expect(estimateMissedTokens([entry(previous)], current)).toBe(42_000);
  });
  it("excludes new input from the estimate", () => {
    expect(estimateMissedTokens([entry(message())], message(100_000, 50_000))).toBeUndefined();
  });
  it("bounds the estimate by the current prompt after shrinkage", () => {
    expect(estimateMissedTokens([entry(message())], message(21_000, 9_000))).toBe(21_000);
  });
  it("does not call zero cache reporting a miss without evidence of caching", () => {
    expect(estimateMissedTokens([entry(message(50_000, 0))], message(51_000, 0))).toBeUndefined();
  });
  it("can report a total miss after previous cache activity", () => {
    expect(estimateMissedTokens([entry(message()), entry(message(51_000, 0), "second")], message(52_000, 0))).toBe(51_000);
  });
  it("uses current cache activity as evidence when the earlier request had none", () => {
    expect(estimateMissedTokens([entry(message(50_000, 0))], message(41_000, 10_000))).toBe(40_000);
  });
  it.each(["compaction", "branch_summary", "context_edit", "model_change"] as const)("resets after %s", (type) => {
    expect(estimateMissedTokens([entry(message()), boundary(type)], message(50_000, 0))).toBeUndefined();
  });
  it.each(["provider", "model"] as const)("does not compare across %s changes", (key) => {
    const next = message(50_000, 0); next[key] = "different";
    expect(estimateMissedTokens([entry(message())], next)).toBeUndefined();
  });
  it.each(["error", "aborted"] as const)("ignores %s responses and clears their baseline", (reason) => {
    const failed = message(50_000, 0); failed.stopReason = reason;
    expect(estimateMissedTokens([entry(message())], failed)).toBeUndefined();
    expect(estimateMissedTokens([entry(message()), entry(failed, "failed")], message(50_000, 0))).toBeUndefined();
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid input counts: %s", (count) => {
    expect(estimateMissedTokens([entry(message())], message(count, 0))).toBeUndefined();
  });
  it("rejects invalid cached counts, overflow and empty usage", () => {
    for (const next of [message(1, NaN), message(1, 0, -1), message(Number.MAX_SAFE_INTEGER, 1), message(0, 0)]) {
      expect(estimateMissedTokens([entry(message())], next)).toBeUndefined();
    }
  });
  it("does not reuse a baseline with missing/invalid usage", () => {
    expect(estimateMissedTokens([entry(message(NaN, 0))], message(10_000, 20_000))).toBeUndefined();
  });
  it("uses cache-warming usage but not unrelated nested usage", () => {
    const warm: SessionEntry = { type: "usage", id: "warm", parentId: null, timestamp: "2026-01-01T00:00:00Z",
      kind: "cache_warm", provider: "openai-codex", model: "fixture-model", usage: message(1_000, 79_000).usage };
    expect(estimateMissedTokens([entry(message()), warm], message(51_000, 30_000))).toBe(50_000);
    expect(estimateMissedTokens([entry(message()), { ...warm, kind: "classifier" }], message(51_000, 30_000))).toBe(20_000);
  });
  it("does not double-count a current message already persisted by the host", () => {
    const next = message(50_000, 0);
    expect(estimateMissedTokens([entry(message()), entry(next)], next)).toBe(50_000);
  });
  it("ignores user/tool/custom metadata entries", () => {
    const entries: SessionEntry[] = [entry(message()), {
      type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Follow up", timestamp: 2 },
    }, { type: "custom", id: "custom", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }];
    expect(estimateMissedTokens(entries, message(50_000, 0))).toBe(50_000);
  });
  it("does not mutate messages or entries", () => {
    const entries = [entry(message())]; const next = message(50_000, 0);
    const before = JSON.stringify({ entries, next });
    estimateMissedTokens(entries, next);
    expect(JSON.stringify({ entries, next })).toBe(before);
  });
  it("uses cautious wording without TTL/cost/causation claims", () => {
    expect(formatNotice(42_000)).toBe("Possible cache miss: approximately 42,000 previously sent tokens appear to have been processed again.");
  });
});
