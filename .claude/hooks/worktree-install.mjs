#!/usr/bin/env node
// PostToolUse hook (Bash, if: Bash(git worktree add *)).
// Runs `pnpm install` in a freshly created git worktree so CLI tools
// (drizzle-kit, tsc, vitest, ...) aren't "not recognized" on first use there.
// Best-effort only: PostToolUse can't block, so any failure here is just
// logged, never surfaced as an error to the agent or the user.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function parseWorktreePath(command, cwd) {
  const match = command.match(/git\s+worktree\s+add\b(.*)/s);
  if (!match) return null;

  const tokens = match[1].match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
  const valueFlags = new Set(['-b', '-B', '--reason']);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      i += valueFlags.has(token) ? 2 : 1;
      continue;
    }
    const raw = token.replace(/^["']|["']$/g, '');
    return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  }
  return null;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command ?? '';
const cwd = input?.cwd ?? process.cwd();

const worktreePath = parseWorktreePath(command, cwd);
if (!worktreePath) process.exit(0);

const result = spawnSync('pnpm', ['install'], {
  cwd: worktreePath,
  shell: true,
  encoding: 'utf8',
});

if (result.error || result.status !== 0) {
  console.error(
    `[worktree-install] pnpm install w ${worktreePath} nie powiodło się: ${
      result.error?.message ?? result.stderr ?? `exit ${result.status}`
    }`,
  );
} else {
  console.log(`[worktree-install] pnpm install zakończone w ${worktreePath}`);
}
process.exit(0);
