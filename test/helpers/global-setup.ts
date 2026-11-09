import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Compiles the C test fixture once (if missing) so parser and pipeline tests use real gcc output. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '../fixtures');
  const out = path.join(root, 'build');
  const source = path.join(root, 'src', 'sample.c');
  const executable = path.join(out, 'sample-x86_64');
  const object = path.join(out, 'sample.o');
  if (existsSync(executable) && existsSync(object)) return;
  mkdirSync(out, { recursive: true });
  const cc = process.env['CC'] ?? 'gcc';
  execFileSync(cc, ['-O0', '-g0', '-fno-pie', '-no-pie', '-o', executable, source], {
    stdio: 'inherit',
  });
  execFileSync(cc, ['-O0', '-g0', '-c', '-o', object, source], { stdio: 'inherit' });
}
