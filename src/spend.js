import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { SingItPaymentError } from './guards.js';

export const defaultSpendPath = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(env.SINGIT_HOME || path.join(home, '.singit'), 'spend.jsonl');
export const atomicUsd = amount => {
  const n = BigInt(amount);
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, '0')}`;
};
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
function valid(row) {
  return row && row.v === 1 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.t)
    && Number.isFinite(Date.parse(row.t)) && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
    && /^[a-f0-9]{16}$/.test(row.id) && ['reserve', 'settle', 'release'].includes(row.event)
    && ['base', 'base-sepolia', 'solana'].includes(row.network) && typeof row.payer === 'string' && row.payer.length > 0
    && decimal(row.amountAtomic) && (row.event !== 'reserve' || (['upto', 'exact'].includes(row.scheme)
      && typeof row.resource === 'string' && Number.isInteger(row.pid)));
}

/** Read complete, valid lines and fold matching reservations. Missing files are empty. */
export function readSpend(file = defaultSpendPath()) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { payments: [], skippedLines: 0 };
    throw error;
  }
  const lines = data.split('\n');
  const tail = lines.pop();
  let skippedLines = tail ? 1 : 0;
  const rows = [];
  for (const line of lines) {
    try { const row = JSON.parse(line); if (!valid(row)) throw Error(); rows.push(row); }
    catch { skippedLines++; }
  }
  const reserves = new Map();
  const key = row => JSON.stringify([row.id, row.day, row.network, row.payer]);
  for (const row of rows) if (row.event === 'reserve' && !reserves.has(key(row))) reserves.set(key(row), { ...row });
  for (const row of rows) {
    const payment = reserves.get(key(row));
    if (!payment) continue;
    if (row.event === 'settle') payment.settlement = row;
    if (row.event === 'release') payment.released = true;
  }
  const payments = [...reserves.values()].map(p => ({
    ...p, status: p.settlement ? 'settled' : p.released ? 'released' : 'unresolved',
    ceilingAtomic: p.amountAtomic,
    spentAtomic: p.settlement?.amountAtomic ?? (p.released ? '0' : p.amountAtomic),
    tx: p.settlement?.tx ?? '',
  }));
  return { payments, skippedLines };
}
export function spendSummary({ file = defaultSpendPath(), days = 7, now = () => new Date() } = {}) {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  const { payments, skippedLines } = readSpend(file);
  const today = new Date(now()).toISOString().slice(0, 10);
  const first = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const groups = new Map();
  for (const p of payments) {
    if (p.day < first || p.day > today) continue;
    const key = JSON.stringify([p.day, p.network, p.payer]);
    const g = groups.get(key) ?? { day: p.day, network: p.network, payer: p.payer, payments: 0, spentAtomic: '0', spentUsd: '0.000000', settled: 0, unresolved: 0, released: 0 };
    g.payments++; g[p.status]++; g.spentAtomic = String(BigInt(g.spentAtomic) + BigInt(p.spentAtomic));
    g.spentUsd = atomicUsd(g.spentAtomic); groups.set(key, g);
  }
  return { file, days: [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || a.network.localeCompare(b.network) || a.payer.localeCompare(b.payer)), skippedLines };
}

export class PersistentDailyLimiter {
  constructor(capAtomic, { file = defaultSpendPath(), now = () => new Date(), network = 'base', payer = 'unknown' } = {}) {
    this.capAtomic = BigInt(capAtomic); this.file = file; this.now = now; this.scope = { network, payer };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'a+', 0o600); fs.closeSync(fd);
      fs.readFileSync(file);
    } catch {
      throw new SingItPaymentError(`Could not prepare spend log ${file}; pass spendLog:false (in-memory, resets on restart) or a writable path.`);
    }
  }
  _spent(day, scope) {
    return readSpend(this.file).payments.filter(p => p.day === day && p.network === scope.network && p.payer === scope.payer)
      .reduce((n, p) => n + BigInt(p.spentAtomic), 0n);
  }
  remainingAtomic() {
    const remaining = this.capAtomic - this._spent(new Date(this.now()).toISOString().slice(0, 10), this.scope);
    return remaining > 0n ? remaining : 0n;
  }
  _append(row) {
    let fd;
    try {
      const line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) >= 4095) throw Error('spend record too large');
      fd = fs.openSync(this.file, 'a+', 0o600);
      const size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size) fs.readSync(fd, last, 0, 1, size - 1);
      const data = (size && last[0] !== 10 ? '\n' : '') + line;
      if (fs.writeSync(fd, data) !== Buffer.byteLength(data)) throw Error('short write');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  reserve(amountAtomic, meta = this.scope) {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { const fd = fs.openSync(lock, 'wx', 0o600); try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); } break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw new SingItPaymentError(`Could not lock the spend log ${this.file}.`);
        try { if (Date.now() - fs.lstatSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; } } catch (e) { if (e.code === 'ENOENT') continue; }
        if (Date.now() >= deadline) throw new SingItPaymentError(`Could not lock the spend log ${this.file}.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    let row;
    try {
      const t = new Date(this.now()).toISOString();
      const day = t.slice(0, 10);
      const scope = { network: meta.network, payer: meta.payer };
      const spent = this._spent(day, scope), amount = BigInt(amountAtomic);
      if (spent + amount > this.capAtomic) throw new SingItPaymentError(`Daily spend cap reached: ${spent} already spent today, ${amount} more would exceed ${this.capAtomic} micro-USDC.`);
      const url = new URL(meta.resource);
      row = { v: 1, t, day, id: randomBytes(8).toString('hex'), event: 'reserve', ...scope, amountAtomic: String(amount), scheme: meta.scheme, resource: url.origin + url.pathname, pid: process.pid };
      this._append(row); this.scope = scope;
    } catch (error) {
      if (error instanceof SingItPaymentError) throw error;
      throw new SingItPaymentError(`Could not reserve in spend log ${this.file}; refusing payment before signing.`);
    } finally { try { fs.unlinkSync(lock); } catch { /* already removed as stale */ } }
    let done = false;
    const finish = (event, amount, tx) => {
      if (done) return; done = true;
      try { this._append({ v: 1, t: new Date(this.now()).toISOString(), day: row.day, id: row.id, event, network: row.network, payer: row.payer, amountAtomic: String(amount), ...(typeof tx === 'string' ? { tx } : {}) }); }
      catch { console.warn(`Could not append ${event} to spend log ${this.file}; reservation remains counted at its ceiling.`); }
    };
    const release = () => finish('release', row.amountAtomic);
    release.day = row.day; release.settle = (actual, tx) => finish('settle', actual, tx);
    return release;
  }
  settle(release, actual, worstCase, tx) { release.settle(actual ?? worstCase, tx); }
}
