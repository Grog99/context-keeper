#!/usr/bin/env node
// PreToolUse hook (Grep).
// Blocks Grep patterns that look like a raw Windows filesystem path pasted
// in as the regex — ripgrep rejects most unescaped `\<letter>` sequences,
// so this fails loudly instead of confusing the agent with a cryptic error.

import { readFileSync } from 'node:fs';

function looksLikeWindowsPath(pattern) {
  if (typeof pattern !== 'string') return false;
  if (/^[A-Za-z]:\\{1,2}/.test(pattern)) return true; // C:\... absolute
  if (/^\\{2}[^\\]/.test(pattern)) return true; // \\server\share UNC
  if (/^[\w.-]+(\\[\w.-]+){2,}$/.test(pattern)) return true; // apps\server\src\... relative
  return false;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const pattern = input?.tool_input?.pattern;

if (looksLikeWindowsPath(pattern)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Pattern "${pattern}" wygląda na wklejoną ścieżkę Windows z backslashem — ripgrep ` +
          'odrzuci nieescapowany "\\" jako błędny regex. Użyj "/" zamiast "\\", albo escapuj ' +
          'każdy "\\" jako "\\\\".',
      },
    }),
  );
}
process.exit(0);
