import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export function message(input = 1_000, cacheRead = 49_000, cacheWrite = 0): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "Test response" }],
    api: "openai-codex-responses", provider: "openai-codex", model: "fixture-model",
    usage: { input, cacheRead, cacheWrite, output: 100, totalTokens: input + cacheRead + cacheWrite + 100,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
    stopReason: "stop", timestamp: 1,
  };
}

export function entry(value: AssistantMessage, id = "response"): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: value };
}

export function boundary(type: "compaction" | "branch_summary" | "context_edit" | "model_change"): SessionEntry {
  const base = { id: type, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
  switch (type) {
    case "compaction": return { ...base, type, summary: "Summary", firstKeptEntryId: "response", tokensBefore: 50_000 };
    case "branch_summary": return { ...base, type, fromId: "response", summary: "Summary" };
    case "context_edit": return { ...base, type, targetId: "response", replacement: null };
    case "model_change": return { ...base, type, provider: "openai-codex", modelId: "fixture-model" };
  }
}
