// Linux only. Dedicated new volumes only; no recursive chown, deletion or repair.
import {
  constants as C, openSync, closeSync, fstatSync, fchmodSync, fchownSync,
  readdirSync, mkdirSync, writeFileSync, readFileSync, fsyncSync,
} from 'node:fs';
import { createHash } from 'node:crypto';

const UID = 10000, GID = 10000;
const O_PATH = 0o10000000; // Linux O_PATH; permits checking an existing private root without DAC override.
const at = (fd, name = '.') => `/proc/self/fd/${fd}/${name}`;
const fail = () => { throw new Error('Private volume refused: unexpected identity, ownership, permissions or contents; no repair attempted'); };
function privateDir(stat, uid = UID, gid = GID) {
  if (!stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== 0o700) fail();
}
// Hold every ancestor; refuse symlinks in any path component, including mount roots.
function directory(path, flags = C.O_RDONLY) {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) fail();
  let fd = openSync('/', O_PATH | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = openSync(at(fd, parts[i]), (i === parts.length - 1 ? flags : O_PATH) | C.O_DIRECTORY | C.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function prepareRoot(path) {
  const pathFD = directory(path, O_PATH);
  let fd;
  try {
    const stat = fstatSync(pathFD);
    if (stat.uid === UID) { privateDir(stat); return; } // Never chown an existing application root.
    if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || ![0o700, 0o755, 0o777].includes(stat.mode & 0o7777)) fail();
    fd = openSync(at(pathFD), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    if (readdirSync(at(fd)).length !== 0) fail(); // Includes lost+found: provision an explicitly empty dedicated volume.
    fchmodSync(fd, 0o700);
    fchownSync(fd, UID, GID);
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); closeSync(pathFD); }
}

function identity(env) {
  const owner = env.HERMES_MCP_PRIVATE_OWNER ?? '', tunnel = env.HERMES_MCP_TUNNEL_ID ?? '';
  if (env.HERMES_MCP_AUTH_MODE !== 'private-tunnel' || !owner || owner.trim() !== owner
      || Buffer.byteLength(owner) > 256 || /[\p{Cc}\p{Cf}]/u.test(owner)
      || !/^tunnel_[a-z0-9]{32}$/.test(tunnel)) fail();
  return { version: 1, mode: 'private-tunnel', principal: createHash('sha256').update(JSON.stringify([owner, tunnel])).digest('hex') };
}

export function prepareState(path, env = process.env, uid = UID, gid = GID) {
  // uid/gid parameters are for the unprivileged fixture, never CLI-configurable.
  const binding = identity(env), fd = directory(path);
  const marker = '.private-tunnel-volume.json';
  try {
    privateDir(fstatSync(fd), uid, gid);
    const names = readdirSync(at(fd));
    if (names.length === 0) {
      // Marker is written LAST. Interrupted initialization is deliberately fail-closed.
      for (const name of ['state', 'outputs']) mkdirSync(at(fd, name), { mode: 0o700 });
      const out = openSync(at(fd, marker), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try { writeFileSync(out, JSON.stringify(binding)); fsyncSync(out); } finally { closeSync(out); }
      fsyncSync(fd);
    } else {
      if (names.length !== 3 || ![marker, 'state', 'outputs'].every(name => names.includes(name))) fail();
      const input = openSync(at(fd, marker), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const s = fstatSync(input);
        if (!s.isFile() || s.uid !== uid || s.gid !== gid || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1 || s.size > 1024) fail();
        if (readFileSync(input, 'utf8') !== JSON.stringify(binding)) fail();
      } finally { closeSync(input); }
    }
    for (const name of ['state', 'outputs']) {
      const child = openSync(at(fd, name), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      try { privateDir(fstatSync(child), uid, gid); } finally { closeSync(child); }
    }
    // The application verifies the ledger, its binding, locks and 0600 state files.
    // Nothing here clears writer.lock or recreates a missing state/output directory.
  } finally { closeSync(fd); }
}

export function prepareScratch(path) {
  const fd = directory(path);
  try {
    privateDir(fstatSync(fd));
    for (const name of ['config', 'cache', 'state', 'run']) {
      try { mkdirSync(at(fd, name), { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const child = openSync(at(fd, name), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      try { privateDir(fstatSync(child)); } finally { closeSync(child); }
    }
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  process.umask(0o077);
  try {
    if (process.argv[2] === 'roots' && process.argv.length === 3 && process.getuid() === 0) {
      for (const path of ['/work/data', '/work/mcp-temp', '/work/tunnel-temp']) prepareRoot(path);
    } else if (process.argv[2] === 'private' && process.argv.length === 3 && process.getuid() === UID) {
      prepareState('/work/data');
      for (const path of ['/work/mcp-temp', '/work/tunnel-temp']) prepareScratch(path);
    } else fail();
  } catch { console.error('Private volume initialization refused; inspect the dedicated volumes offline. No automatic repair.'); process.exit(1); }
}
