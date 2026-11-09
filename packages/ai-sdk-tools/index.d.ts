import type { Account } from "viem";
import type { ZodType } from "zod";
import { SingItPaymentError } from "@singitai/sdk";

export { SingItPaymentError };

export interface SingItGuards {
  maxPerCall: number;
  maxPerDay: number;
}

export interface SingItToolsOptions {
  wallet: Account;
  network: "base" | "base-sepolia" | "solana";
  guards: SingItGuards;
  /** Test / advanced: override SingIt Ask origin. */
  baseUrl?: string;
  /** Required on networks where the SDK does not pin a payee. */
  payTo?: string;
  fetchImpl?: typeof fetch;
  scheme?: "upto" | "exact";
  /** Search is exact-priced on SingIt Ask; defaults to "exact". */
  searchScheme?: "upto" | "exact";
  spendLog?: boolean | string;
}

export interface SingItTool<I = any, O = unknown> {
  description: string;
  inputSchema: ZodType<I>;
  execute: (input: I) => Promise<O>;
}

export function singitTools(options: SingItToolsOptions): {
  singitAsk: SingItTool;
  singitSearch: SingItTool;
  singitSpendStatus: SingItTool;
};
