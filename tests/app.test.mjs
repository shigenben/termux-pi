import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AppError, DEFAULTS, cleanEnvironment, installation, keyInfo, launchArguments, modelConfig, projectDirectory, readConnection, readKey, saveConfiguration, validateConnection } from '../app/lib.mjs';
import { createProjectPolicy } from '../app/guard-policy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const sandboxBase = join(directory, '.app-test-tmp');
mkdirSync(sandboxBase, { recursive: true });
function fixture(t) {
  const home = mkdtempSync(join(sandboxBase, 'home-'));
  const env = { ...process.env, HOME: home, TERMUX_PI_HOME: join(home, '.termux-pi') };
  delete env.TERMUX_PI_API_KEY;
  const { root } = installation(env, true);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, root, env };
}
function code(expected) { return error => error instanceof AppError && error.code === expected; }
function cli(env, args) { return spawnSync(process.execPath, [join(directory, '..', 'app', 'cli.mjs'), ...args], { env, encoding: 'utf8' }); }
const TOKEN = 'non-secret-test-sentinel-123456';

test('custom model metadata and the env reference never contain credential values', () => {
  const connection = validateConnection({ ...DEFAULTS, baseUrl: 'https://example.invalid/v1', api: 'openai-completions', model: 'custom/model', reasoning: false, contextWindow: 64000, maxTokens: 4000 });
  const model = modelConfig(connection).providers['termux-custom'];
  assert.equal(model.apiKey, '$TERMUX_PI_API_KEY');
  assert.equal(model.models[0].reasoning, false);
  assert.equal(model.api, 'openai-completions');
  for (const baseUrl of ['http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid?api_key=secret', 'https://example.invalid?x=1', 'https://example.invalid/#secret']) assert.throws(() => validateConnection({ ...DEFAULTS, baseUrl }), code('INVALID_HTTPS_URL'));
  assert.throws(() => validateConnection({ ...DEFAULTS, model: 'bad\nmodel' }), code('INVALID_MODEL_ID'));
  assert.throws(() => validateConnection({ ...DEFAULTS, contextWindow: 1 }), code('INVALID_TOKEN_METADATA'));
});

test('configure atomically replaces files, preserves a blank key and leaves no temporary file', t => {
  const { root } = fixture(t);
  saveConfiguration(root, DEFAULTS, TOKEN);
  assert.equal(readKey(root), TOKEN);
  const original = readFileSync(join(root, 'private', 'api-key'), 'utf8');
  saveConfiguration(root, { ...DEFAULTS, model: 'next-model' });
  assert.equal(readFileSync(join(root, 'private', 'api-key'), 'utf8'), original);
  assert.equal(readConnection(root).model, 'next-model');
  const publicText = readFileSync(join(root, 'config', 'connection.json'), 'utf8') + readFileSync(join(root, 'config', 'pi', 'models.json'), 'utf8');
  assert.equal(publicText.includes(TOKEN), false);
  assert.equal(publicText.includes('$TERMUX_PI_API_KEY'), true);
  for (const folder of ['private', 'config', join('config', 'pi')]) assert.equal(readdirSync(join(root, folder)).some(name => name.startsWith('.write-')), false);
  if (process.platform !== 'win32') assert.deepEqual(keyInfo(root), { present: true, mode: '600', permissionOk: true });
  const before = readFileSync(join(root, 'config', 'connection.json'), 'utf8');
  assert.throws(() => saveConfiguration(root, { ...DEFAULTS, baseUrl: 'http://invalid.example' }, 'different-sentinel'), code('INVALID_HTTPS_URL'));
  assert.equal(readKey(root), TOKEN);
  assert.equal(readFileSync(join(root, 'config', 'connection.json'), 'utf8'), before);
});

test('missing credentials fail without fabricating a value; defaults CLI reads env only when requested', t => {
  const { root, env } = fixture(t);
  assert.throws(() => saveConfiguration(root, DEFAULTS), code('API_KEY_REQUIRED'));
  assert.equal(existsSync(join(root, 'private', 'api-key')), false);
  const configured = cli({ ...env, TERMUX_PI_API_KEY: TOKEN }, ['configure', '--defaults']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal((configured.stdout + configured.stderr).includes(TOKEN), false);
  assert.equal(readKey(root), TOKEN);
  const preserved = cli(env, ['configure', '--defaults']);
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(readKey(root), TOKEN);
});

test('doctor is offline, reports presence only, and rejects permissive key mode on POSIX', t => {
  const { root, env } = fixture(t);
  saveConfiguration(root, DEFAULTS, TOKEN);
  const runtime = join(root, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(runtime, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ version: '1.5.0' }));
  const cliEntry = join(runtime, 'dist', 'bundle', 'cli.js');
  const sdkEntry = join(runtime, 'dist', 'index.js');
  writeFileSync(cliEntry, '// non-executed test entry\n');
  writeFileSync(sdkEntry, '// non-executed test SDK\n');
  const result = cli(env, ['doctor']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.networkUsed, false);
  assert.equal(report.modelCalled, false);
  assert.equal(report.credential.present, true);
  assert.deepEqual(report.requiredEntryFiles, { cli: true, sdk: true });
  assert.equal(result.stdout.includes(TOKEN), false);
  for (const [name, filename] of [['cli', cliEntry], ['sdk', sdkEntry]]) {
    rmSync(filename);
    const broken = cli(env, ['doctor']);
    assert.equal(broken.status, 1);
    assert.equal(JSON.parse(broken.stdout).requiredEntryFiles[name], false);
    assert.equal(JSON.parse(broken.stdout).ok, false);
    writeFileSync(filename, '// restored test entry\n');
  }
  if (process.platform !== 'win32') {
    chmodSync(join(root, 'private', 'api-key'), 0o644);
    assert.throws(() => readKey(root), code('API_KEY_PERMISSIONS'));
    assert.equal(cli(env, ['doctor']).status, 1);
  }
});

test('project scope rejects HOME, installation data, traversal and file aliases', async t => {
  const { home, root } = fixture(t);
  const project = projectDirectory(home, root);
  assert.equal(project, join(root, 'workspace'));
  assert.throws(() => projectDirectory(home, root, home), code('PROJECT_MUST_BE_INSIDE_HOME'));
  assert.throws(() => projectDirectory(home, root, root), code('PROJECT_IS_INSTALLATION_DATA'));
  assert.throws(() => projectDirectory(home, root, join(root, 'private')), code('PROJECT_IS_INSTALLATION_DATA'));
  writeFileSync(join(project, 'source.js'), 'export const value = 1;\n');
  const policy = createProjectPolicy(project);
  assert.equal(policy.path('source.js'), join(project, 'source.js'));
  assert.equal(policy.path('nested/new.js', true), join(project, 'nested', 'new.js'));
  assert.throws(() => policy.path('../private/api-key'), code('GUARD_PATH_OUTSIDE_PROJECT'));
  assert.throws(() => policy.path(home), code('GUARD_PATH_OUTSIDE_PROJECT'));
  await t.test('hardlinked file is rejected when this filesystem permits creating the probe', { skip: process.platform === 'win32' ? 'Windows host does not provide this POSIX hardlink probe coverage' : false }, probe => {
    try { linkSync(join(project, 'source.js'), join(project, 'hardlink.js')); }
    catch (error) {
      if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
      probe.diagnostic(`Hardlink probe creation unavailable (${error.code}); runtime hardlink rejection remains unverified on this filesystem.`);
      probe.skip(`Filesystem or Android policy rejected hardlink probe creation: ${error.code}`);
      return;
    }
    assert.throws(() => policy.path('hardlink.js', true), code('GUARD_TARGET_NOT_FILE'));
  });
  if (process.platform !== 'win32') {
    symlinkSync(join(root, 'private'), join(project, 'alias'));
    assert.throws(() => policy.path('alias/api-key', true), code('GUARD_SYMLINK_NOT_ALLOWED'));
    symlinkSync(project, join(home, 'alias-project'));
    assert.throws(() => projectDirectory(home, root, join(home, 'alias-project')), code('SYMLINK_NOT_ALLOWED'));
  }
});

test('shell environment scrubs credentials and hooks but retains Termux linkage', () => {
  const env = cleanEnvironment({ PATH: '/termux/bin', HOME: '/termux/home', TERMUX_PI_API_KEY: TOKEN, OTHER_TOKEN: TOKEN, Authorization: TOKEN, BASH_ENV: '/hook', ENV: '/hook', NODE_OPTIONS: '--require /hook', NODE_PATH: '/hook', LD_PRELOAD: 'libtermux-exec.so', LD_LIBRARY_PATH: '/termux/lib' });
  assert.equal(JSON.stringify(env).includes(TOKEN), false);
  for (const key of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH']) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.LD_PRELOAD, 'libtermux-exec.so');
  assert.equal(env.LD_LIBRARY_PATH, '/termux/lib');
});

test('launch flags isolate model resources, disable session persistence and select regular TUI', () => {
  const args = launchArguments('/runtime/pi.js', '/app/guard.mjs', DEFAULTS, true);
  for (const flag of ['--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--print']) assert.equal(args.includes(flag), true);
  assert.equal(args[args.indexOf('--tui-mode') + 1], 'regular');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,write,edit,bash');
  assert.equal(args.includes('--api-key'), false);
  assert.equal(args.includes(TOKEN), false);
});

test('demo creates separate copies and guard-check requests no model or private key', t => {
  const { root, env } = fixture(t);
  const first = cli(env, ['demo']);
  assert.equal(first.status, 0, first.stderr);
  const second = cli(env, ['demo']);
  assert.equal(second.status, 0, second.stderr);
  const copies = readdirSync(join(root, 'workspaces'));
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0], copies[1]);
  const project = join(root, 'workspaces', copies[0]);
  const testEnvironment = { ...env };
  delete testEnvironment.NODE_TEST_CONTEXT;
  const baseline = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/baseline.test.js'], { cwd: project, env: testEnvironment, encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout, /^# pass 8$/m);
  const full = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: project, env: testEnvironment, encoding: 'utf8' });
  assert.equal(full.status, 1);
  assert.match(full.stdout, /^# pass 10$/m);
  assert.match(full.stdout, /^# fail 5$/m);
  const check = cli(env, ['guard-check', project]);
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.keyRead, false);
  assert.equal(report.modelCalled, false);
  assert.equal(report.shellOsSandbox, false);
});

test('unexpected or key-bearing CLI arguments are rejected without echoing them', t => {
  const { env } = fixture(t);
  const result = cli(env, ['configure', '--api-key', TOKEN]);
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
  assert.match(result.stderr, /USAGE/);
});
