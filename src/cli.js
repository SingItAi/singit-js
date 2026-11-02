import { spendMain } from './spend-cli.js';
export async function main(argv, io = {}) {
  if (argv[0] === 'spend') return spendMain(argv.slice(1), io);
  (io.stderr ?? process.stderr).write('Usage: singit spend summary|export ...\n');
  return 2;
}
