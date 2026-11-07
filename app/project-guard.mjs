import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectPolicy } from './guard-policy.mjs';

export default async function projectGuard(pi, options = {}) {
  const project = options.project || process.env.PI_TERMUX_PROJECT_REAL;
  const root = options.root || process.env.TERMUX_PI_HOME;
  const policy = createProjectPolicy(project);
  policy.cwd(process.cwd());
  // A resolved URL works with Node and Pi's jiti loader and uses the pinned
  // runtime belonging to this installation, without a global npm dependency.
  const { createBashTool } = await import(pathToFileURL(join(root, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href);
  pi.on('tool_call', policy.hook);
  const tool = createBashTool(project, {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, cwd, env }) => {
      policy.cwd(cwd);
      return { command: policy.command(command), cwd: project, env: policy.childEnvironment(env) };
    },
  });
  pi.registerTool({
    ...tool,
    description: 'Run a development shell command from the selected project. Shell commands are NOT OS-sandboxed: they retain the Android UID permissions. Do not access other projects, credentials or installation files.',
    async execute(id, params, signal, onUpdate, ctx) {
      policy.cwd(ctx.cwd);
      const timeout = Math.min(Math.max(Number(params.timeout) || 60, 1), 120);
      return tool.execute(id, { ...params, command: policy.command(params.command), timeout }, signal, onUpdate);
    },
  });
  // User-entered ! commands otherwise bypass the model-facing bash override.
  pi.on('user_bash', () => ({ result: { output: '请在另一个 Termux 终端执行手工命令；本入口不运行 ! shell。', exitCode: 1, cancelled: false, truncated: false } }));
}
