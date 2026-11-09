import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/** Logger that discards everything; used in tests and before a project is open. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Creates a JSON-lines logger writing to `<logDir>/recode.log`.
 * Console output is handled by the CLI formatters, not by the logger.
 */
export function createFileLogger(logDir: string, level: string): Logger {
  fs.mkdirSync(logDir, { recursive: true });
  const destination = pino.destination({
    dest: path.join(logDir, 'recode.log'),
    sync: true,
    mkdir: true,
  });
  return pino({ level, base: { app: 'recode' } }, destination);
}
