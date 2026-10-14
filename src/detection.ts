import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface RequestUsage {
  provider: string;
  model: string;
  promptTokens: number;
  cacheRead: number;
  reportedCache: boolean;
}

type InputUsage = Pick<AssistantMessage["usage"], "input" | "cacheRead" | "cacheWrite">;

function requestUsage(provider: string, model: string, usage: InputUsage): RequestUsage | undefined {
  const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(promptTokens) || promptTokens === 0) return undefined;
  return {
    provider,
    model,
    promptTokens,
    cacheRead: usage.cacheRead,
    reportedCache: usage.cacheRead + usage.cacheWrite > 0,
  };
}

function sameModel(left: RequestUsage, right: RequestUsage): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function successful(message: AssistantMessage): boolean {
  return message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse";
}

/** Read metadata only, from the active branch, without modifying session content. */
function previousRequest(entries: readonly SessionEntry[], current: AssistantMessage): RequestUsage | undefined {
  let previous: RequestUsage | undefined;
  for (const entry of entries) {
    switch (entry.type) {
      case "compaction":
      case "branch_summary":
      case "context_edit":
      case "model_change":
        previous = undefined;
        break;
      case "usage":
        if (entry.kind === "cache_warm") {
          // A completed cache warm is a real request, but other nested usage is not.
          previous = requestUsage(entry.provider, entry.model, entry.usage);
        }
        break;
      case "message": {
        const message = entry.message;
        if (message.role !== "assistant") break;
        // message_end normally precedes persistence. Stop here if a host already persisted it.
        if (message === current) return previous;
        const next = successful(message) ? requestUsage(message.provider, message.model, message.usage) : undefined;
        if (previous && next && sameModel(previous, next)) next.reportedCache ||= previous.reportedCache;
        previous = next;
        break;
      }
    }
  }
  return previous;
}

/**
 * Estimate previously sent input not reported as a cache read. Counts alone cannot
 * prove identical content, expiry, routing, a cache failure, or an actual charge.
 * Pi normalizes input to EXCLUDE cacheRead and cacheWrite for both API families.
 */
export function estimateMissedTokens(entries: readonly SessionEntry[], message: AssistantMessage): number | undefined {
  if (!successful(message)) return undefined;
  const current = requestUsage(message.provider, message.model, message.usage);
  if (!current) return undefined;
  const previous = previousRequest(entries, message);
  if (!previous || !sameModel(previous, current)) return undefined;
  // Zero reads alone cannot distinguish a miss from a provider without cache reporting.
  if (!previous.reportedCache && !current.reportedCache) return undefined;
  const missed = Math.min(previous.promptTokens, current.promptTokens) - current.cacheRead;
  return missed > 0 ? missed : undefined;
}

export function formatNotice(tokens: number): string {
  return `Possible cache miss: approximately ${tokens.toLocaleString("en-US")} previously sent tokens appear to have been processed again.`;
}
