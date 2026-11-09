#!/usr/bin/env node
// Test double for "dolphin-tool convert -i <in> -o <out> -f iso". It validates the command line and
// writes the ISO named by FAKE_DOLPHIN_ISO to the output path. It performs NO real conversion.
import fs from 'node:fs';

const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
const fail = (message, code = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

if (args[0] !== 'convert') fail('expected the "convert" subcommand');
if (after('-f') !== 'iso') fail('expected -f iso');
const input = after('-i');
const output = after('-o');
if (!input || !fs.existsSync(input)) fail('-i file missing');
if (!output) fail('-o missing');
if (process.env.FAKE_DOLPHIN_MODE === 'fail') fail('Error: simulated conversion failure', 1);
if (process.env.FAKE_DOLPHIN_MODE === 'noop') process.exit(0);
fs.copyFileSync(process.env.FAKE_DOLPHIN_ISO, output);
