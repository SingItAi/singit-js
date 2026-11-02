import { SingIt, PersistentDailyLimiter } from '../../src/index.js';
import { generatePrivateKey } from 'viem/accounts';
const [mode, file, url] = process.argv.slice(2);
try {
  if (mode === 'reserve') {
    new PersistentDailyLimiter('3000', { file }).reserve('1000', {
      network: 'base', payer: 'unknown', scheme: 'exact', resource: 'http://localhost/test',
    });
  } else {
    const key = mode === 'other' ? generatePrivateKey() : process.env.TEST_KEY;
    const client = new SingIt({ evmPrivateKey: key, network: 'base-sepolia', baseUrl: url,
      payTo: '0x000000000000000000000000000000000000ab1e', maxPerCallUsd: 0.004, maxPerDayUsd: 0.006 });
    await client.chat({ messages: [{ role: 'user', content: 'test' }], scheme: 'exact' });
  }
  console.log('ok');
} catch (error) { console.log(error.message); process.exitCode = 1; }
