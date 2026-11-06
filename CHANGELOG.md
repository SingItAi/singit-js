# Changelog

This repository was split from [SingItAi/SingItAI](https://github.com/SingItAi/SingItAI)
(`sdk/typescript`) with its history kept.

## Unreleased

- A `409 stale_payment_permit` refusal now frees the reservation, in the spend log too, and the error
  says to wait for the previous transaction. The server refuses it before verifying, so nothing can
  settle; it used to stay counted against the daily cap. Other 409s stay counted, and nothing is retried.

## 0.1.2 - 2026-11-05

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
