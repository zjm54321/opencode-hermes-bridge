import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, statSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { prepareState } from './volume-init.mjs';

const root = mkdtempSync('/tmp/opencode/private-tunnel-init-');
const prepare = path => prepareState(path, process.getuid(), process.getgid());
function fresh(name) { const path = `${root}/${name}`; mkdirSync(path, { mode: 0o700 }); return path; }
console.log(`Fixture: ${root}. Unprivileged only; root-to10000 chown and CSI/PV permissions NOT tested.`);

test('new private directories and existing ledger survive repeated initialization', () => {
  const volume = fresh('normal');
  prepare(volume);
  expect(statSync(`${volume}/state`).mode & 0o777).toBe(0o700);
  expect(statSync(`${volume}/outputs`).mode & 0o777).toBe(0o700);
  writeFileSync(`${volume}/state/state.json`, 'untouched-ledger', { mode: 0o600 });
  prepare(volume);
  expect(readFileSync(`${volume}/state/state.json`, 'utf8')).toBe('untouched-ledger');
});

test('foreign/symlink roots and outputs without a ledger are refused without repair', () => {
  const foreign = fresh('foreign');
  mkdirSync(`${foreign}/unrecognized`);
  expect(() => prepare(foreign)).toThrow();
  const linked = fresh('linked');
  mkdirSync(`${linked}/state`, { mode: 0o700 });
  symlinkSync(foreign, `${linked}/outputs`);
  expect(() => prepare(linked)).toThrow();
  const lost = fresh('missing-ledger');
  prepare(lost);
  writeFileSync(`${lost}/outputs/retained`, 'do-not-delete', { mode: 0o600 });
  expect(() => prepare(lost)).toThrow();
  expect(readFileSync(`${lost}/outputs/retained`, 'utf8')).toBe('do-not-delete');
});
