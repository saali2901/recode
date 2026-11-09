import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  getConfigValue,
  loadConfig,
  mergeLayers,
  parseConfig,
  setUserConfigValue,
  withConfigValue,
} from '../../src/infrastructure/config/config.js';
import { makeTempDir, registerTempCleanup } from '../helpers/tmp.js';

registerTempCleanup();

describe('configuration', () => {
  it('has conservative defaults (2 parallel agents)', () => {
    const config = defaultConfig();
    expect(config.claude.maxParallelAgents).toBe(2);
    expect(config.tools.claudeCommand).toBe('claude');
  });

  it('merges layers deeply with later layers winning', () => {
    const merged = mergeLayers(
      { claude: { batchSize: 3, maxTurns: 10 } },
      { claude: { batchSize: 9 } },
    );
    expect(merged).toEqual({ claude: { batchSize: 9, maxTurns: 10 } });
  });

  it('applies user < project < environment precedence', async () => {
    const home = await makeTempDir();
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ claude: { maxParallelAgents: 3 }, build: { timeoutSeconds: 99 } }),
    );
    const config = await loadConfig({
      projectLayer: { claude: { maxParallelAgents: 4 } },
      env: { RECODE_HOME: home, GHIDRA_INSTALL_DIR: '/opt/g' },
    });
    expect(config.claude.maxParallelAgents).toBe(4);
    expect(config.build.timeoutSeconds).toBe(99);
    expect(config.tools.ghidraInstallDir).toBe('/opt/g');
  });

  it('rejects unknown keys and out-of-range values with readable messages', () => {
    expect(() => parseConfig({ claude: { maxParallelAgentz: 2 } })).toThrow(
      /Invalid configuration/,
    );
    expect(() => parseConfig({ claude: { maxParallelAgents: 0 } })).toThrow(/maxParallelAgents/);
    expect(() => parseConfig({ claude: { maxParallelAgents: 100 } })).toThrow(/maxParallelAgents/);
  });

  it('sets typed values and validates before persisting', async () => {
    expect(withConfigValue({}, 'claude.maxParallelAgents', '3')).toEqual({
      claude: { maxParallelAgents: 3 },
    });
    expect(withConfigValue({}, 'tools.ghidraInstallDir', '/opt/ghidra')).toEqual({
      tools: { ghidraInstallDir: '/opt/ghidra' },
    });
    expect(() => withConfigValue({}, 'claude.maxParallelAgents', '"many"')).toThrow(
      /Invalid configuration/,
    );
    expect(() => withConfigValue({}, 'nope.key', '1')).toThrow(/Invalid configuration/);

    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await setUserConfigValue(file, 'claude.batchSize', '4');
    await expect(setUserConfigValue(file, 'claude.batchSize', '0')).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ claude: { batchSize: 4 } });
  });

  it('reads values by dotted key', () => {
    expect(getConfigValue(defaultConfig(), 'claude.maxParallelAgents')).toBe(2);
    expect(() => getConfigValue(defaultConfig(), 'claude.nothing')).toThrow(
      /Unknown configuration key/,
    );
  });
});
