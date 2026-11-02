import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generatePrivateKey } from 'viem/accounts';
import { PersistentDailyLimiter, readSpend, spendSummary, SingIt } from '../src/index.js';
import { SingItPaymentError } from '../src/guards.js';
import { spendMain } from '../src/spend-cli.js';
import { main } from '../src/cli.js';
import { startMerchant, exactOffer } from './helpers/merchant.mjs';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singit-spend-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'private', 'spend.jsonl'); }
const meta = { network: 'base', payer: '0x1111111111111111111111111111111111111111', scheme: 'upto', resource: 'https://user:password@example.com/a?q=secret#fragment' };
function child(args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [new URL('./helpers/spend-child.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, ...env } });
    let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
    p.on('error', reject); p.on('close', code => resolve({ code, output }));
  });
}
test('persistent reservations settle, release, survive restart, and separate scopes', t => {
  const file = temp(t), limiter = new PersistentDailyLimiter('100', { file });
  const a = limiter.reserve('60', meta);
  assert.equal(limiter.remainingAtomic(), 40n);
  assert.throws(() => new PersistentDailyLimiter('100', { file }).reserve('50', meta), /Daily spend cap reached/);
  limiter.settle(a, '20', '60', '0xfake');
  assert.equal(limiter.remainingAtomic(), 80n);
  const b = limiter.reserve('70', meta); b(); b();
  assert.equal(limiter.remainingAtomic(), 80n);
  limiter.reserve('100', { ...meta, payer: 'another' });
  limiter.reserve('100', { ...meta, network: 'solana' });
  const rows = readSpend(file).payments;
  assert.deepEqual(rows.map(p => p.status), ['settled', 'released', 'unresolved', 'unresolved']);
  assert.equal(rows[0].resource, 'https://example.com/a');
  assert.equal(rows[0].tx, '0xfake');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});
test('UTC rollover preserves original reservation day', t => {
  const file = temp(t); let now = new Date('2026-11-01T23:59:59Z');
  const l = new PersistentDailyLimiter('100', { file, now: () => now });
  const r = l.reserve('100', meta); now = new Date('2026-11-02T00:00:01Z');
  assert.equal(l.remainingAtomic(), 100n); l.reserve('100', meta); l.settle(r, '20', '100');
  assert.equal(l.remainingAtomic(), 0n);
  assert.equal(spendSummary({ file, now: () => now }).days.length, 2);
});
test('corrupt and partial lines are skipped; append recovers a fresh line; settle wins', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const r = l.reserve('50', meta);
  fs.appendFileSync(file, 'bad\n{"v":2}\n{"partial":');
  assert.equal(readSpend(file).skippedLines, 3);
  l.settle(r, '10', '50');
  const reserve = readSpend(file).payments[0];
  fs.appendFileSync(file, JSON.stringify({ ...reserve, event: 'release', amountAtomic: '50' }) + '\n');
  assert.equal(readSpend(file).payments[0].spentAtomic, '10');
  assert.equal(readSpend(file).skippedLines, 3);
});
test('construction fails clearly and disabled persistence touches no file', t => {
  const file = temp(t); fs.mkdirSync(file, { recursive: true });
  assert.throws(() => new PersistentDailyLimiter('100', { file }), /spendLog:false.*writable path/);
  assert.doesNotThrow(() => new SingIt({ spendLog: false, network: 'base', maxPerCallUsd: 1, maxPerDayUsd: 1 }));
});
test('stale locks recover and lock symlinks are never followed', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const target = path.join(path.dirname(file), 'target'); fs.writeFileSync(target, '');
  fs.symlinkSync(target, file + '.lock');
  const old = new Date(Date.now() - 31000); fs.lutimesSync(file + '.lock', old, old);
  l.reserve('10', meta); assert.equal(fs.readFileSync(target, 'utf8'), '');
});
test('terminal append failures warn and retain safe ceiling; reserve failure refuses payment', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const r = l.reserve('60', meta); const append = l._append;
  l._append = () => { throw Error('disk failed'); };
  const warnings = []; t.mock.method(console, 'warn', s => warnings.push(s));
  assert.doesNotThrow(() => l.settle(r, '10', '60'));
  assert.equal(l.remainingAtomic(), 40n); assert.equal(warnings.length, 1);
  assert.throws(() => l.reserve('10', meta), /before signing/);
  l._append = append;
});
test('six simultaneous processes admit exactly three reservations', async t => {
  const file = temp(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => child(['reserve', file])));
  assert.equal(results.filter(r => r.code === 0).length, 3, JSON.stringify(results));
  assert.equal(readSpend(file).payments.reduce((n, p) => n + BigInt(p.spentAtomic), 0n), 3000n);
});
test('real SDK payments share cap across sequential processes, with separate payer scope', async t => {
  const file = temp(t); let paid = 0;
  const merchant = await startMerchant({ accepts: () => [exactOffer({ network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x000000000000000000000000000000000000ab1e', amount: '4000' })], bill: () => { paid++; return '4000'; } });
  t.after(() => merchant.close());
  const env = { SINGIT_HOME: path.dirname(file), TEST_KEY: generatePrivateKey() };
  assert.equal((await child(['pay', file, merchant.url], env)).code, 0); assert.equal(paid, 1);
  const second = await child(['pay', file, merchant.url], env);
  assert.equal(second.code, 1); assert.match(second.output, /Daily spend cap reached/); assert.equal(paid, 1);
  assert.equal((await child(['other', file, merchant.url], env)).code, 0); assert.equal(paid, 2);
});
async function cli(args, options = {}) {
  let out = '', err = ''; const code = await spendMain(args, { ...options, stdout: { write: s => out += s }, stderr: { write: s => err += s } }); return { code, out, err };
}
test('CLI summary, JSON, CSV escaping and formula neutralization, missing and bad options', async t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  l.reserve('10', { ...meta, payer: '=fake,"payer\n', resource: 'https://example.com/a,b' });
  const human = await cli(['summary', '--file', file]);
  assert.equal(human.code, 0); assert.match(human.out, /Local client-side log: not on-chain enforcement/); assert.match(human.out, /0.000010/);
  const json = await cli(['summary', '--json', '--file', file]); assert.equal(JSON.parse(json.out).days[0].unresolved, 1);
  const csv = await cli(['export', '--csv', '--file', file]); assert.match(csv.out, /"'=fake,""payer\n"/); assert.match(csv.out, /"https:\/\/example.com\/a,b"/);
  assert.match((await cli(['summary'], { env: { SINGIT_HOME: path.dirname(file) }, home: '/never-used' })).out, /Spend log:/);
  assert.match((await cli(['summary', '--file', file + '-missing'])).out, /No spend log yet/);
  for (const args of [['summary', '--days', '0'], ['export'], ['summary', '--wat'], ['summary', '--file']]) assert.equal((await cli(args)).code, 2);
  assert.equal((await cli(['summary', '--file', path.dirname(file)])).code, 1);
  let usage = ''; assert.equal(await main([], { stderr: { write: s => usage += s } }), 2); assert.match(usage, /Usage: singit spend/);
});
test('Python-format fixture is readable by summary with identical accounting', () => {
  const file = new URL('./fixtures/python-spend.jsonl', import.meta.url).pathname;
  const result = spendSummary({ file, now: () => new Date('2026-11-02T18:00:00Z') });
  assert.equal(result.skippedLines, 0); assert.equal(result.days[0].spentAtomic, '4500');
  assert.equal(result.days[0].settled, 1);
});
test('SDK preserves unknown outcomes, records signing failure/refusal, and checks pins before signing', async t => {
  const { NETWORKS } = await import('../src/pins.js');
  const pin = NETWORKS.base;
  for (const mode of ['unknown', 'sign-failure', 'refused', 'wrong-pin', 'settled']) {
    const file = temp(t); let signed = 0, sent = 0;
    const client = new SingIt({ spendLog: file, network: 'base', maxPerCallUsd: 0.004, maxPerDayUsd: 0.006,
      fetchImpl: async (_url, init) => {
        if (!init.headers['PAYMENT-SIGNATURE']) return new Response('{}', { status: 402, headers: {
          'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://ask.singitai.app/v1/chat/completions' }, accepts: [{
            scheme: 'exact', network: pin.caip, asset: pin.asset, payTo: mode === 'wrong-pin' ? 'bad' : pin.payTo,
            amount: '4000', maxTimeoutSeconds: 120,
          }] })).toString('base64'),
        } });
        sent++; if (mode === 'unknown') throw Error('connection lost');
        if (mode === 'refused') return new Response('{}', { status: 402 });
        return new Response('{"billing":{"totalAtomic":"4000"}}');
      } });
    client._sign = async () => { signed++; if (mode === 'sign-failure') throw Error('sign failed'); return { payload: {} }; };
    const invoke = () => client.chat({ messages: [{ role: 'user', content: 'not logged' }], scheme: 'exact' });
    if (mode === 'settled') await invoke(); else await assert.rejects(invoke());
    const records = readSpend(file).payments;
    if (mode === 'wrong-pin') { assert.equal(signed, 0); assert.equal(records.length, 0); }
    else assert.equal(records[0].status, mode === 'unknown' ? 'unresolved' : mode === 'settled' ? 'settled' : 'released');
    if (mode === 'unknown') { await assert.rejects(invoke(), /Daily spend cap/); assert.equal(sent, 1); assert.equal(signed, 1); }
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /not logged|PAYMENT-SIGNATURE/);
  }
});

test('lock recovery preserves replacements and cleans stale recovery guards', t => {
  const dead = spawnSync(process.execPath, ['-e', '']);
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const lock = file + '.lock', guard = lock + '.recover';
  fs.writeFileSync(lock, `${dead.pid}:0000000000000000`);
  fs.utimesSync(lock, 0, 0);
  fs.writeFileSync(guard, `${dead.pid}:1111111111111111`); fs.utimesSync(guard, 0, 0);
  l.reserve('10', meta);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(guard), false);
  fs.writeFileSync(lock, 'replacement:2222222222222222'); fs.utimesSync(lock, 0, 0);
  l._recoverLock(lock, 'observed:3333333333333333');
  l._releaseLock(lock, 'observed:3333333333333333');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement:2222222222222222');
});
test('fresh lock times out without removing its owner', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  fs.writeFileSync(file + '.lock', 'other:0000000000000000');
  const now = Date.now(); let calls = 0;
  t.mock.method(Date, 'now', () => now + (calls++ ? 6000 : 0));
  assert.throws(() => l.reserve('10', meta), /Could not lock the spend log/);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'other:0000000000000000');
});
test('fsync failures roll back reservations and terminal events', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const r = l.reserve('60', meta);
  t.mock.method(fs, 'fsyncSync', () => { throw Error('sync failed'); });
  assert.throws(() => l.reserve('10', meta), /refusing payment before signing/);
  assert.equal(readSpend(file).payments.length, 1);
  const warnings = []; t.mock.method(console, 'warn', s => warnings.push(s));
  l.settle(r, '10', '60');
  assert.equal(readSpend(file).payments[0].spentAtomic, '60');
  assert.equal(warnings.length, 1);
});
test('lock holders write interoperable unique tokens and preserve replacement on release', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  const append = l._append.bind(l);
  l._append = row => {
    assert.match(fs.readFileSync(file + '.lock', 'utf8'), new RegExp(`^${process.pid}:[0-9a-f]{16}:[^:]+$`));
    fs.writeFileSync(file + '.lock', 'replacement');
    append(row);
  };
  l.reserve('10', meta);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'replacement');
});
test('fresh recovery guard prevents stale main recovery until timeout', t => {
  const file = temp(t), l = new PersistentDailyLimiter('100', { file });
  fs.writeFileSync(file + '.lock', 'old'); fs.utimesSync(file + '.lock', 0, 0);
  fs.writeFileSync(file + '.lock.recover', 'busy');
  const now = Date.now(); let calls = 0;
  t.mock.method(Date, 'now', () => now + (calls++ ? 6000 : 0));
  assert.throws(() => l.reserve('10', meta), /Could not lock the spend log/);
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'old');
  assert.equal(fs.readFileSync(file + '.lock.recover', 'utf8'), 'busy');
});
test('reservation fsync failure prevents SDK signing', async t => {
  const { NETWORKS } = await import('../src/pins.js');
  const file = temp(t), pin = NETWORKS.base;
  const client = new SingIt({ spendLog: file, network: 'base', maxPerCallUsd: .004, maxPerDayUsd: .006,
    fetchImpl: async () => new Response('{}', { status: 402, headers: {
      'payment-required': Buffer.from(JSON.stringify({ x402Version: 2,
        resource: { url: 'https://ask.singitai.app/v1/chat/completions' }, accepts: [{
          scheme: 'exact', network: pin.caip, asset: pin.asset, payTo: pin.payTo,
          amount: '4000', maxTimeoutSeconds: 120,
        }] })).toString('base64'),
    } }) });
  let signed = 0; client._sign = async () => { signed++; return { payload: {} }; };
  t.mock.method(fs, 'fsyncSync', () => { throw Error('sync failed'); });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'test' }], scheme: 'exact' }), /before signing/);
  assert.equal(signed, 0); assert.equal(readSpend(file).payments.length, 0);
});

for (const guard of [false, true]) {
  for (const kind of ['dead', 'live', 'foreign', 'empty', 'legacy', 'legacy-token', 'invalid']) {
    test(`old ${guard ? 'guard' : 'lock'} owner: ${kind}`, t => {
      const dead = spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      const host = os.hostname().replaceAll(':', '_');
      const tokens = { dead: `${dead.pid}:0123456789abcdef:${host}`,
        live: `${process.pid}:0123456789abcdef:${host}`,
        foreign: `${dead.pid}:0123456789abcdef:${host}-foreign`, empty: '',
        legacy: String(dead.pid), 'legacy-token': `${dead.pid}:0123456789abcdef`, invalid: 'broken' };
      const file = temp(t), l = new PersistentDailyLimiter('100', { file });
      const lock = file + '.lock', target = guard ? lock + '.recover' : lock;
      if (guard) { fs.writeFileSync(lock, tokens.dead); fs.utimesSync(lock, 0, 0); }
      fs.writeFileSync(target, tokens[kind]); fs.utimesSync(target, 0, 0);
      if (['dead', 'empty', 'legacy', 'legacy-token'].includes(kind)) {
        l.reserve('10', meta);
        assert.equal(fs.existsSync(target), false);
      } else {
        const now = Date.now(); let calls = 0;
        t.mock.method(Date, 'now', () => now + (calls++ ? 6000 : 0));
        assert.throws(() => l.reserve('10', meta), error => {
          assert.ok(error instanceof SingItPaymentError);
          assert.ok(error.message.endsWith(` If no other SingIt process is running, delete ${file}.lock.`));
          return true;
        });
        assert.equal(fs.readFileSync(target, 'utf8'), tokens[kind]);
        assert.equal(readSpend(file).payments.length, 0);
      }
    });
  }
}

for (const code of ['EPERM', 'EACCES', 'EINVAL']) {
  test(`owner probe ${code} fails closed`, t => {
    const file = temp(t), l = new PersistentDailyLimiter('100', { file });
    const lock = file + '.lock', token = `${process.pid}:0123456789abcdef`;
    fs.writeFileSync(lock, token); fs.utimesSync(lock, 0, 0);
    t.mock.method(process, 'kill', () => { throw Object.assign(Error('probe failed'), { code }); });
    l._recoverLock(lock, token);
    assert.equal(fs.readFileSync(lock, 'utf8'), token);
  });
}
