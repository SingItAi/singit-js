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

// Tokens are shared with the Python implementation; never release a replacement lock.
const hostname = () => os.hostname().replaceAll(':', '_');
const lockToken = () => `${process.pid}:${randomBytes(8).toString('hex')}:${hostname()}`;
function ownerDead(token) {
  if (token === '') return true; // Only used after the age check.
  const match = /^([1-9][0-9]*)(?::[0-9a-f]{16}(?::([^:]+))?)?$/.exec(token);
  if (!match || match[0] !== token || (match[2] !== undefined && match[2] !== hostname())) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
}
function releaseLock(file, token) {
  try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function createLock(file, token) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
}
function syncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } } }
}

// EVM addresses are case-insensitive: one wallet must share one allowance however a caller spells it. Solana keeps its case.
const scopePayer = (network, payer) => (network !== 'solana' && typeof payer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(payer) ? payer.toLowerCase() : payer);

export class PersistentDailyLimiter {
  constructor(capAtomic, { file = defaultSpendPath(), now = () => new Date(), network = 'base', payer = 'unknown' } = {}) {
    this.capAtomic = BigInt(capAtomic); this.file = file; this.now = now; this.scope = { network, payer: scopePayer(network, payer) };
    try {
      const created = fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'a+', 0o600);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(path.dirname(file));
      if (created) {
        let directory = path.dirname(file);
        while (directory !== path.dirname(created)) {
          syncDirectory(path.dirname(directory));
          directory = path.dirname(directory);
        }
      }
      this._canonicalFile = fs.realpathSync(file);
      fs.readFileSync(this._canonicalFile);
    } catch {
      throw new SingItPaymentError(`Could not prepare spend log ${file}; pass spendLog:false (in-memory, resets on restart) or a writable path.`);
    }
  }
  _spent(day, scope) {
    return readSpend(this._canonicalFile).payments.filter(p => p.day === day && p.network === scope.network && scopePayer(p.network, p.payer) === scopePayer(scope.network, scope.payer))
      .reduce((n, p) => n + BigInt(p.spentAtomic), 0n);
  }
  remainingAtomic() {
    const remaining = this.capAtomic - this._spent(new Date(this.now()).toISOString().slice(0, 10), this.scope);
    return remaining > 0n ? remaining : 0n;
  }
  // Callers hold the main lock, including terminal events, so rollback cannot
  // truncate another process's append after a write or fsync failure.
  _append(row) {
    let fd, size;
    try {
      const line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) >= 4095) throw Error('spend record too large');
      fd = fs.openSync(this._canonicalFile, 'a+', 0o600);
      size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size) fs.readSync(fd, last, 0, 1, size - 1);
      const data = (size && last[0] !== 10 ? '\n' : '') + line;
      if (fs.writeSync(fd, data) !== Buffer.byteLength(data)) throw Error('short write');
      fs.fsyncSync(fd);
    } catch (error) {
      if (size !== undefined) { fs.ftruncateSync(fd, size); try { fs.fsyncSync(fd); } catch { /* original failure */ } }
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  _releaseLock(file, token) { releaseLock(file, token); }
  _recoverLock(lock, observed) {
    const guard = `${lock}.recover`, token = lockToken();
    try { createLock(guard, token); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.lstatSync(guard).mtimeMs > 30000) {
          const stale = fs.readFileSync(guard, 'utf8');
          if (ownerDead(stale)) releaseLock(guard, stale);
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return;
    }
    try {
      if (fs.readFileSync(lock, 'utf8') === observed && Date.now() - fs.lstatSync(lock).mtimeMs > 30000 && ownerDead(observed))
        fs.unlinkSync(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { releaseLock(guard, token); }
  }
  _acquireLock() {
    const lock = `${this._canonicalFile}.lock`, token = lockToken();
    const deadline = Date.now() + 5000;
    for (;;) {
      try { createLock(lock, token); return token; }
      catch (error) {
        if (error.code !== 'EEXIST') throw new SingItPaymentError(`Could not lock the spend log ${this.file}.`);
        try {
          if (Date.now() - fs.lstatSync(lock).mtimeMs > 30000)
            this._recoverLock(lock, fs.readFileSync(lock, 'utf8'));
        } catch { /* vanished or unreadable: retry until the deadline */ }
        if (Date.now() >= deadline) throw new SingItPaymentError(`Could not lock the spend log ${this.file}. If no other SingIt process is running, delete ${this.file}.lock.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }
  reserve(amountAtomic, meta = this.scope) {
    const lock = `${this._canonicalFile}.lock`, token = this._acquireLock();
    let row;
    try {
      const t = new Date(this.now()).toISOString();
      const day = t.slice(0, 10);
      const scope = { network: meta.network, payer: scopePayer(meta.network, meta.payer) };
      const spent = this._spent(day, scope), amount = BigInt(amountAtomic);
      if (amount < 0n) throw new SingItPaymentError('A reserved amount cannot be negative.');
      if (spent + amount > this.capAtomic) throw new SingItPaymentError(`Daily spend cap reached: ${spent} already spent today, ${amount} more would exceed ${this.capAtomic} micro-USDC.`);
      const url = new URL(meta.resource);
      row = { v: 1, t, day, id: randomBytes(8).toString('hex'), event: 'reserve', ...scope, amountAtomic: String(amount), scheme: meta.scheme, resource: url.origin + url.pathname, pid: process.pid };
      this._append(row); this.scope = scope;
    } catch (error) {
      if (error instanceof SingItPaymentError) throw error;
      throw new SingItPaymentError(`Could not reserve in spend log ${this.file}; refusing payment before signing.`);
    } finally { releaseLock(lock, token); }
    let done = false;
    const finish = (event, amount, tx) => {
      if (done) return; done = true;
      let finishToken;
      try { finishToken = this._acquireLock(); this._append({ v: 1, t: new Date(this.now()).toISOString(), day: row.day, id: row.id, event, network: row.network, payer: row.payer, amountAtomic: String(BigInt(amount)), ...(typeof tx === 'string' ? { tx } : {}) }); }
      catch { console.warn(`Could not append ${event} to spend log ${this.file}; reservation remains counted at its ceiling.`); }
      finally { if (finishToken) releaseLock(lock, finishToken); }
    };
    const release = () => finish('release', row.amountAtomic);
    release.day = row.day; release.settle = (actual, tx) => finish('settle', actual, tx);
    return release;
  }
  settle(release, actual, worstCase, tx) { release.settle(actual ?? worstCase, tx); }
}
