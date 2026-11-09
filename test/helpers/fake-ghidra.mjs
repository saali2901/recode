#!/usr/bin/env node
// Test double for Ghidra's analyzeHeadless. It validates the command line the adapter builds and
// emits the same JSON files ExportAnalysis.java would, from a function table prepared by the test
// (taken from the real fixture's symbol table). It performs NO real decompilation.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_GHIDRA_MODE ?? 'ok';
if (process.env.FAKE_GHIDRA_LOG)
  fs.appendFileSync(process.env.FAKE_GHIDRA_LOG, `${JSON.stringify(args)}\n`);

const after = (flag, count = 1) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args.slice(i + 1, i + 1 + count);
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

if (mode === 'fail') fail('ERROR: simulated Ghidra failure');
if (mode === 'hang') setInterval(() => {}, 1000);
else main();

function main() {
  // Real Ghidra: "Path element starting with '.' is not permitted" for the project directory.
  if (args[0] && args[0].split(/[\\/]/).some((s) => s.startsWith('.') && s !== '.' && s !== '..')) {
    fail(
      "ERROR Abort due to Headless analyzer error: Path element starting with '.' is not permitted",
    );
  }
  const [imported] = after('-import') ?? [];
  const [scriptPath] = after('-scriptPath') ?? [];
  const post = after('-postScript', 4);
  if (!imported || !fs.existsSync(imported)) fail('-import file missing');
  if (!scriptPath || !fs.existsSync(path.join(scriptPath, 'ExportAnalysis.java')))
    fail('ExportAnalysis.java not found in -scriptPath');
  const preIndex = args.indexOf('-preScript');
  if (preIndex >= 0) {
    // Real Ghidra resolves the script by name in -scriptPath and passes the rest up to the next option.
    if (args[preIndex + 1] !== 'ImportDol.java') fail('unknown -preScript');
    if (!fs.existsSync(path.join(scriptPath, 'ImportDol.java'))) fail('ImportDol.java not found');
    const scriptArgs = args.slice(preIndex + 2, args.indexOf('-postScript'));
    if (!/^0x[0-9a-f]+$/.test(scriptArgs[0] ?? '')) fail('ImportDol.java: entry address missing');
    // Real Ghidra splits script arguments at commas (seen with 12.2), so no argument may contain one.
    if (scriptArgs.some((a) => a.includes(',')))
      fail('ImportDol.java: script argument contains a comma');
    for (const layout of scriptArgs.slice(1)) {
      if (/^reg:r\d+:0x[0-9a-f]+$/.test(layout)) continue;
      if (!/^[.\w]+:0x[0-9a-f]+:0x[0-9a-f]+:(0x[0-9a-f]+|-):[r-][w-][x-]$/.test(layout))
        fail(`ImportDol.java: invalid section description ${layout}`);
    }
    if (args[args.indexOf('-loader') + 1] !== 'BinaryLoader') fail('DOL needs BinaryLoader');
  }
  if (!post || post[0] !== 'ExportAnalysis.java') fail('-postScript ExportAnalysis.java missing');
  const [, outDir, maxFunctions, entry] = post;
  if (!outDir || !maxFunctions || !entry) fail('script arguments missing');
  if (mode === 'noexport') process.exit(0);

  const table = JSON.parse(fs.readFileSync(process.env.FAKE_GHIDRA_FUNCTIONS, 'utf8'));
  const hex8 = (a) => a.slice(2).padStart(8, '0');
  fs.mkdirSync(path.join(outDir, 'decompiled'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'asm'), { recursive: true });

  const byName = new Map(table.map((f) => [f.name, f]));
  const functions = table.map((f) => {
    const calls = (f.calls ?? []).map((n) => byName.get(n)?.address).filter(Boolean);
    const calledBy = table.filter((g) => (g.calls ?? []).includes(f.name)).map((g) => g.address);
    const stem = `function_${hex8(f.address)}`;
    fs.writeFileSync(
      path.join(outDir, 'decompiled', `${stem}.c`),
      `/* MOCK decompiler output for ${f.name} */\n`,
    );
    fs.writeFileSync(path.join(outDir, 'asm', `${stem}.asm`), `${f.address}: nop ; mock\n`);
    return {
      address: f.address,
      name: f.name,
      signature: `int ${f.name}(void)`,
      returnType: 'int',
      callingConvention: '__cdecl',
      parameterCount: 0,
      size: f.size,
      isThunk: false,
      isExternal: false,
      hasUserDefinedName: true,
      calls,
      calledBy,
      decompiledFile: `decompiled/${stem}.c`,
      decompileError: null,
      disassemblyFile: `asm/${stem}.asm`,
    };
  });
  const json = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value));
  json('functions.json', { functions });
  json('references.json', {
    references: functions.flatMap((f) =>
      f.calls.map((to) => ({
        from: f.address,
        to,
        type: 'UNCONDITIONAL_CALL',
        fromFunction: f.address,
      })),
    ),
  });
  json('call-graph.json', {
    edges: functions.flatMap((f) => f.calls.map((to) => ({ from: f.address, to }))),
  });
  json('symbols.json', {
    symbols: functions.map((f) => ({
      name: f.name,
      address: f.address,
      type: 'Function',
      source: 'IMPORTED',
    })),
  });
  json('types.json', {
    types: [
      {
        name: 'shape',
        kind: 'struct',
        size: 12,
        fields: [{ name: 'kind', type: 'int', offset: 0, size: 4 }],
      },
    ],
  });
  json('program.json', {
    ghidraVersion: '99.0-MOCK',
    language: 'x86:LE:64:default',
    compiler: 'gcc',
    imageBase: '0x400000',
    executableFormat: 'Executable and Linking Format (ELF)',
    functionCount: functions.length,
    symbolCount: functions.length,
    typeCount: 1,
  });
  process.exit(0);
}
