import { z } from "zod";
import { SingIt, SingItPaymentError } from "@singitai/sdk";

const USDC_DECIMALS = 6;
const DEFAULT_BASE_URL = "https://ask.singitai.app";

function usdFromAtomic(atomic) {
  return Number(atomic) / 10 ** USDC_DECIMALS;
}

/**
 * AI SDK tools that pay SingIt Ask over x402.
 *
 * `guards.maxPerCall` and `guards.maxPerDay` are required. They are checked
 * client-side before anything is signed; the model cannot raise them.
 * Extra fields (`baseUrl`, `payTo`, `fetchImpl`, `scheme`, `spendLog`) are for
 * tests and advanced wiring.
 */
export function singitTools(options = {}) {
  const { wallet, network, guards } = options;
  if (!guards || guards.maxPerCall == null || guards.maxPerDay == null) {
    throw new SingItPaymentError(
      "guards.maxPerCall and guards.maxPerDay are required: this package never pays without a ceiling.",
    );
  }
  if (!wallet) throw new SingItPaymentError("wallet is required.");
  if (!network) throw new SingItPaymentError("network is required.");

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const scheme = options.scheme ?? "upto";
  const searchScheme = options.searchScheme ?? "exact";
  const singit = new SingIt({
    evmAccount: wallet,
    network,
    maxPerCallUsd: guards.maxPerCall,
    maxPerDayUsd: guards.maxPerDay,
    spendLog: options.spendLog === undefined ? false : options.spendLog,
    baseUrl,
    ...(options.payTo ? { payTo: options.payTo } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    singitAsk: {
      description:
        "Buy a language-model answer from SingIt and pay in USDC over x402. Per-call and per-day ceilings are enforced client-side before anything is signed.",
      inputSchema: z.object({
        prompt: z.string().min(1),
        model: z.string().optional(),
      }),
      execute: async ({ prompt, model }) => singit.chat({
        messages: [{ role: "user", content: prompt }],
        ...(model ? { model } : {}),
        scheme,
      }),
    },
    singitSearch: {
      description:
        "Buy web search results from SingIt and pay in USDC over x402. Per-call and per-day ceilings are enforced client-side before anything is signed.",
      inputSchema: z.object({
        query: z.string().min(1),
        numResults: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ query, numResults }) => {
        const paid = singit.paidFetch({ scheme: searchScheme });
        const response = await paid(`${baseUrl}/v1/exa/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, numResults: numResults ?? 5 }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const safe = text.replace(/0x[0-9a-fA-F]{40,}/g, "<redacted>").slice(0, 300);
          throw new SingItPaymentError(`Search failed with HTTP ${response.status}: ${safe}`);
        }
        return response.json();
      },
    },
    singitSpendStatus: {
      description:
        "Today's client-side SingIt spend and the remaining per-call and per-day ceilings. Free; no network request.",
      inputSchema: z.object({}),
      execute: async () => {
        const remainingAtomic = singit.limiter.remainingAtomic();
        const remainingTodayUsd = usdFromAtomic(remainingAtomic);
        return {
          success: true,
          maxPerCallUsd: guards.maxPerCall,
          maxPerDayUsd: guards.maxPerDay,
          remainingTodayUsd,
          spentTodayUsd: Math.max(0, Number(guards.maxPerDay) - remainingTodayUsd),
          note: "Client-side ceilings. The daily counter lives in this process (in-memory unless a spend log file is configured).",
        };
      },
    },
  };
}

export { SingItPaymentError };
