import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("manifest permits public publication with an explicit file allowlist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.name, "@singitai/sdk");
  assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.files, ["src", "index.d.ts", "README.md", "LICENSE", "bin"]);
});

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
test('package ships the executable and spend modules', t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'singit-pack-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--cache', cache], { encoding: 'utf8' }))[0];
  for (const name of ['bin/singit.js', 'src/spend.js', 'src/spend-cli.js', 'src/cli.js']) assert.ok(packed.files.some(f => f.path === name));
  assert.equal(fs.statSync(new URL('../bin/singit.js', import.meta.url)).mode & 0o777, 0o755);
});
