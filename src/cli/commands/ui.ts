import path from 'node:path';
import type { Command } from 'commander';
import { assetPath } from '../../infrastructure/filesystem/assets.js';
import { runProcess } from '../../infrastructure/process/process-manager.js';
import { startServer } from '../../server/server.js';
import type { Runtime } from '../runtime.js';

function webDirectory(): string | undefined {
  try {
    return assetPath('dist', 'web');
  } catch {
    return undefined;
  }
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  await runProcess({ command, args: [url], timeoutMs: 10_000 }).catch(() => undefined);
}

export function registerUi(program: Command, runtime: Runtime): void {
  program
    .command('ui')
    .description('Start the local web interface (127.0.0.1 only, protected by a random token)')
    .option('--workspace <dir>', 'directory containing the projects (default: ~/recode-projects)')
    .option('--port <port>', 'port to listen on (default: a free port)', '0')
    .option('--open', 'open the browser')
    .action(async (options: { workspace?: string; port: string; open?: boolean }) => {
      const staticDir = webDirectory();
      if (!staticDir) {
        runtime.out.warn(
          'The web UI is not built (dist/web missing); only the API is available. Run "npm run build".',
        );
      }
      const server = await startServer({
        ...(options.workspace ? { workspace: path.resolve(runtime.cwd, options.workspace) } : {}),
        ...(staticDir ? { staticDir } : {}),
        port: Number.parseInt(options.port, 10) || 0,
        overrides: runtime.overrides,
      });
      runtime.out.success(`ReCode web interface: ${server.url}`);
      runtime.out.info(
        'Keep this URL private: the token grants access to your projects. Press Ctrl+C to stop.',
      );
      if (options.open) await openBrowser(server.url);

      await new Promise<void>((resolve) => {
        if (runtime.signal.aborted) resolve();
        runtime.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      runtime.out.info('Stopping: running jobs are cancelled, their progress stays resumable.');
      await server.close();
    });
}
