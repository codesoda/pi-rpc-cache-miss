import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-rpc-cache-config-")); directories.push(path); return path;
}

describe("configuration", () => {
  it("defaults to enabled with a 20,000-token threshold", () => {
    expect(parseConfig({})).toEqual({ version: 1, enabled: true, thresholdTokens: 20_000 });
  });
  it("allows partial overrides without changing defaults", () => {
    expect(parseConfig({ thresholdTokens: 5_000 })).toEqual({ ...DEFAULT_CONFIG, thresholdTokens: 5_000 });
    expect(parseConfig({ enabled: false })).toEqual({ ...DEFAULT_CONFIG, enabled: false });
    expect(DEFAULT_CONFIG.thresholdTokens).toBe(20_000);
  });
  it.each([null, [], true, 1, "config", { version: 2 }, { version: "1" }, { enabled: "yes" },
    { thresholdTokens: 0 }, { thresholdTokens: -1 }, { thresholdTokens: 1.5 }, { thresholdTokens: NaN },
    { thresholdTokens: Infinity }, { thresholdTokens: Number.MAX_SAFE_INTEGER + 1 }, { thresholdTokens: "20000" },
    { threshholdTokens: 2_000 }])("rejects malformed config %j", (value) => {
    expect(() => parseConfig(value)).toThrow();
  });
  it("uses defaults without writing a missing file", async () => {
    expect(await loadConfig(await directory())).toEqual(DEFAULT_CONFIG);
  });
  it("loads a config from the requested agent directory", async () => {
    const path = await directory(); await writeFile(join(path, CONFIG_FILENAME), '{"thresholdTokens":5000}');
    expect((await loadConfig(path)).thresholdTokens).toBe(5_000);
  });
  it("rejects malformed JSON rather than silently activating defaults", async () => {
    const path = await directory(); await writeFile(join(path, CONFIG_FILENAME), "not json");
    await expect(loadConfig(path)).rejects.toThrow();
  });
});
