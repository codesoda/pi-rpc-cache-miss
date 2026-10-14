import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rpcCacheMiss from "../src/index.ts";
import { CONFIG_FILENAME } from "../src/config.ts";
import { entry, message } from "./fixtures.ts";

const host = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => host.agentDir }));
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

beforeEach(async () => { host.agentDir = await mkdtemp(join(tmpdir(), "pi-rpc-cache-extension-")); });
afterEach(async () => { await rm(host.agentDir, { recursive: true, force: true }); });

function setup(mode: ExtensionContext["mode"] = "rpc") {
  const handlers = new Map<string, Handler>();
  const on = vi.fn((name: string, handler: Handler) => { handlers.set(name, handler); });
  rpcCacheMiss({ on } as unknown as ExtensionAPI);
  let branch: SessionEntry[] = [entry(message())];
  const notify = vi.fn();
  const getBranch = vi.fn(() => branch);
  const ctx = { mode, ui: { notify }, sessionManager: { getBranch } } as unknown as ExtensionContext;
  return { notify, getBranch, handlers, ctx,
    setBranch: (value: SessionEntry[]) => { branch = value; },
    fire: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
  };
}

describe("RPC-only extension", () => {
  it("registers observers only, not tools, messages or continuations", () => {
    expect([...setup().handlers.keys()]).toEqual(["session_start", "message_end"]);
  });
  it("is silent until session initialization", () => {
    const test = setup(); test.fire("message_end", { message: message(50_000, 0) });
    expect(test.notify).not.toHaveBeenCalled(); expect(test.getBranch).not.toHaveBeenCalled();
  });
  it.each(["tui", "print", "json"] as const)("does nothing in %s mode, even with an invalid config", async (mode) => {
    await writeFile(join(host.agentDir, CONFIG_FILENAME), "invalid");
    const test = setup(mode); await test.fire("session_start");
    test.fire("message_end", { message: message(50_000, 0) });
    expect(test.notify).not.toHaveBeenCalled(); expect(test.getBranch).not.toHaveBeenCalled();
  });
  it("notifies at the default boundary, not below it", async () => {
    const test = setup(); await test.fire("session_start");
    expect(test.fire("message_end", { message: message(20_000, 30_001) })).toBeUndefined();
    expect(test.notify).not.toHaveBeenCalled();
    expect(test.fire("message_end", { message: message(20_001, 30_000) })).toBeUndefined();
    expect(test.notify).toHaveBeenCalledExactlyOnceWith(
      "Possible cache miss: approximately 20,000 previously sent tokens appear to have been processed again.", "info");
  });
  it("honors a custom threshold", async () => {
    await writeFile(join(host.agentDir, CONFIG_FILENAME), '{"thresholdTokens":5000}');
    const test = setup(); await test.fire("session_start");
    test.fire("message_end", { message: message(6_000, 45_000) });
    expect(test.notify).toHaveBeenCalledTimes(1);
  });
  it("honors enabled=false", async () => {
    await writeFile(join(host.agentDir, CONFIG_FILENAME), '{"enabled":false}');
    const test = setup(); await test.fire("session_start");
    test.fire("message_end", { message: message(50_000, 0) });
    expect(test.notify).not.toHaveBeenCalled(); expect(test.getBranch).not.toHaveBeenCalled();
  });
  it("deduplicates repeated dispatch of the same completed message", async () => {
    const test = setup(); await test.fire("session_start"); const event = { message: message(50_000, 0) };
    test.fire("message_end", event); test.fire("message_end", event);
    expect(test.notify).toHaveBeenCalledTimes(1);
  });
  it("ignores non-assistant events", async () => {
    const test = setup(); await test.fire("session_start");
    test.fire("message_end", { message: { role: "toolResult" } });
    test.fire("message_end", { message: { role: "user" } });
    expect(test.notify).not.toHaveBeenCalled(); expect(test.getBranch).not.toHaveBeenCalled();
  });
  it("uses the active branch after navigation rather than a stale in-memory baseline", async () => {
    const test = setup(); await test.fire("session_start");
    test.fire("message_end", { message: message(1_000, 50_000) });
    test.setBranch([]); test.fire("message_end", { message: message(51_000, 0) });
    expect(test.notify).not.toHaveBeenCalled();
  });
  it("does not replay historical notices on resume", async () => {
    const test = setup(); test.setBranch([entry(message()), entry(message(50_000, 0), "miss")]);
    await test.fire("session_start", { reason: "resume" });
    expect(test.notify).not.toHaveBeenCalled();
  });
  it("disables on invalid config, redacts errors, and recovers on reload", async () => {
    await writeFile(join(host.agentDir, CONFIG_FILENAME), "SENSITIVE_FIXTURE_DO_NOT_ECHO");
    const test = setup(); await test.fire("session_start");
    test.fire("message_end", { message: message(50_000, 0) });
    expect(test.notify).toHaveBeenCalledTimes(1);
    expect(test.notify.mock.calls[0][0]).toContain("notifications disabled");
    expect(test.notify.mock.calls[0][0]).not.toContain("SENSITIVE_FIXTURE");
    expect(test.getBranch).not.toHaveBeenCalled();
    await writeFile(join(host.agentDir, CONFIG_FILENAME), "{}");
    await test.fire("session_start", { reason: "reload" });
    test.fire("message_end", { message: message(50_000, 0) });
    expect(test.notify).toHaveBeenCalledTimes(2);
  });
});
