<div align="center">

# @singitai/sdk

**Pay SingIt Ask over x402 from your own code, with spend limits checked in your process before anything is signed.**

[![npm](https://img.shields.io/npm/v/@singitai/sdk.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@singitai/sdk)
[![CI](https://img.shields.io/github/actions/workflow/status/SingItAi/singit-js/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/SingItAi/singit-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![x402](https://img.shields.io/badge/x402-USDC-purple?style=flat-square)](https://x402.org)
[![Base](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square)](https://solana.com)

[Docs](https://singitai.app/developers/) · [Quickstart](https://singitai.app/docs/quickstart/) · [Python SDK](https://github.com/SingItAi/singit-python) · [MCP server](https://github.com/SingItAi/singit-mcp) · [Examples](https://github.com/SingItAi/singit-examples)

</div>

Pay [SingIt Ask](https://github.com/SingItAi/SingItAI/tree/main/singit-ask) over x402 from your own code or agent, with spend limits that are
checked **in your process before anything is signed**: a ceiling per call and a ceiling per day.
USDC on Base or Solana, no account and no API key.

```bash
npm install @singitai/sdk
```

Keys never go in code: pass your own `viem` account (`evmAccount`) or read a private key from the
environment, as below. The limits here are client-side. They protect the wallet you give this SDK
from a runaway loop or a merchant asking for more than you allowed; they are not an on-chain limit.
The SingIt AgentAllowance contract is a separate thing that covers only the SingIt app's own agent.

## Base

```js
import { SingIt } from "@singitai/sdk";

const singit = new SingIt({
  evmPrivateKey: process.env.AGENT_PRIVATE_KEY, // or evmAccount: a viem Account
  network: "base",
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }] });
console.log(answer.choices[0].message.content, answer.payment);
```

## With LangChain, the Vercel AI SDK or the OpenAI SDK

`paidFetch()` returns a `fetch` that pays a 402 from SingIt Ask exactly like `chat()` (same pins,
same per-call and per-day ceilings, shared with `chat()` on the same instance). Requests to other
hosts pass through unpaid. Answers must be non-streaming, and the framework must not retry (a retry
would sign a second payment).

```js
import { ChatOpenAI } from "@langchain/openai";
const llm = new ChatOpenAI({ model: "deepseek-v4.1-flash", apiKey: "x402", maxRetries: 0,
  configuration: { baseURL: "https://ask.singitai.app/v1", fetch: singit.paidFetch() } });
```

```js
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const singitProvider = createOpenAICompatible({ name: "singit", apiKey: "x402",
  baseURL: "https://ask.singitai.app/v1", fetch: singit.paidFetch() });
```

(`singit` is the instance from the Base example above. Pass `maxRetries: 0` to AI SDK calls too.)

## Solana

```js
import { SingIt } from "@singitai/sdk";

const singit = new SingIt({
  solanaSigner, // a @solana/kit TransactionSigner
  network: "solana",
  maxPerCallUsd: 0.01,
  maxPerDayUsd: 1,
});

const answer = await singit.chat({ messages: [{ role: "user", content: "Hello" }], scheme: "exact" });
```

## Base Sepolia (testnet)

SingIt has no testnet deployment, so there is no pinned `payTo` to default to: pass one
explicitly (e.g. your own test merchant, or a facilitator's own test receiver).

```js
const singit = new SingIt({
  evmPrivateKey: process.env.AGENT_PRIVATE_KEY, network: "base-sepolia",
  payTo: process.env.TEST_MERCHANT_PAY_TO, // required: no SingIt deployment to pin a default against
  maxPerCallUsd: 0.01, maxPerDayUsd: 1,
});
```

## Guards

Every call pins the merchant's offer before signing anything, the same way
`singit-ask/src/metered-buyer.mjs` and `solana-buyer.mjs` in the [main repository](https://github.com/SingItAi/SingItAI/tree/main/singit-ask/src) do for the service's own buyers:

- **Network/asset/payTo.** The offer's `network`, `asset` and `payTo` must exactly match this
  `SingIt` instance's configured network (the built-in pin for `base`/`solana`, or the `payTo` you
  pass for `base-sepolia`). A merchant offering a different asset or recipient is refused before
  anything is signed.
- **Per-call ceiling (`maxPerCallUsd`).** The offer's atomic amount must be at or below
  `maxPerCallUsd` converted to micro-USDC. A costlier offer is refused.
- **Per-day ceiling (`maxPerDayUsd`).** A persistent local log per UTC day and per wallet + network,
  shared by processes using the same file on one host. The worst-case ceiling is reserved before signing;
  `upto` settles down to the billed amount, while `exact` counts the full offer. Unknown outcomes remain
  counted at their ceiling and are never retried. A `409 stale_payment_permit` is refused before verification, so its reservation is freed; wait for the previous transaction before calling again. This is a local client-side guard, not on-chain enforcement.
- **AgentAllowance limiter (`limiter`, optional).** Pass the 0x address of your SingIt
  AgentAllowance limiter on Base and every request to SingIt Ask carries `X-SingIt-Limiter`. The
  402 then reports what that limiter allows right now (`X-SingIt-Spend-Limit`: remaining today,
  per-purchase cap, spendable now, and whether each offer fits), exposed as `singit.lastSpendLimit`.
  An offer SingIt marks as not fitting (`fits: false`) is refused before anything is reserved or
  signed, with the reason (`over_remaining_today`, `over_per_purchase_cap`, ...). Offers marked
  `fits: null` (not checked, e.g. Solana against a Base limiter) or a 402 without the header proceed
  under the local ceilings above. This reads only SingIt's own AgentAllowance at the address you
  supply; it says nothing about other wallets or limits. `allowance(address)` reads the app's
  reconciliation report instead; `lastSpendLimit` is what Ask reported just before signing.
- **Settlement receipt.** The `payment-response` header's network and payer are checked against
  the request; a mismatch is treated as unresolved rather than returned as a success.

This SDK does **not** wait for on-chain confirmation of the settlement transaction (unlike
`metered-buyer.mjs`'s `validateTransfer`/`validateSolanaSettlement` in the main repository); `payment.txHash` is returned
as reported by the merchant's `payment-response` header for the caller to check independently if
needed.

## Spend log

Persistence is on by default at `$SINGIT_HOME/spend.jsonl` when `SINGIT_HOME` is non-empty,
otherwise `~/.singit/spend.jsonl`. New directories use mode 0700 and new files 0600.
Pass `spendLog: "/writable/path/spend.jsonl"` for a custom file, or `spendLog: false` for an
in-memory counter that resets on restart. `undefined` and `true` select the default path.
Construction fails if the file cannot be prepared; it never silently falls back to memory.

Each UTF-8 JSON line records a reserve, settle, or release with version, UTC timestamp,
reservation day, random payment id, network, public payer address, and micro-USDC amount.
Reserves include scheme, sanitized resource origin + pathname, and process id; settlements may
include the merchant's transaction hash. No keys, headers, signed payloads, queries, prompts, or
answer bodies are stored. EVM payer addresses are lowercased; Solana addresses retain their case.
Limits apply independently to each wallet + network. Reservations without a verified invoice
remain counted at their ceiling. A failure to append a settlement or release warns and retains
that ceiling, preserving the paid answer.

```bash
singit spend summary
singit spend summary --days 7 --file /writable/path/spend.jsonl --json
singit spend export --csv --days 7
```

Example human output (fake payer):

```text
Spend log: /example/spend.jsonl
Local client-side log: not on-chain enforcement.
Day Network Payer Payments Spent (USDC) Settled Unresolved Released
2026-11-02 base 0x1111...1111 1 0.004500 1 0 0
Totals 1 0.004500 1 0 0
Unresolved payments are counted at their ceiling.
```

Human output shortens payer addresses; JSON and CSV retain them in full. Corrupt, unsupported,
or incomplete lines are skipped and reported. `readSpend(file)` returns payment records and
`skippedLines`; `spendSummary({file, days})` returns the same grouped data as the JSON command.
The file is read on every reservation and remaining/summary query. It grows by two short lines
per completed payment; pruning is not included. Reservations use a shared exclusive sibling
`.lock` file (5-second timeout; a lock is reclaimed only when it is older than 30 seconds and its owner process on this host is gone, otherwise the reservation is refused with a message naming the lock file). Use local POSIX storage;
network filesystems are not supported.

**What this is not:** this is a local client-side log, not on-chain enforcement, a ledger, or
proof of payment. It is not tamper-proof: editing or deleting the file, using another tool, or
using the wallet on another machine bypasses it. It is not shared across machines. The wallet's
own balance, SingIt API-key limits on the server, and the SingIt app's on-chain AgentAllowance
are separate things.

## API

- `new SingIt(options)` — `evmPrivateKey | evmAccount` (EVM, viem `Account`), `solanaSigner` (a
  `@solana/kit` `TransactionSigner`, for `network: "solana"`), `network`, `baseUrl` (default
  `https://ask.singitai.app`), `appBaseUrl` (default `https://app.singitai.app`), `payTo`,
  `rpcUrl`, `maxPerCallUsd`, `maxPerDayUsd` (both required), `spendLog` (default persistence),
  `limiter` (optional AgentAllowance address on Base, see "Guards").
- `lastSpendLimit` — the `X-SingIt-Spend-Limit` JSON from the last 402, or `null` when none was sent.
- `spendLimitFromResponse(response)` (export) — parses that header from any `Response`, or `null`.
- `chat({ model, messages, max_tokens, scheme, route })` — OpenAI-shaped chat completion.
  `scheme: "upto"` (default) pays only the actual answer cost, up to the offered ceiling;
  `"exact"` pays that ceiling flat. `route: "completions"` (default) calls
  `POST /v1/chat/completions`, live today. `route: "per-model"` calls `POST /v1/chat/{model}`
 , live; `model` is then required.
- `walletReport(address, { days, apiKey })` — `GET {appBaseUrl}/v1/wallet/{address}/reconciliation`
 . The report is private: `apiKey` must be a SingIt API key of the account that signs in
  with `address`; without one the server answers 401, and the SDK says so.
- `pricing()` — `GET {baseUrl}/pricing.json`, live.
- `paidFetch({ scheme })` — a guarded `fetch` for frameworks, see above.
- `allowance(address, options)` — `(await walletReport(address, options)).allowance`: the
  on-chain spending limit set in the SingIt app, with what has been spent/remains today.

## What isn't supported yet

- The wallet report is private and needs a SingIt API key of the account that signs in
  with the wallet; without one the server answers 401 and the SDK says so.
- The spend log is local, editable, and shared only by processes using the same file on one host.
  It does not enforce limits on-chain or across machines; network filesystems are not supported.
- `paidFetch()` reads the billed amount from the JSON answer: streaming answers are not supported.
- No on-chain confirmation of the settlement transaction (see "Guards" above).
- Solana upto/exact signing is tested offline with a real `@solana/kit` signer and a local mock
  RPC. Live settlement with funded accounts is not covered by the test suite.
- `base-sepolia` is useful for integration-testing against a merchant you control; SingIt itself
  has no testnet deployment to pay.

## Contributing and security

See [CONTRIBUTING.md](https://github.com/SingItAi/singit-js/blob/main/CONTRIBUTING.md). Security problems: email contact@singitai.app, not a public
issue ([SECURITY.md](https://github.com/SingItAi/singit-js/blob/main/SECURITY.md)). MIT licensed. The Python equivalent is
[`singit`](https://github.com/SingItAi/singit-python).
