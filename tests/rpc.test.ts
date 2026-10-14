import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";

type RpcRecord = Record<string, unknown>;
interface CapturedMessage {
  role: string;
  content: unknown;
  stopReason?: string;
  usage?: Usage;
}

const notice = "Possible cache miss: approximately 42,000 previously sent tokens appear to have been processed again.";
const prompts = ["First explicit prompt.", "Second explicit prompt.", "Third explicit prompt."];
const answers = ["Cold request complete.", "Cache hit complete.", "Possible miss complete."];
const usages: Usage[] = [
  { input: 10000, cacheWrite: 40000, cacheRead: 0 },
  { input: 1000, cacheWrite: 0, cacheRead: 50000 },
  { input: 43000, cacheWrite: 0, cacheRead: 9000 },
].map((usage) => ({
  ...usage,
  output: 0,
  totalTokens: usage.input + usage.cacheWrite + usage.cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}));

it("notifies once through real offline RPC without changing requests, transcript, or usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-cache-miss-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    const temporaryDir = join(root, "tmp");
    await Promise.all([cwd, agentDir, temporaryDir].map((path) => mkdir(path)));
    // Only the global agent-directory config is supplied, with the default values.
    await writeFile(join(agentDir, "pi-rpc-cache-miss.json"), JSON.stringify({
      version: 1, enabled: true, thresholdTokens: 20000,
    }));
    const payloadPath = join(root, "provider-payloads.jsonl");
    const providerPath = join(root, "provider.ts");
    const fauxPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
    const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
    await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fauxPath)};
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
export default function (pi) {
  const faux = fauxProvider({
    provider: "cache-miss-test", api: "cache-miss-test-api",
    models: [{ id: "deterministic", contextWindow: 200000, maxTokens: 4096 }],
    tokenSize: { min: 10000, max: 10000 },
  });
  const usages = ${JSON.stringify(usages)};
  const answers = ${JSON.stringify(answers)};
  faux.setResponses(answers.map((answer) => async (context, options, _state, model) => {
    // Faux does not invoke onPayload. Bridge the real before_provider_request hook.
    await options.onPayload(context, model);
    return fauxAssistantMessage(answer);
  }));
  // Pi 1.2.0 faux always estimates usage, overriding per-response usage.
  // Substitute controlled accounting at the provider stream boundary, before
  // Pi sees it; do not replace messages in an extension message_end handler.
  const originalStream = faux.provider.streamSimple.bind(faux.provider);
  let requests = 0;
  const controlledStream = (model, context, options) => {
    const usage = usages[requests++];
    if (!usage) throw new Error("Unexpected extra provider request");
    const source = originalStream(model, context, options);
    const output = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        for await (const event of source) {
          const message = event.partial ?? event.message ?? event.error;
          if (message) message.usage = structuredClone(usage);
          output.push(event);
        }
        output.end(await source.result());
      } catch (error) {
        const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) });
        output.push({ type: "error", reason: "error", error: message });
        output.end(message);
      }
    });
    return output;
  };
  pi.registerProvider({ ...faux.provider, stream: controlledStream, streamSimple: controlledStream });
  pi.on("before_provider_request", (event) => {
    appendFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(event.payload) + "\\n");
  });
}
`);
    const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const records: RpcRecord[] = [];
    const protocolErrors: string[] = [];
    const noticesAtSettlement: number[] = [];
    let stderr = "";
    let pending = "";
    let settlements = 0;
    child = spawn(process.execPath, [
      join(piDist, "bundle/cli.js"), "--mode", "rpc", "--offline", "--approve", "--no-session",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "-e", providerPath,
      "--provider", "cache-miss-test", "--model", "deterministic", "--thinking", "off",
    ], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    const rpc = child;
    exited = new Promise((resolve, reject) => {
      rpc.once("error", reject);
      rpc.once("close", (code, signal) => resolve({ code, signal }));
    });
    const send = (command: RpcRecord) => rpc.stdin!.write(`${JSON.stringify(command)}\n`);
    const sendPrompt = (index: number) => send({ id: `prompt-${index + 1}`, type: "prompt", message: prompts[index] });
    rpc.stderr!.setEncoding("utf8");
    rpc.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    rpc.stdin!.on("error", (error) => { protocolErrors.push(error.message); });
    rpc.stdout!.setEncoding("utf8");
    rpc.stdout!.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const record = JSON.parse(line) as RpcRecord;
          records.push(record);
          if (record.type === "agent_settled") {
            settlements++;
            noticesAtSettlement.push(records.filter((entry) => entry.type === "extension_ui_request").length);
            // Never enqueue the next prompt at agent_end: retries/continuations
            // may still be running. Each request is an explicit, settled turn.
            if (settlements < prompts.length) sendPrompt(settlements);
            else if (settlements === prompts.length) send({ id: "messages", type: "get_messages" });
            else throw new Error("Unexpected extra agent settlement");
          }
          if (record.type === "response" && record.id === "messages") {
            // EOF only after the third settled turn and the transcript response.
            rpc.stdin!.end();
          }
        } catch (error) {
          protocolErrors.push(String(error));
          rpc.kill("SIGKILL");
        }
      }
    });
    sendPrompt(0);
    expect(await exited, stderr).toEqual({ code: 0, signal: null });
    expect(protocolErrors).toEqual([]);
    expect(pending).toBe("");
    expect(stderr).not.toMatch(/error|failed|fail-open/iu);
    expect(records.filter((record) => record.type === "extension_error")).toEqual([]);
    expect(records.filter((record) => record.type === "response" && record.success === false)).toEqual([]);
    for (let index = 0; index < prompts.length; index++) {
      expect(records.find((record) => record.id === `prompt-${index + 1}`)).toMatchObject({
        type: "response", command: "prompt", success: true, data: { disposition: "started" },
      });
    }
    expect(settlements).toBe(3);
    expect(noticesAtSettlement).toEqual([0, 0, 1]);
    expect(records.filter((record) => record.type === "agent_start")).toHaveLength(3);
    const completed = records.filter((record) => record.type === "message_end")
      .map((record) => record.message as CapturedMessage)
      .filter((message) => message.role === "assistant");
    expect(completed).toHaveLength(3);
    expect(completed.map((message) => message.usage)).toEqual(usages);
    expect(completed.every((message) => message.stopReason === "stop")).toBe(true);

    const ui = records.filter((record) => record.type === "extension_ui_request");
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ method: "notify", notifyType: "info", message: notice });
    expect(ui.filter((record) => ["setStatus", "setFooter", "setWidget"].includes(String(record.method)))).toEqual([]);

    const messagesResponse = records.find((record) => record.id === "messages");
    expect(messagesResponse).toMatchObject({ type: "response", command: "get_messages", success: true });
    const transcript = (messagesResponse!.data as { messages: CapturedMessage[] }).messages;
    const conversation = transcript.filter((message) => message.role !== "system");
    expect(conversation.map(({ role, content }) => ({ role, content }))).toEqual(prompts.flatMap((prompt, index) => [
      { role: "user", content: [{ type: "text", text: prompt }] },
      { role: "assistant", content: [{ type: "text", text: answers[index] }] },
    ]));
    expect(transcript.filter((message) => message.role === "assistant").map((message) => message.usage)).toEqual(usages);
    expect(transcript.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", usage: usages[2] });

    const payloadStrings = (await readFile(payloadPath, "utf8")).trim().split("\n");
    expect(payloadStrings).toHaveLength(3);
    const payloads = payloadStrings.map((line) => JSON.parse(line) as { messages: CapturedMessage[] });
    for (const [index, payload] of payloads.entries()) {
      expect(payload.messages.filter((message) => message.role !== "system"))
        .toEqual(conversation.slice(0, index * 2 + 1));
    }
    for (const serialized of [JSON.stringify(messagesResponse), ...payloadStrings]) {
      expect(serialized).not.toContain(notice);
      expect(serialized).not.toContain("Possible cache miss:");
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (exited) await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
