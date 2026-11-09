#!/usr/bin/env node
// Keeps the project skill and the README in step with the code.
//
//   node scripts/skill-guard.mjs            Claude Code "Stop" hook: blocks the end of a turn while code changes
//                                           lack a matching skill/README update (reads the hook JSON on stdin)
//   node scripts/skill-guard.mjs --staged   git pre-commit check on the staged files
//
// Skip once with SKIP_SKILL_GUARD=1 (e.g. for pure refactorings that change nothing worth documenting).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SKILL = '.claude/skills/recode-maintainer/SKILL.md';
const README = 'README.md';

/** Changes that must be reflected in the skill (map, commands, decisions, change log). */
const SKILL_TRIGGERS = [
  /^src\/.*(?<!\.test)\.tsx?$/,
  /^src\/decompiler\/scripts\//,
  /^web\/src\/.*(?<!\.test)\.tsx?$/,
  /^templates\//,
  /^install\.(sh|ps1)$/,
  /^scripts\/(?!skill-guard)/,
  /^package\.json$/,
];

/** Changes a user of the README would notice: installers, supported formats, user-facing commands. */
const README_TRIGGERS = [
  /^install\.(sh|ps1)$/,
  /^src\/input\/adapters\//,
  /^src\/cli\/commands\/(ui|doctor|setup)\.ts$/,
];

export function evaluate(changedFiles) {
  const files = [...new Set(changedFiles.filter(Boolean))];
  const skillNeeded = files.filter((f) => SKILL_TRIGGERS.some((re) => re.test(f)));
  const readmeNeeded = files.filter((f) => README_TRIGGERS.some((re) => re.test(f)));
  const problems = [];
  if (skillNeeded.length > 0 && !files.includes(SKILL)) {
    problems.push(
      `The skill ${SKILL} was not updated, but these files changed:\n  ${skillNeeded.slice(0, 8).join('\n  ')}` +
        '\nUpdate its project map / commands / decisions / known gaps as needed and add a change-log entry.',
    );
  }
  if (readmeNeeded.length > 0 && !files.includes(README)) {
    problems.push(
      `README.md was not updated, but user-facing files changed:\n  ${readmeNeeded.slice(0, 8).join('\n  ')}` +
        '\nCheck Installation, Start, Commands and Supported files (the README stays short and has no CLI usage).',
    );
  }
  return problems;
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function lines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function changedFiles(staged) {
  if (staged) return lines(git(['diff', '--cached', '--name-only']));
  const files = new Set([
    ...lines(git(['diff', '--name-only', 'HEAD'])),
    ...lines(git(['diff', '--cached', '--name-only'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ]);
  // Commits of this branch that are not on main yet count as well (a turn may end right after a commit).
  for (const base of ['origin/main', 'main']) {
    const mergeBase = lines(git(['merge-base', base, 'HEAD']))[0];
    if (mergeBase) {
      lines(git(['diff', '--name-only', `${mergeBase}..HEAD`])).forEach((f) => files.add(f));
      break;
    }
  }
  return [...files];
}

function main() {
  if (process.env.SKIP_SKILL_GUARD === '1') return 0;
  const staged = process.argv.includes('--staged');

  if (!staged && !process.stdin.isTTY) {
    try {
      const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      if (input.stop_hook_active) return 0; // already asked once in this turn; never loop
    } catch {
      // not hook input
    }
  }

  const problems = evaluate(changedFiles(staged));
  if (problems.length === 0) return 0;
  const message = `Documentation is out of date.\n\n${problems.join('\n\n')}\n\n(Bypass once: SKIP_SKILL_GUARD=1)`;
  if (staged) {
    process.stderr.write(`${message}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: message }));
  return 0;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('skill-guard.mjs')
) {
  process.exit(main());
}
