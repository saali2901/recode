import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecodeError } from '../../src/core/errors/index.js';
import { findGekkoLanguage, planImport } from '../../src/decompiler/ghidra/import-plan.js';
import { defaultConfig } from '../../src/infrastructure/config/config.js';
import { createDefaultRegistry } from '../../src/input/adapters/registry.js';
import { BinaryMetadataSchema, type InputAdapter } from '../../src/input/interfaces/types.js';
import { buildDol, buildGcm, buildPe, buildZip } from '../helpers/binaries.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();
const registry = createDefaultRegistry(defaultConfig().archive);

function adapter(id: string): InputAdapter {
  const found = registry.get(id);
  if (!found) throw new Error(`adapter ${id} missing`);
  return found;
}

async function write(name: string, data: Buffer): Promise<string> {
  const file = path.join(await makeTempDir(), name);
  await fs.writeFile(file, data);
  return file;
}

function dolWith(patch: (header: Buffer) => void): Buffer {
  const dol = buildDol();
  patch(dol);
  return dol;
}

describe('DOL detection and metadata', () => {
  it('recognizes a valid DOL by structure and reads sections, entry and bss', async () => {
    const file = await write('main.dol', buildDol());
    expect(await registry.detect(file)).toMatchObject({
      adapterId: 'dol',
      kind: 'binary',
      format: 'dol',
    });
    const metadata = await adapter('dol').getMetadata(file);
    expect(BinaryMetadataSchema.parse(metadata)).toMatchObject({
      format: 'dol',
      platform: 'gamecube',
      architecture: 'ppc',
      bits: 32,
      endianness: 'big',
      entryPoint: '0x80003100',
      baseAddress: '0x80003100',
    });
    expect(metadata.sections.map((s) => s.name)).toEqual(['.text0', '.data0', '.bss']);
    expect(metadata.segments[0]).toMatchObject({ fileOffset: '0x100', fileSize: '0x40' });
  });

  it('is also recognized without the .dol extension, with lower confidence', async () => {
    const named = await registry.detect(await write('x.dol', buildDol()));
    const unnamed = await registry.detect(await write('x.dat', buildDol()));
    expect(unnamed.adapterId).toBe('dol');
    expect(unnamed.confidence).toBeLessThan(named.confidence);
  });

  it.each([
    ['entry outside any text section', (h: Buffer) => h.writeUInt32BE(0x8000_9000, 0xe0)],
    ['section beyond end of file', (h: Buffer) => h.writeUInt32BE(0x10_0000, 0x90)],
    ['section outside of main memory', (h: Buffer) => h.writeUInt32BE(0x1000, 0x48)],
    ['unaligned section address', (h: Buffer) => h.writeUInt32BE(0x8000_3101, 0x48)],
    ['section overlapping the header', (h: Buffer) => h.writeUInt32BE(0x80, 0x00)],
    ['overlapping sections in memory', (h: Buffer) => h.writeUInt32BE(0x8000_3110, 0x48 + 7 * 4)],
    ['bss outside of main memory', (h: Buffer) => h.writeUInt32BE(0x9000_0000, 0xd8)],
  ])('rejects a header with %s', async (_label, patch) => {
    const file = await write('bad.dol', dolWith(patch));
    expect((await registry.detect(file)).adapterId).not.toBe('dol');
    await expect(adapter('dol').getMetadata(file)).rejects.toBeInstanceOf(RecodeError);
  });

  it('does not mistake other formats or noise for a DOL', async () => {
    for (const data of [buildPe({}), Buffer.alloc(0x400), Buffer.from('hello world')]) {
      expect((await registry.detect(await write('f.dol', data))).adapterId).not.toBe('dol');
    }
  });

  it('rejects a DOL without a text section', async () => {
    const data = buildDol({ text: { slot: 7, address: 0x8000_3100, data: Buffer.alloc(0x40) } });
    expect((await registry.detect(await write('d.dol', data))).adapterId).not.toBe('dol');
  });

  it('imports a DOL byte for byte into the project input directory', async () => {
    const dol = buildDol();
    const [prepared] = await adapter('dol').prepare(
      await write('main.dol', dol),
      await makeTempDir(),
    );
    expect(prepared && (await fs.readFile(prepared.path))).toEqual(dol);
  });
});

describe('GameCube disc images', () => {
  it('detects a disc and extracts the boot DOL with game information', async () => {
    const dol = buildDol();
    const file = await write('game.iso', buildGcm(dol, { gameId: 'GM4P01', title: 'Mario Kart' }));
    expect(await registry.detect(file)).toMatchObject({ adapterId: 'gcm', format: 'gcm' });

    const [prepared] = await adapter('gcm').prepare(file, await makeTempDir());
    expect(prepared && path.basename(prepared.path)).toBe('GM4P01-boot.dol');
    expect(prepared && (await fs.readFile(prepared.path))).toEqual(dol);
    expect(prepared?.metadata).toMatchObject({
      format: 'dol',
      platform: 'gamecube',
      game: { gameId: 'GM4P01', title: 'Mario Kart', region: 'PAL (Europe)', version: 2 },
    });
  });

  it('never overwrites a previously extracted DOL', async () => {
    const file = await write('game.iso', buildGcm(buildDol()));
    const out = await makeTempDir();
    const [first] = await adapter('gcm').prepare(file, out);
    const [second] = await adapter('gcm').prepare(file, out);
    expect(second?.path).not.toBe(first?.path);
  });

  it('explains compressed containers and Wii discs instead of failing obscurely', async () => {
    const rvz = await write(
      'game.rvz',
      Buffer.concat([Buffer.from('RVZ\x01', 'latin1'), Buffer.alloc(0x500)]),
    );
    expect(await registry.detect(rvz)).toMatchObject({ adapterId: 'gcm', kind: 'binary' });
    await expect(adapter('gcm').prepare(rvz, await makeTempDir())).rejects.toThrow(/RVZ/);

    const wii = await write('wii.iso', buildGcm(buildDol(), { wii: true }));
    await expect(adapter('gcm').prepare(wii, await makeTempDir())).rejects.toThrow(/Wii/);
  });

  it('reports a damaged disc (DOL offset outside the image, or a corrupt DOL)', async () => {
    const outside = buildGcm(buildDol());
    outside.writeUInt32BE(0x7fff_0000, 0x420);
    const corrupt = buildGcm(buildDol());
    corrupt.writeUInt32BE(0, 0x1_0000 + 0xe0);
    for (const data of [outside, corrupt]) {
      const file = await write('bad.iso', data);
      await expect(adapter('gcm').prepare(file, await makeTempDir())).rejects.toThrow(
        /damaged GameCube disc/,
      );
    }
  });

  it('imports discs found inside a ZIP archive', async () => {
    const zip = await write(
      'game.zip',
      buildZip([{ name: 'game.iso', data: buildGcm(buildDol()), method: 0 }]),
    );
    expect((await registry.detect(zip)).adapterId).toBe('zip');
    const [prepared] = await adapter('zip').prepare(zip, await makeTempDir());
    expect(prepared?.metadata.platform).toBe('gamecube');
  });
});

describe('Ghidra import plan', () => {
  it('maps a DOL onto its real sections and starts at the entry point', async () => {
    const metadata = await adapter('dol').getMetadata(await write('main.dol', buildDol()));
    const plan = planImport(metadata, { gekkoLanguage: 'PowerPC:BE:32:Gekko_Broadway' });
    expect(plan.entry).toBe('0x80003100');
    expect(plan.warnings).toEqual([]);
    expect(plan.args).toEqual(
      expect.arrayContaining([
        '-processor',
        'PowerPC:BE:32:Gekko_Broadway',
        '-preScript',
        'ImportDol.java',
      ]),
    );
    expect(plan.args).toContain('.text0:0x80003100:0x40:0x100:r-x');
    expect(plan.args).toContain('.bss:0x80005000:0x100:-:rw-');
  });

  it('falls back to generic PowerPC with a warning when Ghidra lacks Gekko', async () => {
    const metadata = await adapter('dol').getMetadata(await write('m.dol', buildDol()));
    const plan = planImport(metadata, {});
    expect(plan.args).toContain('PowerPC:BE:32:default');
    expect(plan.warnings[0]).toMatch(/Gekko/);
  });

  it('finds the Gekko language in a Ghidra installation', async () => {
    const root = await makeTempDir();
    const languages = path.join(root, 'Ghidra', 'Processors', 'PowerPC', 'data', 'languages');
    await fs.mkdir(languages, { recursive: true });
    expect(await findGekkoLanguage(root)).toBeUndefined();
    await fs.writeFile(
      path.join(languages, 'ppc.ldefs'),
      '<language id="PowerPC:BE:32:default"/><language id="PowerPC:BE:32:Gekko_Broadway"/>',
    );
    expect(await findGekkoLanguage(root)).toBe('PowerPC:BE:32:Gekko_Broadway');
  });
});

describe('compressed discs via Dolphin', () => {
  const fakeTool = path.resolve('test/helpers/fake-dolphin-tool.mjs');

  /** A launcher that runs the fake through Node, as an executable file of the current platform. */
  async function launcher(): Promise<string> {
    const dir = await makeTempDir();
    if (process.platform === 'win32') {
      const file = path.join(dir, 'dolphin-tool.cmd');
      await fs.writeFile(file, `@echo off\r\n"${process.execPath}" "${fakeTool}" %*\r\n`);
      return file;
    }
    const file = path.join(dir, 'dolphin-tool');
    await fs.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${fakeTool}" "$@"\n`);
    await fs.chmod(file, 0o755);
    return file;
  }

  async function rvz(): Promise<string> {
    return write(
      'game.rvz',
      Buffer.concat([Buffer.from('RVZ\x01', 'latin1'), Buffer.alloc(0x500)]),
    );
  }

  async function withConverter(
    command: string | undefined,
    env: Record<string, string>,
  ): Promise<InputAdapter> {
    const { DolphinToolConverter } = await import('../../src/infrastructure/tools/dolphin.js');
    const reg = createDefaultRegistry(defaultConfig().archive, {
      discConverter: new DolphinToolConverter(command, { ...process.env, ...env }),
    });
    return reg.get('gcm') as InputAdapter;
  }

  it('converts an RVZ to ISO, extracts the boot DOL and removes the temporary ISO', async () => {
    const dol = buildDol();
    const iso = await write('plain.iso', buildGcm(dol, { gameId: 'GZLE01' }));
    const adapter = await withConverter(await launcher(), { FAKE_DOLPHIN_ISO: iso });
    const [prepared] = await adapter.prepare(await rvz(), await makeTempDir());
    expect(prepared && (await fs.readFile(prepared.path))).toEqual(dol);
    expect(prepared?.metadata.game?.gameId).toBe('GZLE01');
    const leftovers = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('recode-disc-'));
    expect(leftovers).toEqual([]);
  });

  it('explains how to get Dolphin when the tool is missing', async () => {
    const adapter = await withConverter('definitely-not-installed-dolphin', {});
    await expect(adapter.prepare(await rvz(), await makeTempDir())).rejects.toThrow(
      /command-line tool/,
    );
  });

  it('reports a failing conversion and a conversion without output', async () => {
    const command = await launcher();
    const failing = await withConverter(command, { FAKE_DOLPHIN_MODE: 'fail' });
    await expect(failing.prepare(await rvz(), await makeTempDir())).rejects.toThrow(
      /could not convert/,
    );
    const silent = await withConverter(command, { FAKE_DOLPHIN_MODE: 'noop' });
    await expect(silent.prepare(await rvz(), await makeTempDir())).rejects.toThrow(/no ISO/);
  });
});

describe('small-data registers in the DOL metadata and import plan', () => {
  function dolWithStartup(): Buffer {
    const words = [
      (15 << 26) | (2 << 21) | 0x8001, // lis r2,0x8001
      (24 << 26) | (2 << 21) | (2 << 16) | 0xcfd8, // ori r2,r2,0xcfd8
      (15 << 26) | (13 << 21) | 0x8002, // lis r13,0x8002
      (24 << 26) | (13 << 21) | (13 << 16) | 0x2a0c, // ori r13,r13,0x2a0c
      0x4e80_0020,
    ];
    const text = Buffer.alloc(0x40, 0x60);
    words.forEach((w, i) => text.writeUInt32BE(w >>> 0, i * 4));
    return buildDol({ text: { slot: 0, address: 0x8000_3100, data: text } });
  }

  it('records r2/r13 found in the startup code, for DOLs and for discs', async () => {
    const dol = dolWithStartup();
    const fromDol = await adapter('dol').getMetadata(await write('s.dol', dol));
    expect(fromDol.initialRegisters).toEqual({ r2: '0x8001cfd8', r13: '0x80022a0c' });
    const [fromDisc] = await adapter('gcm').prepare(
      await write('s.iso', buildGcm(dol)),
      await makeTempDir(),
    );
    expect(fromDisc?.metadata.initialRegisters).toEqual({ r2: '0x8001cfd8', r13: '0x80022a0c' });
  });

  it('hands the registers to Ghidra and leaves them out when nothing was found', async () => {
    const withRegisters = await adapter('dol').getMetadata(await write('s.dol', dolWithStartup()));
    expect(planImport(withRegisters, {}).args).toEqual(
      expect.arrayContaining(['reg:r2:0x8001cfd8', 'reg:r13:0x80022a0c']),
    );
    const without = await adapter('dol').getMetadata(await write('p.dol', buildDol()));
    expect(without.initialRegisters).toBeUndefined();
    expect(planImport(without, {}).args.some((a) => a.startsWith('reg:'))).toBe(false);
  });
});
