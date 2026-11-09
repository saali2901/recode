import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GhidraDecompiler,
  bundledScriptDirectory,
} from '../../src/decompiler/ghidra/ghidra-decompiler.js';
import { ghidraLanguageId } from '../../src/decompiler/ghidra/language.js';
import { findGhidra } from '../../src/decompiler/ghidra/locate.js';
import { Project } from '../../src/core/project/project.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

const HERMETIC = { skipPrerequisites: true } as const;

describe('Ghidra adapter (against a command-line compatible fake)', () => {
  it('finds the installation and its version', async () => {
    const world = await createWorld({ project: false });
    const found = await findGhidra(process.env['GHIDRA_INSTALL_DIR']);
    expect(found).toMatchObject({ version: '99.0' });
    expect(found!.headlessPath.endsWith('analyzeHeadless')).toBe(true);
    expect(await findGhidra('/nonexistent', { PATH: '' })).toBeUndefined();
    void world;
  });

  it('bundles the export script that the headless run references', async () => {
    const dir = bundledScriptDirectory();
    const script = await fs.readFile(path.join(dir, 'ExportAnalysis.java'), 'utf8');
    expect(script).toContain('class ExportAnalysis extends GhidraScript');
    for (const output of [
      'functions.json',
      'references.json',
      'symbols.json',
      'types.json',
      'call-graph.json',
      'program.json',
    ]) {
      expect(script).toContain(output);
    }
  });

  it('builds the headless command line: import, overwrite, script path, post script', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    await world.run(['analyze'], { overrides: HERMETIC });
    const args = JSON.parse(
      (await fs.readFile(world.ghidraLog, 'utf8')).trim().split('\n')[0]!,
    ) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-import',
        '-overwrite',
        '-deleteProject',
        '-scriptPath',
        '-postScript',
        'ExportAnalysis.java',
      ]),
    );
    expect(args).not.toContain('-loader'); // ELF: Ghidra's own loader picks language
    expect(args.slice(-1)).toEqual(['-']); // no entry override for non-raw binaries
  });

  it('passes loader, base address, language and entry for raw binaries', async () => {
    const world = await createWorld();
    const raw = path.join(world.workDir, 'fw.bin');
    await fs.writeFile(raw, Buffer.alloc(64, 0x90));
    await world.run([
      'import',
      raw,
      '--arch',
      'arm',
      '--endian',
      'little',
      '--bits',
      '32',
      '--base',
      '0x8000',
      '--entry',
      '0x8010',
    ]);
    // The fake needs real symbols for ELF only; raw runs still need its function table, which exists.
    await world.run(['analyze'], { overrides: HERMETIC });
    const args = JSON.parse(
      (await fs.readFile(world.ghidraLog, 'utf8')).trim().split('\n')[0]!,
    ) as string[];
    expect(args.slice(args.indexOf('-loader'), args.indexOf('-loader') + 6)).toEqual([
      '-loader',
      'BinaryLoader',
      '-loader-baseAddr',
      '0x8000',
      '-processor',
      'ARM:LE:32:v8',
    ]);
    expect(args.slice(-1)).toEqual(['0x8010']);
  });

  it('maps architectures to Ghidra language ids', () => {
    expect(ghidraLanguageId({ architecture: 'x86_64', bits: 64, endianness: 'little' })).toBe(
      'x86:LE:64:default',
    );
    expect(ghidraLanguageId({ architecture: 'mips', bits: 32, endianness: 'big' })).toBe(
      'MIPS:BE:32:default',
    );
    expect(
      ghidraLanguageId({ architecture: 'unknown', bits: 32, endianness: 'little' }),
    ).toBeUndefined();
  });

  it('reports a failing Ghidra run with its log, leaves no half-written analysis, and recovers', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    world.setEnv('FAKE_GHIDRA_MODE', 'fail');
    const failed = await world.run(['analyze'], { overrides: HERMETIC });
    expect(failed.code).toBe(5);
    expect(failed.stderr).toContain('exited with code 2');
    expect(failed.stderr).toContain('simulated Ghidra failure');
    const project = await Project.open(world.projectDir);
    const id = project.binaries[0]!.id;
    expect((await fs.readdir(project.paths.analysis)).filter((n) => n.includes('staging'))).toEqual(
      [],
    );
    expect(
      JSON.parse((await world.run(['status', '--json'])).stdout).binaries[0].steps.analyze.status,
    ).toBe('failed');

    world.setEnv('FAKE_GHIDRA_MODE', 'ok');
    const retry = await world.run(['analyze'], { overrides: HERMETIC });
    expect(retry.code, retry.stderr).toBe(0);
    await expect(
      fs.stat(path.join(project.analysisDir(id), 'functions.json')),
    ).resolves.toBeTruthy();
  });

  it('detects an export script that produced no result', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    world.setEnv('FAKE_GHIDRA_MODE', 'noexport');
    const result = await world.run(['analyze'], { overrides: HERMETIC });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('produced no result');
  });

  it('rejects malformed export files via schema validation', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    const functionsFile = world.ghidraLog.replace(
      'ghidra-invocations.jsonl',
      'fake-ghidra-functions.json',
    );
    await fs.writeFile(
      functionsFile,
      JSON.stringify([{ name: 'broken', address: 'not-hex', size: 1 }]),
    );
    const result = await world.run(['analyze'], { overrides: HERMETIC });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('unexpected structure');
  });

  it('terminates a hanging Ghidra run on timeout', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    world.setEnv('FAKE_GHIDRA_MODE', 'hang');
    const project = await Project.open(world.projectDir);
    const decompiler = new GhidraDecompiler({
      installDir: process.env['GHIDRA_INSTALL_DIR'],
      javaCommand: 'java',
    });
    const binary = project.binaries[0]!;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await expect(
      decompiler.analyze({
        binaryPath: project.binaryPath(binary),
        metadata: binary.metadata,
        outputDirectory: path.join(world.root, 'out'),
        workDirectory: path.join(world.root, 'wd'),
        logFile: path.join(world.root, 'l.log'),
        timeoutSeconds: 30,
        maxFunctions: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('Ghidra project directory', () => {
  it('never lies below a dot-prefixed directory such as .recode (real Ghidra rejects it)', async () => {
    const { hasHiddenSegment, createProjectDirectory } =
      await import('../../src/decompiler/ghidra/ghidra-decompiler.js');
    expect(hasHiddenSegment('/home/u/proj/.recode/work')).toBe(true);
    expect(hasHiddenSegment('C:\\Users\\u\\proj\\.recode\\work')).toBe(true);
    expect(hasHiddenSegment('/home/u/proj/analysis')).toBe(false);
    expect(hasHiddenSegment('/home/u/proj/./analysis/../x')).toBe(false);
    const dir = await createProjectDirectory({
      workDirectory: '/x/.recode/work/b',
      outputDirectory: '/x/analysis/b',
    } as Parameters<typeof createProjectDirectory>[0]);
    expect(hasHiddenSegment(dir)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
