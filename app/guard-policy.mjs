import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cleanEnvironment, fail, inside } from './lib.mjs';

// Application checks only. A shell or project program still has its Android
// UID's permissions. These checks are not race-free OS filesystem isolation.
export function createProjectPolicy(project) {
  if (realpathSync(project) !== project || !lstatSync(project).isDirectory()) fail('GUARD_PROJECT_INVALID');
  function cwd(value) {
    if (realpathSync(value) !== project) fail('GUARD_CWD_CHANGED');
  }
  function path(value, write = false) {
    if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) fail('GUARD_PATH_FORMAT');
    const candidate = resolve(project, value.startsWith('@') ? value.slice(1) : value);
    if (!inside(project, candidate)) fail('GUARD_PATH_OUTSIDE_PROJECT');
    const parts = relative(project, candidate).split(sep);
    let cursor = project;
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index]);
      let info;
      try { info = lstatSync(cursor); }
      catch (error) { if (write && error.code === 'ENOENT') return candidate; fail('GUARD_PATH_UNAVAILABLE'); }
      if (info.isSymbolicLink()) fail('GUARD_SYMLINK_NOT_ALLOWED');
      if (index < parts.length - 1 && !info.isDirectory()) fail('GUARD_PARENT_NOT_DIRECTORY');
      if (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1)) fail('GUARD_TARGET_NOT_FILE');
    }
    if (realpathSync(candidate) !== candidate) fail('GUARD_PATH_ALIAS');
    return candidate;
  }
  function command(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('GUARD_COMMAND_FORMAT');
    return value;
  }
  function hook(event, ctx) {
    try {
      cwd(ctx.cwd);
      switch (event.toolName) {
        case 'read': event.input.path = path(event.input.path); break;
        case 'write': case 'edit': event.input.path = path(event.input.path, true); break;
        case 'bash':
          event.input.command = command(event.input.command);
          event.input.timeout = Math.min(Math.max(Number(event.input.timeout) || 60, 1), 120);
          break;
        default: fail('GUARD_TOOL_NOT_ALLOWED');
      }
    } catch (error) {
      return { block: true, reason: /^GUARD_[A-Z_]+$/.test(error?.code) ? error.code : 'GUARD_CHECK_FAILED' };
    }
  }
  return { cwd, path, command, hook, childEnvironment: cleanEnvironment };
}
