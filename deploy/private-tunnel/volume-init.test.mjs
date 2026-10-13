import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, statSync, readFileSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { prepareRoot, prepareState } from './volume-init.mjs';

// One isolated fixture; no deletion, real PVC, privilege escalation or ownership changes.
const root = mkdtempSync('/tmp/opencode/private-tunnel-init-');
const uid = process.getuid(), gid = process.getgid();
const env = { HERMES_MCP_AUTH_MODE: 'private-tunnel', HERMES_MCP_PRIVATE_OWNER: 'offline-fixture-owner', HERMES_MCP_TUNNEL_ID: `tunnel_${'a'.repeat(32)}` };
const prepare = (path, config = env) => prepareState(path, config, uid, gid);
function fresh(name) { const path = `${root}/${name}`; mkdirSync(path, { mode: 0o700 }); return path; }

test('single private-volume fixture: new, repeat, identity/owner/mode/symlink/old-state refusal', () => {
  const volume = fresh('new');
  prepare(volume);
  for (const name of ['state', 'outputs']) {
    expect(statSync(`${volume}/${name}`).mode & 0o777).toBe(0o700);
    expect(statSync(`${volume}/${name}`).uid).toBe(uid);
  }
  const marker = `${volume}/.private-tunnel-volume.json`;
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  const binding = readFileSync(marker, 'utf8');
  writeFileSync(`${volume}/state/state.json`, 'sentinel-existing-ledger', { mode: 0o600 });
  prepare(volume);
  expect(readFileSync(marker, 'utf8')).toBe(binding);
  expect(readFileSync(`${volume}/state/state.json`, 'utf8')).toBe('sentinel-existing-ledger');
  expect(() => prepare(volume, { ...env, HERMES_MCP_PRIVATE_OWNER: 'different-owner' })).toThrow();
  expect(() => prepare(volume, { ...env, HERMES_MCP_TUNNEL_ID: `tunnel_${'b'.repeat(32)}` })).toThrow();
  expect(() => prepare(volume, { ...env, HERMES_MCP_AUTH_MODE: 'oauth' })).toThrow();
  expect(() => prepareState(volume, env, uid + 1, gid)).toThrow();
  chmodSync(`${volume}/outputs`, 0o755);
  expect(() => prepare(volume)).toThrow();
  chmodSync(`${volume}/outputs`, 0o700);
  const linkedRoot = `${root}/root-link`;
  symlinkSync(volume, linkedRoot);
  expect(() => prepare(linkedRoot)).toThrow();
  expect(() => prepareRoot(linkedRoot)).toThrow();
  symlinkSync(root, `${root}/ancestor-link`);
  expect(() => prepare(`${root}/ancestor-link/new`)).toThrow();
  const old = fresh('unexpected-old');
  mkdirSync(`${old}/state`, { mode: 0o700 });
  expect(() => prepare(old)).toThrow();
  const partial = fresh('partial');
  prepare(partial);
  renameSync(`${partial}/state`, `${root}/saved-state`);
  expect(() => prepare(partial)).toThrow(); // Never replace a missing ledger directory.
  symlinkSync(`${root}/saved-state`, `${partial}/state`);
  expect(() => prepare(partial)).toThrow();
  const linkedMarker = fresh('linked-marker');
  mkdirSync(`${linkedMarker}/state`, { mode: 0o700 });
  mkdirSync(`${linkedMarker}/outputs`, { mode: 0o700 });
  symlinkSync(marker, `${linkedMarker}/.private-tunnel-volume.json`);
  expect(() => prepare(linkedMarker)).toThrow();
  if (uid !== 0 && uid !== 10000) expect(() => prepareRoot(fresh('wrong-root-owner'))).toThrow();
  console.log(`Fixture retained at ${root}; UID/GID ${uid}/${gid}. Real root-to-10000 chown and CSI/PV permissions NOT tested.`);
});
