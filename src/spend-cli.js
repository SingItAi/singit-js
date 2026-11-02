import fs from 'node:fs';
import { defaultSpendPath, readSpend, spendSummary, atomicUsd } from './spend.js';
const usage = 'Usage: singit spend summary [--days N] [--file PATH] [--json] | export --csv [--days N] [--file PATH]\n';
const csv = value => {
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
export async function spendMain(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, home } = {}) {
  const [command, ...args] = argv;
  let file = defaultSpendPath({ env, home }), days = 7, json = false, exportCsv = false;
  const bad = () => { stderr.write(usage); return 2; };
  if (!['summary', 'export'].includes(command)) return bad();
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) return bad(); seen.add(arg);
    if (arg === '--json' && command === 'summary') json = true;
    else if (arg === '--csv' && command === 'export') exportCsv = true;
    else if (arg === '--days') {
      const n = args[++i]; if (!/^[1-9][0-9]*$/.test(n ?? '') || !Number.isSafeInteger(Number(n)) || Number(n) > 1000000) return bad(); days = Number(n);
    } else if (arg === '--file') { file = args[++i]; if (!file || file.startsWith('--')) return bad(); }
    else return bad();
  }
  if (command === 'export' && !exportCsv) return bad();
  try {
    const summary = spendSummary({ file, days });
    if (command === 'export') {
      const first = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      stdout.write('day,time,id,network,payer,scheme,resource,status,ceilingAtomic,spentAtomic,tx\n');
      for (const p of readSpend(file).payments.filter(p => p.day >= first && p.day <= today)) {
        stdout.write([p.day, p.t, p.id, p.network, p.payer, p.scheme, p.resource, p.status, p.ceilingAtomic, p.spentAtomic, p.tx].map(csv).join(',') + '\n');
      }
    } else if (json) stdout.write(JSON.stringify(summary) + '\n');
    else if (!fs.existsSync(file)) stdout.write(`No spend log yet at ${file}.\n`);
    else {
      stdout.write(`Spend log: ${file}\nLocal client-side log: not on-chain enforcement.\nDay Network Payer Payments Spent (USDC) Settled Unresolved Released\n`);
      const totals = { payments: 0, spentAtomic: 0n, settled: 0, unresolved: 0, released: 0 };
      for (const g of summary.days) {
        const payer = g.payer === 'unknown' ? g.payer : `${g.payer.slice(0, 6)}...${g.payer.slice(-4)}`;
        stdout.write(`${g.day} ${g.network} ${payer} ${g.payments} ${g.spentUsd} ${g.settled} ${g.unresolved} ${g.released}\n`);
        for (const k of ['payments', 'settled', 'unresolved', 'released']) totals[k] += g[k];
        totals.spentAtomic += BigInt(g.spentAtomic);
      }
      stdout.write(`Totals ${totals.payments} ${atomicUsd(totals.spentAtomic)} ${totals.settled} ${totals.unresolved} ${totals.released}\nUnresolved payments are counted at their ceiling.\n`);
      if (summary.skippedLines) stdout.write(`Skipped unreadable lines: ${summary.skippedLines}\n`);
    }
    return 0;
  } catch { stderr.write(`Could not read spend log ${file}.\n`); return 1; }
}
