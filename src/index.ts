import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME, loadConfig, type Config } from "./config.ts";
import { estimateMissedTokens, formatNotice } from "./detection.ts";

export default function rpcCacheMiss(pi: ExtensionAPI): void {
  let config: Config | undefined;
  let seen = new WeakSet<object>();

  pi.on("session_start", async (_event, ctx) => {
    config = undefined;
    seen = new WeakSet<object>();
    if (ctx.mode !== "rpc") return;
    try {
      config = await loadConfig(getAgentDir());
    } catch {
      // Never include file contents or parser errors: they may contain private data.
      ctx.ui.notify(`pi-rpc-cache-miss: invalid or unreadable ${CONFIG_FILENAME}; notifications disabled. Fix the file and reload Pi.`, "warning");
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "rpc" || !config?.enabled || event.message.role !== "assistant") return;
    if (seen.has(event.message)) return;
    seen.add(event.message);
    const missed = estimateMissedTokens(ctx.sessionManager.getBranch(), event.message);
    if (missed !== undefined && missed >= config.thresholdTokens) {
      ctx.ui.notify(formatNotice(missed), "warning");
    }
    // Notification only: no replacement message, session entry, or continuation.
  });
}
