import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const VERSION = '0.1.0';
export const PI_VERSION = '1.5.0';
export const PROVIDER = 'termux-custom';
export const DEFAULTS = Object.freeze({ baseUrl: 'https://api.deepseek.com/anthropic', api: 'anthropic-messages', model: 'deepseek-flash', reasoning: true, contextWindow: 1048576, maxTokens: 8192 });

export class AppError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function fail(code) { throw new AppError(code); }
export function inside(parent, child, allowEqual = false) {
  const rel = relative(parent, child);
  return (allowEqual && rel === '') || (rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export function noAliases(base, candidate, { missing = false, file = false } = {}) {
  if (!inside(base, candidate, true)) fail('PATH_OUTSIDE_ROOT');
  let cursor = base;
  const parts = relative(base, candidate).split(sep).filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cursor = join(cursor, parts[i]);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) {
      if (missing && error.code === 'ENOENT') return;
      fail('PATH_UNAVAILABLE');
    }
    if (info.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED');
    const isLast = i === parts.length - 1;
    if (!isLast && !info.isDirectory()) fail('PARENT_NOT_DIRECTORY');
    if (isLast && file && (!info.isFile() || info.nlink !== 1)) fail('FILE_NOT_PRIVATE');
  }
}
export function installation(env = process.env, create = false) {
  const rawHome = env.HOME || homedir();
  if (!isAbsolute(rawHome)) fail('HOME_MUST_BE_ABSOLUTE');
  const home = realpathSync(rawHome);
  const root = resolve(env.TERMUX_PI_HOME || join(home, '.termux-pi'));
  if (env.TERMUX_PI_HOME && !isAbsolute(env.TERMUX_PI_HOME)) fail('ROOT_MUST_BE_ABSOLUTE');
  if (!inside(home, root)) fail('ROOT_MUST_BE_INSIDE_HOME');
  noAliases(home, root, { missing: create });
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) fail('ROOT_NOT_DIRECTORY');
  return { home, root };
}
export function privateDirectory(root, target) {
  noAliases(root, target, { missing: true });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!lstatSync(target).isDirectory()) fail('DIRECTORY_REQUIRED');
  chmodSync(target, 0o700);
}
export function atomicWrite(root, target, content, mode = 0o600) {
  noAliases(root, target, { missing: true });
  if (existsSync(target)) noAliases(root, target, { file: true });
  const temp = join(dirname(target), `.write-${randomBytes(12).toString('hex')}`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function validateConnection(value) {
  let url;
  try { url = new URL(value.baseUrl); } catch { fail('INVALID_HTTPS_URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) fail('INVALID_HTTPS_URL');
  if (typeof value.baseUrl !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(value.baseUrl)) fail('INVALID_HTTPS_URL');
  if (!['anthropic-messages', 'openai-completions'].includes(value.api)) fail('INVALID_API_PROTOCOL');
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,199}$/.test(value.model)) fail('INVALID_MODEL_ID');
  if (typeof value.reasoning !== 'boolean') fail('INVALID_REASONING_METADATA');
  for (const name of ['contextWindow', 'maxTokens']) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 1 || value[name] > 2147483647) fail('INVALID_TOKEN_METADATA');
  }
  if (value.maxTokens > value.contextWindow) fail('INVALID_TOKEN_METADATA');
  return { schemaVersion: 1, baseUrl: url.href.replace(/\/$/, ''), api: value.api, model: value.model, reasoning: value.reasoning, contextWindow: value.contextWindow, maxTokens: value.maxTokens };
}
export function modelConfig(connection) {
  const c = validateConnection(connection);
  return { providers: { [PROVIDER]: { baseUrl: c.baseUrl, api: c.api, apiKey: '$TERMUX_PI_API_KEY', models: [{ id: c.model, name: c.model, reasoning: c.reasoning, input: ['text'], contextWindow: c.contextWindow, maxTokens: c.maxTokens }] } } };
}
export function readConnection(root, optional = false) {
  const filename = join(root, 'config', 'connection.json');
  try {
    noAliases(root, filename, { file: true });
    return validateConnection(JSON.parse(readFileSync(filename, 'utf8')));
  } catch (error) {
    if (optional && !existsSync(filename)) return null;
    if (error instanceof AppError) throw error;
    fail('CONFIGURATION_INVALID');
  }
}
export function keyInfo(root) {
  const filename = join(root, 'private', 'api-key');
  try {
    noAliases(root, filename, { file: true });
    const info = lstatSync(filename);
    const directory = lstatSync(dirname(filename));
    const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    return { present: info.size > 0, mode, permissionOk: process.platform === 'win32' ? null : mode === '600' && (directory.mode & 0o777) === 0o700 };
  } catch (error) {
    if (!existsSync(filename)) return { present: false, mode: null, permissionOk: null };
    throw error;
  }
}
export function readKey(root) {
  const info = keyInfo(root);
  if (!info.present) fail('API_KEY_NOT_CONFIGURED');
  if (info.permissionOk === false) fail('API_KEY_PERMISSIONS');
  const key = readFileSync(join(root, 'private', 'api-key'), 'utf8').trim();
  if (!key || /[\s\u0000-\u001f\u007f]/u.test(key)) fail('API_KEY_INVALID');
  return key;
}
export function saveConfiguration(root, raw, key = '') {
  const connection = validateConnection(raw);
  if (typeof key !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(key)) fail('API_KEY_INVALID');
  for (const part of ['config', join('config', 'pi'), 'private']) privateDirectory(root, join(root, part));
  if (!key && !keyInfo(root).present) fail('API_KEY_REQUIRED');
  // Validate all destinations before the first replacement. Blank preserves an
  // existing key byte-for-byte; only an explicit configure call writes files.
  for (const name of [join('config', 'connection.json'), join('config', 'pi', 'models.json'), join('private', 'api-key')]) {
    const path = join(root, name);
    noAliases(root, path, { missing: true });
    if (existsSync(path)) noAliases(root, path, { file: true });
  }
  if (key) atomicWrite(root, join(root, 'private', 'api-key'), `${key}\n`);
  else chmodSync(join(root, 'private', 'api-key'), 0o600);
  atomicWrite(root, join(root, 'config', 'connection.json'), `${JSON.stringify(connection, null, 2)}\n`);
  atomicWrite(root, join(root, 'config', 'pi', 'models.json'), `${JSON.stringify(modelConfig(connection), null, 2)}\n`);
  return connection;
}
export function projectDirectory(home, root, requested, createDefault = true) {
  const candidate = requested ? resolve(requested) : join(root, 'workspace');
  if (!inside(home, candidate)) fail('PROJECT_MUST_BE_INSIDE_HOME');
  const appProject = inside(root, candidate);
  if (candidate === root || (appProject && !inside(join(root, 'workspace'), candidate, true) && !inside(join(root, 'workspaces'), candidate))) fail('PROJECT_IS_INSTALLATION_DATA');
  noAliases(home, candidate, { missing: !requested && createDefault });
  if (!requested && createDefault) privateDirectory(root, candidate);
  if (!lstatSync(candidate).isDirectory() || realpathSync(candidate) !== candidate) fail('PROJECT_NOT_DIRECTORY');
  return candidate;
}
export function installedPi(root) {
  const base = join(root, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const manifest = join(base, 'package.json');
  noAliases(root, manifest, { file: true });
  const value = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) fail('RUNTIME_VERSION_INVALID');
  const cli = join(base, 'dist', 'bundle', 'cli.js');
  const sdk = join(base, 'dist', 'index.js');
  noAliases(root, cli, { file: true });
  noAliases(root, sdk, { file: true });
  return { version: value, cli, sdk };
}
export function cleanEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(name)) delete result[name];
  // Preserve Termux's LD_* compatibility setup: termux-exec and runtime linkage
  // may require it. This is credential hygiene, not a hardened process sandbox.
  for (const name of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'PI_CODING_AGENT_DIR', 'PI_SESSION_DIR']) delete result[name];
  return result;
}
export function launchArguments(cli, guard, connection, print = false) {
  const args = [cli, '--no-session', '--tui-mode', 'regular', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--extension', guard, '--tools', 'read,write,edit,bash', '--provider', PROVIDER, '--model', connection.model, '--thinking', 'off'];
  if (print) args.push('--print');
  return args;
}
