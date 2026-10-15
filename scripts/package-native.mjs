// Build, pack and import the exact publishable tarball. Never publish or touch live dist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
assert(process.argv.length === 3 && isAbsolute(process.argv[2]), 'Supply a new absolute staging directory outside the repository');
const root = resolve(process.argv[2]);
assert(!existsSync(root) && !existsSync(`${root}.tgz`));
const parent = realpathSync(dirname(root));
assert(parent === dirname(root), 'Staging parent must not contain symlinks');
const rel = relative(source, root);
assert(rel === '..' || rel.startsWith(`..${sep}`), 'Staging must be outside the repository');
mkdirSync(root, { mode: 0o700 });
const stage = join(root, 'package'), consumer = join(root, 'consumer'), unpack = join(root, 'unpacked');
for (const dir of [stage, consumer, unpack, join(root, 'home'), join(root, 'cache')]) mkdirSync(dir, { mode: 0o700 });
const userConfig = join(root, 'empty-user.npmrc'), globalConfig = join(root, 'empty-global.npmrc');
for (const path of [userConfig, globalConfig]) writeFileSync(path, '', { mode: 0o600 });
// Only public registry operations occur in subprocesses; never inherit user npmrc, proxy credentials or CI OIDC credentials.
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root, CI: 'true',
  NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(root, 'cache'),
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_PACKAGE_LOCK: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(root, log), result.stdout ?? '', { mode: 0o600 });
  writeFileSync(join(root, `${log}.stderr`), result.stderr ?? '', { mode: 0o600 });
  assert(!result.error && result.status === 0, `${command} failed; inspect the private ${log}`);
  return result.stdout;
}
function rejectLinks(path) {
  const info = lstatSync(path);
  assert(!info.isSymbolicLink(), 'Source symlinks are not pack inputs');
  if (info.isDirectory()) for (const name of readdirSync(path)) rejectLinks(join(path, name));
  else assert(info.isFile());
}
for (const name of ['package.json', 'README.md', 'LICENSE', 'src', 'docs']) {
  rejectLinks(join(source, name));
  cpSync(join(source, name), join(stage, name), { recursive: true, errorOnExist: true });
}
const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'opencode-hermes-bridge');
assert.equal(pkg.repository.url, 'git+https://github.com/zjm54321/opencode-hermes-bridge.git');
assert.equal(pkg.dependencies['@opencode/plugin'], '2.0.24');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly']) assert(!pkg.scripts?.[hook], 'No lifecycle hooks are allowed');
run('bun', ['build', 'src/index.ts', 'src/core.ts', '--target=node', `--outdir=${join(stage, 'dist')}`, '--external', '@opencode/plugin'], source, 'build.log');
assert.match(readFileSync(join(stage, 'dist/index.js'), 'utf8'), /from\s*["']@opencode\/plugin["']/);
const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], stage, 'pack.json'));
assert.equal(packed.length, 1);
const pack = packed[0], tarball = join(root, pack.filename);
assert.equal(pack.filename, `${pkg.name}-${pkg.version}.tgz`);
chmodSync(tarball, 0o600);
const bytes = readFileSync(tarball), sha256 = createHash('sha256').update(bytes).digest('hex');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
assert.equal(pack.integrity, integrity);
const paths = pack.files.map(file => file.path).sort();
const allowed = path => ['package.json', 'README.md', 'LICENSE'].includes(path)
  || /^dist\/(index|core)\.js$/.test(path) || /^src\/[a-zA-Z0-9_-]+\.ts$/.test(path) || /^docs\/[a-zA-Z0-9_-]+\.md$/.test(path);
assert(paths.every(allowed), 'Unexpected archive file: only native code, public docs and license are allowed');
for (const path of ['README.md', 'LICENSE', 'package.json', ...Object.values(pkg.exports).map(value => value.replace(/^\.\//, ''))]) assert(paths.includes(path), `Missing package file: ${path}`);
const tarPaths = run('tar', ['-tzf', tarball], root, 'tar-files.log').trim().split('\n').map(path => path.replace(/^package\//, '')).sort();
assert.deepEqual(tarPaths, paths);
assert(run('tar', ['-tvzf', tarball], root, 'tar-types.log').trim().split('\n').every(line => line.startsWith('-')), 'Only regular archive entries are allowed');
run('tar', ['-xzf', tarball, '-C', unpack], root, 'unpack.log');
const extracted = join(unpack, 'package');
assert.deepEqual(JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8')), pkg);
const secrets = [/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,})\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/];
for (const path of paths) {
  const file = join(extracted, path); assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
  const content = readFileSync(file, 'utf8');
  assert(!content.includes('\0') && secrets.every(pattern => !pattern.test(content)), `Unsafe package content in ${path}`);
}
const docLinks = [...readFileSync(join(extracted, 'README.md'), 'utf8').matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1]);
for (const link of docLinks) assert(paths.includes(link), `Missing README-linked documentation: ${link}`);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }), { mode: 0o600 });
run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer, 'install.log');
assert(!lstatSync(join(consumer, 'node_modules', pkg.name)).isSymbolicLink(), 'Consumer must install the tarball, not a workspace link');
const smoke = run('node', ['--input-type=module', '-e', `import assert from 'node:assert/strict';
import plugin from 'opencode-hermes-bridge';
import { Bridge } from 'opencode-hermes-bridge/core';
assert.equal(plugin.id, 'hermes-bridge'); assert.equal(typeof plugin.setup, 'function'); assert.equal(typeof Bridge.create, 'function');
console.log(JSON.stringify({id:plugin.id,setup:typeof plugin.setup,core:typeof Bridge.create}));`], consumer, 'consumer.log');
assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), sha256);
const report = { name: pkg.name, version: pkg.version, tarball, sha256, integrity, files: paths, readmeDocLinks: docLinks,
  consumer: JSON.parse(smoke), sdkExternal: true, registry: env.NPM_CONFIG_REGISTRY, published: false };
writeFileSync(join(root, 'package-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
