#!/usr/bin/env node
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ReadStream, WriteStream } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { AppError, DEFAULTS, PI_VERSION, VERSION, cleanEnvironment, fail, installation, installedPi, keyInfo, launchArguments, noAliases, privateDirectory, projectDirectory, readConnection, readKey, saveConfiguration, validateConnection } from './lib.mjs';
import { createProjectPolicy } from './guard-policy.mjs';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const HELP = `Termux Pi ${VERSION}（Pi 固定 ${PI_VERSION}）

用法：
  pi-termux configure              交互输入连接资料，API Key 隐藏输入
  pi-termux configure --defaults   使用默认连接；从环境变量读取新 Key 或保留旧 Key
  pi-termux doctor                 离线检查版本、配置与密钥文件状态
  pi-termux demo                   创建独立示例副本，显示项目路径；不请求模型
  pi-termux guard-check [项目目录]  离线预检项目工具策略；不请求模型
  pi-termux start [项目目录]        开始真实编程会话；可能调用远端模型
  pi-termux start 项目目录 --prompt-file 项目内相对路径
                                  非交互执行文件中的任务；可能产生 API 费用
  pi-termux version

默认项目：$TERMUX_PI_HOME/workspace，默认安装根：$HOME/.termux-pi。
项目必须是 HOME 内的实际目录；不要选择 HOME、共享存储或安装配置目录。
默认关闭 MCP、自动扩展、skills、context files、模板和会话落盘。
start 使用 regular 界面预设，初步规避手机 mouse tracking 影响软键盘的问题。
文件工具限制在选定项目；shell 保留 Android UID 权限，不是操作系统沙箱。
`;

function terminal() {
  if (process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function') return { input: process.stdin, output: process.stdout, close() {} };
  let inputFd, outputFd;
  try {
    inputFd = openSync('/dev/tty', 'r');
    outputFd = openSync('/dev/tty', 'w');
    const input = new ReadStream(inputFd);
    const output = new WriteStream(outputFd);
    if (!input.isTTY || typeof input.setRawMode !== 'function') fail('INTERACTIVE_TTY_REQUIRED');
    return { input, output, close() { input.pause(); input.destroy(); output.destroy(); } };
  } catch {
    if (inputFd !== undefined) try { closeSync(inputFd); } catch {}
    if (outputFd !== undefined) try { closeSync(outputFd); } catch {}
    fail('INTERACTIVE_TTY_REQUIRED');
  }
}

// Raw TTY input is never sent to readline, shell history or argv. Secret input
// has no character echo. Ctrl+C/Ctrl+D restore terminal state before aborting.
async function ask(tty, label, { secret = false } = {}) {
  tty.output.write(label);
  const wasRaw = tty.input.isRaw;
  tty.input.setRawMode(true);
  tty.input.setEncoding('utf8');
  tty.input.resume();
  return new Promise((resolveAnswer, reject) => {
    let value = '', escape = false;
    function finish(error) {
      tty.input.off('data', data);
      tty.input.off('error', ioError);
      tty.input.setRawMode(Boolean(wasRaw));
      tty.input.pause();
      tty.output.write('\n');
      if (error) reject(error); else resolveAnswer(value.trim());
    }
    function ioError() { finish(new AppError('TERMINAL_READ_FAILED')); }
    function data(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new AppError('CONFIGURE_CANCELLED')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (escape) { if (/[A-Za-z~]/.test(char)) escape = false; continue; }
        if (char === '\u001b') { escape = true; continue; }
        if (char === '\u007f' || char === '\b') { if (value) { value = [...value].slice(0, -1).join(''); if (!secret) tty.output.write('\b \b'); } continue; }
        if (char < ' ' || value.length > 16384) continue;
        value += char;
        if (!secret) tty.output.write(char);
      }
    }
    tty.input.on('data', data);
    tty.input.once('error', ioError);
  });
}

async function configure(root, useDefaults) {
  if (useDefaults) {
    saveConfiguration(root, DEFAULTS, process.env.TERMUX_PI_API_KEY || '');
    process.stdout.write('已保存默认 DeepSeek Anthropic 连接。密钥只写入 private/api-key；本命令没有请求模型。\n');
    return;
  }
  const previous = readConnection(root, true) || DEFAULTS;
  const tty = terminal();
  try {
    tty.output.write('配置只保存在本安装目录。以下元数据不代表已验证远端模型全部能力。\n');
    const baseUrl = await ask(tty, `HTTPS API 基地址 [${previous.baseUrl}]: `) || previous.baseUrl;
    const api = await ask(tty, `协议 anthropic-messages / openai-completions [${previous.api}]: `) || previous.api;
    const model = await ask(tty, `模型 ID [${previous.model}]: `) || previous.model;
    const contextWindow = Number(await ask(tty, `上下文窗口元数据 [${previous.contextWindow}]: `) || previous.contextWindow);
    const maxTokens = Number(await ask(tty, `单次输出 token 配置 [${previous.maxTokens}]: `) || previous.maxTokens);
    const reasoningValue = await ask(tty, `声明 reasoning 支持 yes / no [${previous.reasoning ? 'yes' : 'no'}]: `);
    if (reasoningValue && !['yes', 'no'].includes(reasoningValue)) fail('INVALID_REASONING_METADATA');
    const reasoning = reasoningValue ? reasoningValue === 'yes' : previous.reasoning;
    const connection = validateConnection({ baseUrl, api, model, contextWindow, maxTokens, reasoning });
    tty.output.write('API Key 不回显；已有密钥时留空保留。请不要在录屏或共享终端录入真实凭据。\n');
    const key = await ask(tty, 'API Key（隐藏输入）: ', { secret: true });
    saveConfiguration(root, connection, key);
    tty.output.write('已保存连接与私有密钥。本命令没有请求模型。\n');
  } finally { tty.close(); }
}

function doctor(root) {
  const report = { appVersion: VERSION, platform: process.platform, arch: process.arch, node: process.version, expectedPiVersion: PI_VERSION, installedPiVersion: null, requiredEntryFiles: { cli: false, sdk: false }, configuration: { configured: false }, credential: { present: false, mode: null, permissionOk: null }, networkUsed: false, modelCalled: false, checks: [] };
  const runtimeBase = join(root, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  for (const [name, filename] of [['cli', join(runtimeBase, 'dist', 'bundle', 'cli.js')], ['sdk', join(runtimeBase, 'dist', 'index.js')]]) {
    try { noAliases(root, filename, { file: true }); report.requiredEntryFiles[name] = true; } catch {}
    report.checks.push({ name: `runtime-${name}-entry`, ok: report.requiredEntryFiles[name] });
  }
  try { report.installedPiVersion = installedPi(root).version; report.checks.push({ name: 'pinned-runtime', ok: report.installedPiVersion === PI_VERSION }); }
  catch { report.checks.push({ name: 'runtime-readable', ok: false }); }
  try {
    const connection = readConnection(root);
    report.configuration = { configured: true, protocol: connection.api, model: connection.model, contextWindow: connection.contextWindow, maxTokens: connection.maxTokens, reasoning: connection.reasoning };
    report.checks.push({ name: 'connection-valid', ok: true });
    noAliases(root, join(root, 'config', 'pi', 'models.json'), { file: true });
    const models = JSON.parse(readFileSync(join(root, 'config', 'pi', 'models.json'), 'utf8'));
    report.checks.push({ name: 'api-key-env-reference', ok: models?.providers?.['termux-custom']?.apiKey === '$TERMUX_PI_API_KEY' });
  } catch { report.checks.push({ name: 'configuration-valid', ok: false }); }
  try { report.credential = keyInfo(root); report.checks.push({ name: 'private-key-present', ok: report.credential.present && report.credential.permissionOk !== false }); }
  catch { report.checks.push({ name: 'private-key-valid', ok: false }); }
  report.ok = report.checks.every(check => check.ok);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function makeDemo(root) {
  const examples = resolve(appDirectory, '..', 'example');
  noAliases(dirname(appDirectory), examples);
  privateDirectory(root, join(root, 'workspaces'));
  const project = mkdtempSync(join(root, 'workspaces', 'demo-'));
  // Packaged example is immutable input. Never reuse or overwrite an older run.
  cpSync(examples, project, { recursive: true, errorOnExist: true, force: false, dereference: false });
  process.stdout.write(`已创建独立示例：${project}\n下一步：pi-termux start '${project}'\n非交互：pi-termux start '${project}' --prompt-file task-prompt.md\n本命令没有请求模型；示例包含预期失败的新增需求测试。\n`);
}

function guardCheck(project) {
  const policy = createProjectPolicy(project);
  const checks = [];
  const check = (name, value) => checks.push({ name, ok: Boolean(value) });
  const input = { command: 'node --version', timeout: 999 };
  check('shell-command-accepted', !policy.hook({ toolName: 'bash', input }, { cwd: project })?.block);
  check('timeout-bounded', input.timeout === 120);
  check('parent-read-blocked', policy.hook({ toolName: 'read', input: { path: '../private/api-key' } }, { cwd: project })?.block);
  check('unknown-tool-blocked', policy.hook({ toolName: 'unregistered', input: {} }, { cwd: project })?.block);
  const env = policy.childEnvironment({ PATH: 'path-sentinel', TERMUX_PI_API_KEY: 'non-secret-sentinel', BASH_ENV: 'hook-sentinel', NODE_OPTIONS: 'hook-sentinel' });
  check('shell-credential-environment-scrubbed', !Object.hasOwn(env, 'TERMUX_PI_API_KEY') && !Object.hasOwn(env, 'BASH_ENV') && !Object.hasOwn(env, 'NODE_OPTIONS') && env.PATH === 'path-sentinel');
  const ok = checks.every(check => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, checks, boundary: 'application-tool-policy', shellOsSandbox: false, networkUsed: false, modelCalled: false, keyRead: false }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function start(home, root, args) {
  let requested, promptFile;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--prompt-file' && args[index + 1]) { if (promptFile) fail('USAGE'); promptFile = args[++index]; }
    else if (!args[index].startsWith('-') && !requested) requested = args[index];
    else fail('USAGE');
  }
  const project = projectDirectory(home, root, requested);
  const connection = readConnection(root);
  const runtime = installedPi(root);
  if (runtime.version !== PI_VERSION) fail('RUNTIME_VERSION_MISMATCH');
  noAliases(root, runtime.cli, { file: true });
  const guard = join(appDirectory, 'project-guard.mjs');
  let prompt;
  if (promptFile) {
    if (isAbsolute(promptFile)) fail('PROMPT_MUST_BE_PROJECT_RELATIVE');
    const path = createProjectPolicy(project).path(promptFile);
    if (lstatSync(path).size > 1024 * 1024) fail('PROMPT_TOO_LARGE');
    prompt = readFileSync(path, 'utf8');
    if (!prompt.trim()) fail('PROMPT_EMPTY');
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) fail('INTERACTIVE_TTY_REQUIRED');
  // Import and construct the actual SDK override before obtaining a key. Pi's
  // loader can report extension failures and continue; fail closed here first.
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    const { default: register } = await import('./project-guard.mjs');
    const tools = [], handlers = new Map();
    await register({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.push(tool); } }, { root, project });
    if (tools.length !== 1 || tools[0].name !== 'bash' || !handlers.has('tool_call')) fail('GUARD_LOAD_FAILED');
  } finally { process.chdir(previousCwd); }
  const key = readKey(root);
  const env = { ...cleanEnvironment(process.env), TERMUX_PI_HOME: root, PI_TERMUX_PROJECT_REAL: project, PI_CODING_AGENT_DIR: join(root, 'config', 'pi'), PI_SKIP_VERSION_CHECK: '1', TERMUX_PI_API_KEY: key };
  process.stdout.write(`项目：${project}\n连接：${connection.model}（${connection.api}）\n文件工具限制在项目内；shell 不是 OS 沙箱。远端请求可能产生 API 费用。\n`);
  const child = spawn(process.execPath, launchArguments(runtime.cli, guard, connection, Boolean(promptFile)), { cwd: project, env, stdio: promptFile ? ['pipe', 'inherit', 'inherit'] : 'inherit', windowsHide: true });
  if (promptFile) { child.stdin.on('error', () => {}); child.stdin.end(prompt); }
  const result = await new Promise((resolveExit, reject) => { child.once('error', () => reject(new AppError('PI_START_FAILED'))); child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1))); });
  process.exitCode = result;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'help';
  const rest = argv.slice(1);
  if (['help', '--help', '-h'].includes(command)) { if (rest.length) fail('USAGE'); process.stdout.write(HELP); return; }
  if (['version', '--version', '-v'].includes(command)) { if (rest.length) fail('USAGE'); process.stdout.write(`termux-pi ${VERSION}; pi ${PI_VERSION}\n`); return; }
  if (!['configure', 'doctor', 'demo', 'guard-check', 'start'].includes(command)) fail('USAGE');
  if (command === 'configure' && !(rest.length === 0 || rest.length === 1 && rest[0] === '--defaults')) fail('USAGE');
  if (['doctor', 'demo'].includes(command) && rest.length) fail('USAGE');
  if (command === 'guard-check' && (rest.length > 1 || rest[0]?.startsWith('-'))) fail('USAGE');
  const { home, root } = installation(process.env, command === 'configure');
  if (command === 'configure') await configure(root, rest[0] === '--defaults');
  if (command === 'doctor') doctor(root);
  if (command === 'demo') makeDemo(root);
  if (command === 'guard-check') guardCheck(projectDirectory(home, root, rest[0]));
  if (command === 'start') await start(home, root, rest);
}

const ERRORS = { USAGE: '参数不受支持。请执行 pi-termux help；不要通过命令行参数传入密钥。', INTERACTIVE_TTY_REQUIRED: '需要交互终端。配置请直接在 Termux 执行；自动化可显式使用 configure --defaults。任务自动化可使用 start 项目 --prompt-file 项目内文件。', API_KEY_REQUIRED: '首次配置需要 API Key；留空只会保留已有密钥。', API_KEY_NOT_CONFIGURED: '尚未配置密钥，请执行 pi-termux configure。', INVALID_HTTPS_URL: 'API 地址必须是 HTTPS，且不得包含用户名、密码、查询参数或片段。', CONFIGURE_CANCELLED: '已取消配置。', API_KEY_PERMISSIONS: '密钥文件必须为 0600、private 目录必须为 0700。', ROOT_MUST_BE_INSIDE_HOME: '安装目录必须在 Termux HOME 私有目录内。', PROJECT_MUST_BE_INSIDE_HOME: '项目必须是 HOME 内的实际子目录。', PROJECT_IS_INSTALLATION_DATA: '不能把安装配置、私有凭据或运行时目录作为项目。' };
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof AppError && /^[A-Z_]+$/.test(error.code) ? error.code : 'OPERATION_FAILED';
    process.stderr.write(`termux-pi: ${code}。${ERRORS[code] || '操作未完成；未显示原始异常，以免泄露连接资料。'}\n`);
    process.exitCode = 1;
  });
}
