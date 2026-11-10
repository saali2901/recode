#!/usr/bin/env node
// Runs the orchestration benchmark for a fixed matrix of shapes/sizes/latencies/modes and prints one JSON line each.
// Usage: node scripts/bench-matrix.mjs <dist-dir> [--modes adaptive,complete,signatures,legacy]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2] ?? 'dist';
const modesArg = process.argv.indexOf('--modes');
const modes = (
  modesArg >= 0 ? process.argv[modesArg + 1] : 'adaptive,complete,signatures,legacy'
).split(',');
const bench = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench.mjs');

const matrix = [
  { shape: 'layered', functions: 200, latency: 0, modes: ['adaptive'] },
  { shape: 'layered', functions: 1000, latency: 0, modes: ['adaptive'] },
  { shape: 'layered', functions: 3000, latency: 0, modes },
  { shape: 'layered', functions: 1000, latency: 300, modes },
  { shape: 'chain', functions: 1000, latency: 0, modes: ['adaptive'] },
  { shape: 'chain', functions: 300, latency: 300, modes },
  { shape: 'wide', functions: 1000, latency: 0, modes: ['adaptive'] },
  { shape: 'cycles', functions: 1000, latency: 0, modes: ['adaptive'] },
];
for (const row of matrix) {
  for (const mode of row.modes) {
    const run = spawnSync(
      process.execPath,
      [
        bench,
        dist,
        '--functions',
        String(row.functions),
        '--latency-ms',
        String(row.latency),
        '--shape',
        row.shape,
        '--mode',
        mode,
        '--json',
      ],
      { encoding: 'utf8' },
    );
    process.stdout.write(
      run.status === 0
        ? run.stdout
        : `${JSON.stringify({ error: run.stderr.slice(-300), ...row, mode })}\n`,
    );
  }
}
