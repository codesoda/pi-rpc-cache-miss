import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  version: 1;
  enabled: boolean;
  thresholdTokens: number;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  version: 1,
  enabled: true,
  thresholdTokens: 20_000,
});

export const CONFIG_FILENAME = "pi-rpc-cache-miss.json";

export function parseConfig(value: unknown): Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["version", "enabled", "thresholdTokens"].includes(key))) {
    throw new Error("Unknown configuration key");
  }
  if ("version" in record && record.version !== 1) throw new Error("version must be 1");
  if ("enabled" in record && typeof record.enabled !== "boolean") throw new Error("enabled must be boolean");
  if ("thresholdTokens" in record &&
      (typeof record.thresholdTokens !== "number" || !Number.isSafeInteger(record.thresholdTokens) || record.thresholdTokens < 1)) {
    throw new Error("thresholdTokens must be a positive safe integer");
  }
  return { ...DEFAULT_CONFIG, ...record } as Config;
}

export async function loadConfig(agentDir: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(agentDir, CONFIG_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error;
  }
  return parseConfig(JSON.parse(text));
}
