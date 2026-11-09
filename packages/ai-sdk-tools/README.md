# @singitai/ai-sdk-tools

Vercel AI SDK tools that let an agent buy a SingIt answer or a web search and pay in USDC over x402. Per-call and per-day spend ceilings are **required** and checked client-side before anything is signed; the model cannot raise them.

Package version 0.1.0. Needs `@singitai/sdk` 0.2.0. Not published to npm until Kostya says so.

## Install (after publish)

```bash
npm install @singitai/ai-sdk-tools ai viem
```

## Usage

```ts
import { generateText, isStepCount } from "ai";
import { singitTools } from "@singitai/ai-sdk-tools";
import { privateKeyToAccount } from "viem/accounts";

const tools = singitTools({
  wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  network: "base",
  guards: { maxPerCall: 0.01, maxPerDay: 1 },
});

const { text } = await generateText({
  model: "openai/gpt-5-mini",
  prompt: "Search the web for the latest x402 spec changes and summarize them.",
  tools,
  stopWhen: isStepCount(3),
});
console.log(text);
```

That `generateText` example spends real USDC on Base (and also calls the chosen AI SDK model). Do not run it without an explicit OK.

A runnable paid example that calls `singitSearch` directly (no AI SDK model, no OpenAI key) lives in `examples/paid-search.mjs`. It quotes an unpaid 402 first and pays only with `--go`. Hard cap $0.05.

Tools:

- `singitAsk` — `POST /v1/chat/completions` via `SingIt.chat()` (default scheme `upto`)
- `singitSearch` — `POST /v1/exa/search` via `SingIt.paidFetch()` (default search scheme `exact`; no retries)
- `singitSpendStatus` — today's client-side spend; free, no network request

The daily counter lives in the process (in memory by default) and resets at 00:00 UTC.

## Tests

```bash
npm test
```

Unit tests cover a missing-guards refusal, over-ceiling refusal without signing, a mocked 402 for ask and search, and the daily total.
