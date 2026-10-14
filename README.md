# pi-rpc-cache-miss

Show **possible prompt-cache misses in Pi RPC clients**, including Paseo, without adding messages to model context.

> Possible cache miss: approximately 42,000 previously sent tokens appear to have been processed again.

The default threshold is **20,000 inferred missed tokens per completed response**. The extension is silent in terminal (TUI), JSON, and print modes. It makes no model requests, changes no prompts, registers no tools, and writes no session entries.

Tested with [Pi coding agent](https://github.com/earendil-works/pi) **1.2.0** and Node.js 24. Requires the Pi 1.2 extension API and Node.js 22.19 or later. RPC clients must support `extension_ui_request` notifications; Paseo's Pi adapter does.

## Install

```sh
pi install git:github.com/codesoda/pi-rpc-cache-miss
```

Start a new Pi session, or reload extensions where your client supports it. In Paseo, start a new underlying Pi session; an already running Pi process does not automatically load a newly installed package.

For a pinned install, use a release tag, for example:

```sh
pi install git:github.com/codesoda/pi-rpc-cache-miss@v0.1.0
```

## Configure

No config file is required. To change the defaults, create **`~/.pi/agent/pi-rpc-cache-miss.json`**:

```json
{
  "version": 1,
  "enabled": true,
  "thresholdTokens": 20000
}
```

All fields are optional. For example, this lowers the threshold:

```json
{
  "thresholdTokens": 5000
}
```

- `thresholdTokens`: positive safe integer. Notify when the estimate is **at least** this many tokens. There is no dollar-cost threshold.
- `enabled`: set to `false` to disable notices.
- `version`: configuration format, currently `1`.

Configuration is **global only**. The extension uses Pi's `getAgentDir()` helper, which honors `PI_CODING_AGENT_DIR`. It does not read project `.pi` config files or Pi's `settings.json`. If embedding Pi with an SDK-specific agent directory, align `PI_CODING_AGENT_DIR` with that directory.

Config is read at session startup and extension reload. Invalid, unknown, or unreadable configuration disables notifications for that session and emits one RPC warning, without exposing the file contents. Fix the file and reload or start a new session. No config is read and no warning is emitted outside RPC mode.

### What about the terminal?

Pi has its own terminal cache notices, controlled by **`showCacheMissNotices`** in Pi's `settings.json` (default: `false` in Pi 1.2.0). Enable that separately if you want terminal warnings:

```json
{
  "showCacheMissNotices": true
}
```

This extension neither changes nor depends on that setting. Pi's terminal notice threshold also considers estimated API cost; this extension deliberately uses tokens only, including for subscription-backed models.

## How detection works

Pi normalizes the provider's usage into input tokens, cache-read tokens, and cache-write tokens. For a completed response, this extension compares it with the preceding request on the **active session branch**:

```text
promptTokens = input + cacheRead + cacheWrite
inferredMissedTokens = min(previousPromptTokens, currentPromptTokens) - currentCacheRead
```

The formula excludes straightforward prompt growth. New input alone does not trigger a notice if the earlier prompt was fully reused. It works with both Claude cache read/write accounting and Codex cache-read accounting when the provider supplies those fields.

This is a **heuristic**, not proof of identical tokens being reprocessed. Counts cannot prove a matching prefix or explain why caching changed. Changed instructions, tools, history projections, routing, expiry, or provider behavior can all reduce reuse. The extension does not compare prompt content, assume a five-minute TTL, claim a cause, or calculate actual charges. A subscription's usage allowance is not an API bill.

To reduce misleading notices:

- The first request is a cold start, with no warning.
- A provider that has not reported any cache activity in the current comparison chain does not generate zero-cache warnings.
- Compaction, branch summaries, persisted context edits, and model changes reset the comparison. Both provider and model must match.
- Failed, aborted, empty-usage, and invalid-usage responses do not generate warnings and break the comparison chain.
- Completed cache-warming usage becomes the comparison baseline; other nested usage does not.
- Resuming or navigating a session uses its active branch. Historical misses are not replayed as notifications.
- Each completed assistant message can produce at most one notice during the loaded extension runtime.

Request-local history rewrites by other extensions may not have a persisted reset marker. These can still produce an inferred miss; the wording intentionally remains cautious.

## Privacy and overhead

The extension reads its own config and existing session usage metadata in process. It does not read credentials, send telemetry, store prompts, call a provider, or modify history. Detection scans the active branch's metadata for each completed response. The only output is an RPC UI notification; a client may display or ignore it. Notices are not added to Pi's model transcript or provider payloads.

## Update or remove

```sh
pi update git:github.com/codesoda/pi-rpc-cache-miss
pi remove git:github.com/codesoda/pi-rpc-cache-miss
```

Pinned tags remain pinned. Use `pi install` with a newer tag to move a pinned installation. Restart/reload Pi after changes. Removal does not delete an optional config file you created.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
```

Tests cover inference boundaries, Claude/Codex-shaped usage, config validation, RPC-only delivery, reset cases, and an offline real-Pi RPC run with a deterministic fake provider. No credentials or paid model calls are needed. The RPC test checks that notices stay out of both the transcript and provider payloads.

Host-provided Pi packages are peers; pinned development dependencies test the extension against Pi 1.2.0. No private Pi implementation modules are imported.

## References

- [Pi extension modes](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md#ui-and-modes)
- [RPC notifications](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/rpc-extension-ui.md#notify)
- [Pi's native cache statistics](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/cache-stats.ts)

MIT licensed.
