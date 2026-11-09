import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { RecodeError } from '../core/errors/index.js';
import type { ArchiveLimits } from '../input/extractors/zip.js';
import { extractZip } from '../input/extractors/zip.js';
import { inspectInstallation, type GhidraInstallation } from '../decompiler/ghidra/locate.js';

export const GHIDRA_RELEASE_API =
  'https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest';

const ReleaseSchema = z.object({
  tag_name: z.string(),
  body: z.string().nullish(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string().url(),
      size: z.number().int().nonnegative().optional(),
      digest: z.string().nullish(),
    }),
  ),
});

export interface GhidraDownload {
  version: string;
  name: string;
  url: string;
  sha256: string;
  size: number | undefined;
}

const ASSET_PATTERN = /^ghidra_(\d+(?:\.\d+)*)_PUBLIC_\d+\.zip$/;

/**
 * Picks the Ghidra distribution from a GitHub release and its SHA-256. The checksum comes from the
 * asset's `digest` or, as fallback, the release notes; without one, nothing is downloaded.
 */
export function parseRelease(json: unknown): GhidraDownload {
  const release = ReleaseSchema.safeParse(json);
  if (!release.success) {
    throw new RecodeError('PARSE', 'Unexpected response from the GitHub releases API.');
  }
  const asset = release.data.assets.find((a) => ASSET_PATTERN.test(a.name));
  if (!asset)
    throw new RecodeError('PARSE', 'The latest Ghidra release has no PUBLIC zip distribution.');
  const version = ASSET_PATTERN.exec(asset.name)?.[1] ?? release.data.tag_name;

  let sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1];
  if (!sha256) {
    const line = (release.data.body ?? '')
      .split('\n')
      .find((l) => l.includes(asset.name) || /sha-?256/i.test(l));
    sha256 = line ? /\b([0-9a-f]{64})\b/i.exec(line)?.[1] : undefined;
  }
  if (!sha256) {
    throw new RecodeError(
      'PARSE',
      `No SHA-256 checksum published for ${asset.name}; refusing to install an unverified download.`,
      {
        hint: 'Download Ghidra manually and set GHIDRA_INSTALL_DIR.',
      },
    );
  }
  return {
    version,
    name: asset.name,
    url: asset.browser_download_url,
    sha256: sha256.toLowerCase(),
    size: asset.size,
  };
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  api: string = GHIDRA_RELEASE_API,
): Promise<GhidraDownload> {
  let response: Response;
  try {
    response = await fetchImpl(api, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'recode-setup' },
    });
  } catch (error) {
    throw new RecodeError('TOOL_FAILED', `Cannot reach GitHub: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new RecodeError('TOOL_FAILED', `GitHub releases API answered ${response.status}.`);
  }
  return parseRelease(await response.json());
}

/** Downloads a file while hashing it; the file is deleted if the checksum does not match. */
export async function downloadVerified(
  url: string,
  target: string,
  expectedSha256: string,
  options: {
    fetchImpl?: typeof fetch;
    onProgress?: (received: number, total: number | undefined) => void;
  } = {},
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { 'user-agent': 'recode-setup' },
  });
  if (!response.ok || !response.body) {
    throw new RecodeError('TOOL_FAILED', `Download failed with status ${response.status}: ${url}`);
  }
  const total = Number(response.headers.get('content-length')) || undefined;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      options.onProgress?.(received, total);
      callback(null, chunk);
    },
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(target));
  } catch (error) {
    await fs.rm(target, { force: true });
    throw new RecodeError('TOOL_FAILED', `Download interrupted: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const actual = hash.digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    await fs.rm(target, { force: true });
    throw new RecodeError(
      'TOOL_FAILED',
      `Checksum mismatch for ${path.basename(target)} (expected ${expectedSha256}, got ${actual}). The file was deleted.`,
    );
  }
}

const GHIDRA_LIMITS: ArchiveLimits = {
  maxFiles: 60_000,
  maxTotalBytes: 6 * 1024 ** 3,
  maxFileBytes: 1024 ** 3,
  maxCompressionRatio: 1000,
};

/** Installs a downloaded Ghidra release below `installRoot` and returns the validated installation. */
export async function installGhidra(
  download: GhidraDownload,
  installRoot: string,
  options: {
    fetchImpl?: typeof fetch;
    onProgress?: (received: number, total: number | undefined) => void;
  } = {},
): Promise<GhidraInstallation> {
  const zip = path.join(installRoot, 'downloads', download.name);
  await downloadVerified(download.url, zip, download.sha256, options);
  const staging = path.join(installRoot, `staging-${process.pid}`);
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await extractZip(zip, staging, GHIDRA_LIMITS);
    const entries = await fs.readdir(staging);
    const top = entries.length === 1 ? entries[0] : undefined;
    const source = top ? path.join(staging, top) : staging;
    const target = path.join(installRoot, top ?? `ghidra_${download.version}_PUBLIC`);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(source, target);
    const installation = await inspectInstallation(target);
    if (!installation) {
      throw new RecodeError('TOOL_FAILED', 'The extracted archive is not a Ghidra installation.');
    }
    await fs.rm(zip, { force: true });
    return installation;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
