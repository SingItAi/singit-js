#!/usr/bin/env node
// Prepared paid example for @singitai/ai-sdk-tools.
// Default is a dry run: unpaid 402 quote only. Pass --go to pay once.
// Hard cap $0.05. Never prints keys, addresses, payment payloads, or raw 402 bodies.
import { readFileSync, openSync, closeSync, appendFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { base } from "viem/chains";
import { singitTools } from "../src/index.js";
import { spawnSync } from "node:child_process";
if (!process.execArgv.some((a) => a.startsWith("--max-http-header-size"))) {
  const again = spawnSync(process.execPath, ["--max-http-header-size=131072", ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(again.status ?? 1);
}

const PAY = process.argv.includes("--go");
const CAP_USD = 0.05;
const CAP_ATOMIC = 50_000n;
const ASK = process.env.ASK_URL || "https://ask.singitai.app";
const QUERY = process.env.SEARCH_QUERY || "x402 specification";
const NUM_RESULTS = Number(process.env.SEARCH_NUM_RESULTS || 1);
const KEY_PATH = process.env.SINGIT_EVM_PRIVATE_KEY_PATH;
const LOCK = process.env.PAID_LOCK || new URL("./.paid-search.lock", import.meta.url).pathname;
const OUT = process.env.PAID_OUT || "";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";

function redact(value) {
  return String(value)
    .replace(/0x[0-9a-fA-F]{8,}/g, "<redacted>")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<redacted>");
}

function summarizeOffers(challenge) {
  return (challenge.accepts || []).map(offer => {
    const atomic = String(offer.amount ?? "");
    const usd = /^\d+$/.test(atomic) ? Number(atomic) / 1e6 : null;
    return {
      scheme: offer.scheme,
      network: offer.network,
      amount_atomic: atomic,
      amount_usd: usd,
      under_cap: usd != null && usd <= CAP_USD,
    };
  });
}

const rec = {
  ts: new Date().toISOString(),
  purpose: "ai-sdk-tools-paid-search",
  route: "/v1/exa/search",
  query_len: QUERY.length,
  numResults: NUM_RESULTS,
  mode: PAY ? "PAY" : "DRY",
  cap_usd: CAP_USD,
  team_test: true,
  excluded_from_metrics: true,
};

function done(code = 0) {
  const line = JSON.stringify(rec);
  console.log(line);
  if (OUT) appendFileSync(OUT, `${line}\n`);
  process.exit(code);
}

const quoteResponse = await fetch(`${ASK}/v1/exa/search`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ query: QUERY, numResults: NUM_RESULTS }),
});
rec.quote_http = quoteResponse.status;
if (quoteResponse.status !== 402) {
  rec.error = `expected unpaid 402, got HTTP ${quoteResponse.status}`;
  done(2);
}
const paymentRequired = quoteResponse.headers.get("payment-required");
if (!paymentRequired) {
  rec.error = "402 without payment-required header";
  done(2);
}
let challenge;
try {
  challenge = JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"));
} catch {
  rec.error = "could not decode payment-required header";
  done(2);
}
rec.x402Version = challenge.x402Version;
rec.quoted_offers = summarizeOffers(challenge);
rec.selected_quote = rec.quoted_offers.find(
  offer => offer.scheme === "exact" && offer.network === "eip155:8453",
) || rec.quoted_offers[0] || null;
if (!rec.selected_quote) {
  rec.error = "no quote offers";
  done(2);
}
if (!rec.selected_quote.under_cap) {
  rec.error = "quoted amount exceeds $0.05 cap; not paying";
  done(4);
}
if (!PAY) {
  rec.result = "dry-run quote only";
  done(0);
}
if (!KEY_PATH) {
  rec.error = "SINGIT_EVM_PRIVATE_KEY_PATH is required for --go";
  done(2);
}

const quoted = BigInt(rec.selected_quote.amount_atomic);
if (quoted > CAP_ATOMIC) {
  rec.error = "quoted atomic amount exceeds cap";
  done(4);
}

let key = readFileSync(KEY_PATH, "utf8").trim();
if (!key.startsWith("0x")) key = `0x${key}`;
const account = privateKeyToAccount(key);
key = null;
rec.wallet = "box-test-wallet";
rec.network = "eip155:8453";

const chain = createPublicClient({ chain: base, transport: http(RPC) });
const balanceOf = () => chain.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});
rec.balance_before_atomic = String(await balanceOf());
rec.balance_before_usd = Number(rec.balance_before_atomic) / 1e6;
if (BigInt(rec.balance_before_atomic) < quoted) {
  rec.error = "wallet USDC below quoted amount; no top-up";
  done(5);
}

let lockFd;
try {
  lockFd = openSync(LOCK, "wx", 0o600);
} catch {
  rec.error = "lock held; refusing to pay twice";
  done(3);
}

try {
  const tools = singitTools({
    wallet: account,
    network: "base",
    guards: { maxPerCall: CAP_USD, maxPerDay: CAP_USD },
    scheme: "upto",
    searchScheme: "exact",
    spendLog: false,
    ...(process.env.ASK_URL ? { baseUrl: ASK } : {}),
  });
  const result = await tools.singitSearch.execute({ query: QUERY, numResults: NUM_RESULTS });
  const results = Array.isArray(result?.results) ? result.results : [];
  rec.ok = true;
  rec.result_count = results.length;
  rec.first_title_len = typeof results[0]?.title === "string" ? results[0].title.length : 0;
  rec.balance_after_atomic = String(await balanceOf());
  rec.balance_after_usd = Number(rec.balance_after_atomic) / 1e6;
  rec.spend_atomic = String(BigInt(rec.balance_before_atomic) - BigInt(rec.balance_after_atomic));
  rec.spend_usd = Number(rec.spend_atomic) / 1e6;
  const status = await tools.singitSpendStatus.execute({});
  rec.client_spent_today_usd = status.spentTodayUsd;
  done(0);
} catch (error) {
  rec.ok = false;
  rec.error = redact(error?.message || error);
  try { closeSync(lockFd); } catch {}
  done(1);
}
