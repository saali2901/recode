import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../src/core/project/project.js';
import { buildMachO, buildPe, buildZip } from '../helpers/binaries.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld } from '../helpers/world.js';
import { registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
afterEach(() => vi.unstubAllEnvs());

describe('recode import', () => {
  it('imports ELF, PE and Mach-O files and writes metadata.json', async () => {
    const world = await createWorld();
    const pe = path.join(world.workDir, 'tool.exe');
    const macho = path.join(world.workDir, 'tool.macho');
    await fs.writeFile(pe, buildPe({ bits: 32 }));
    await fs.writeFile(macho, buildMachO());
    for (const file of [SAMPLE_ELF, pe, macho]) {
      const result = await world.run(['import', file]);
      expect(result.code, result.stderr).toBe(0);
    }
    const project = await Project.open(world.projectDir);
    expect(project.binaries.map((b) => b.metadata.format)).toEqual(['elf', 'pe', 'macho']);
    const meta = JSON.parse(
      await fs.readFile(
        path.join(project.analysisDir(project.binaries[1]!.id), 'metadata.json'),
        'utf8',
      ),
    );
    expect(meta).toMatchObject({ format: 'pe', architecture: 'x86', bits: 32 });
  });

  it('is idempotent for the same file and never overwrites input files', async () => {
    const world = await createWorld();
    await world.run(['import', SAMPLE_ELF]);
    const again = await world.run(['import', SAMPLE_ELF]);
    expect(again.stdout).toContain('Already imported');
    const project = await Project.open(world.projectDir);
    expect(project.binaries).toHaveLength(1);
    expect(await fs.readdir(project.paths.input)).toHaveLength(1);
  });

  it('requires explicit metadata for raw binaries and explains how to give it', async () => {
    const world = await createWorld();
    const raw = path.join(world.workDir, 'firmware.bin');
    await fs.writeFile(raw, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const missing = await world.run(['import', raw]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--arch');

    const bad = await world.run([
      'import',
      raw,
      '--arch',
      'arm',
      '--endian',
      'little',
      '--bits',
      '32',
      '--base',
      'zzz',
    ]);
    expect(bad.code).toBe(2);

    const ok = await world.run([
      'import',
      raw,
      '--arch',
      'arm',
      '--endian',
      'little',
      '--bits',
      '32',
      '--base',
      '8000',
      '--entry',
      '0x8000',
    ]);
    expect(ok.code, ok.stderr).toBe(0);
    const project = await Project.open(world.projectDir);
    expect(project.binaries[0]!.metadata).toMatchObject({
      format: 'raw',
      source: 'user',
      architecture: 'arm',
      baseAddress: '0x8000',
      entryPoint: '0x8000',
    });
  });

  it('accepts unknown content only with --raw', async () => {
    const world = await createWorld();
    const file = path.join(world.workDir, 'blob.dat');
    await fs.writeFile(file, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const refused = await world.run(['import', file]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--raw');
    const accepted = await world.run([
      'import',
      file,
      '--raw',
      '--arch',
      'x86_64',
      '--endian',
      'little',
      '--bits',
      '64',
      '--base',
      '0x1000',
    ]);
    expect(accepted.code, accepted.stderr).toBe(0);
  });

  it('stores source, header, JSON, YAML, TXT and MAP files as reference material, not binaries', async () => {
    const world = await createWorld();
    for (const name of ['a.c', 'b.cpp', 'c.h', 'd.json', 'e.yaml', 'f.txt', 'g.map']) {
      const file = path.join(world.workDir, name);
      await fs.writeFile(file, 'text\n');
      const result = await world.run(['import', file]);
      expect(result.code, `${name}: ${result.stderr}`).toBe(0);
    }
    const project = await Project.open(world.projectDir);
    expect(project.binaries).toHaveLength(0);
    expect(project.references).toHaveLength(7);
    expect((await fs.readdir(project.paths.reference)).sort()).toEqual([
      'a.c',
      'b.cpp',
      'c.h',
      'd.json',
      'e.yaml',
      'f.txt',
      'g.map',
    ]);
  });

  it('extracts ZIP archives, importing contained binaries', async () => {
    const world = await createWorld();
    const zip = path.join(world.workDir, 'bundle.zip');
    await fs.writeFile(
      zip,
      buildZip([
        { name: 'bin/app.exe', data: buildPe({}) },
        { name: 'bin/lib.dll', data: buildPe({ dll: true }) },
        { name: 'README.txt', data: Buffer.from('docs') },
      ]),
    );
    const result = await world.run(['import', zip]);
    expect(result.code, result.stderr).toBe(0);
    const project = await Project.open(world.projectDir);
    expect(project.binaries.map((b) => b.metadata.kind).sort()).toEqual([
      'executable',
      'shared-library',
    ]);
    expect(project.binaries[0]!.relativePath).toMatch(/^input\/bundle\/bin\//);
  });

  it('rejects malicious archives without writing outside the project', async () => {
    const world = await createWorld();
    const zip = path.join(world.workDir, 'evil.zip');
    await fs.writeFile(zip, buildZip([{ name: '../../escaped.txt', data: Buffer.from('x') }]));
    const result = await world.run(['import', zip]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unsafe path');
    await expect(fs.stat(path.join(world.root, 'escaped.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(world.workDir, 'escaped.txt'))).rejects.toThrow();
  });

  it('reports missing files and directories clearly', async () => {
    const world = await createWorld();
    expect((await world.run(['import', '/nonexistent/file'])).code).toBe(2);
    const dir = await world.run(['import', world.workDir]);
    expect(dir.code).toBe(2);
    expect(dir.stderr).toContain('not a regular file');
  });
});
