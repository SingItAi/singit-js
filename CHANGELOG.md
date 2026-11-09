# Changelog

This repository was split from [SingItAi/SingItAI](https://github.com/SingItAi/SingItAI)
(`sdk/typescript`) with its history kept.

## 0.2.0 - 2026-11-09

- Optional `limiter`: the 0x address of your SingIt AgentAllowance on Base, sent as
  `X-SingIt-Limiter`. SingIt Ask then returns what that limiter allows right now in
  `X-SingIt-Spend-Limit` (remaining today, per-purchase cap, spendable now, and whether
  each offer fits). The last header is exposed as `singit.lastSpendLimit`.
- An offer marked `fits: false` is refused before anything is reserved or signed. Offers
  with `fits: null` (not checked) or a 402 without the header still follow the existing
  client-side `maxPerCallUsd` / `maxPerDayUsd` guards.

## 0.1.2 - 2026-11-06

- A `409 stale_payment_permit` refusal now frees the reservation, in the spend log too, and the error
  says to wait for the previous transaction. The server refuses it before verifying, so nothing can
  settle; it used to stay counted against the daily cap. Other 409s stay counted, and nothing is retried.
- Persistent daily spend limits, enabled by default, shared per wallet and network through a local
  JSON Lines log on one host. Reservations happen before signing; unknown outcomes remain counted
  and are never retried. Disable with `spendLog: false` or choose a writable path.
- Add `singit spend summary`, CSV export, and `readSpend` / `spendSummary` helpers.
- This is a local client-side guard, not on-chain enforcement, a ledger, proof of payment, or
  tamper-proof storage. Other tools and machines bypass it; network filesystems are unsupported.
  Wallet balance, server API-key limits, and the app's on-chain AgentAllowance remain separate.
- Dependencies: `@x402/core`, `@x402/evm`, `@x402/svm` 2.29.0 and `@solana/kit` 8.6.0, with offline
  Solana upto/exact signing tests.

## 0.1.1 - 2026-10-31

- Repository moved to SingItAi; links updated.
- README header with badges and links; links to the main repository now work outside the monorepo.
- `repository` and `bugs` in `package.json` point at this repository. They reach the npm page
  with this version.
- CI (Node 20 and 22), package-contents check, issue and pull request templates, security policy,
  Dependabot.

## 0.1.0

First published version of `@singitai/sdk` (see the history before the split).
