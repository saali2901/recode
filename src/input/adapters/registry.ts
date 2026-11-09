import type { DetectionResult, DiscConverter, InputAdapter } from '../interfaces/types.js';
import type { ArchiveLimits } from '../extractors/zip.js';
import { CoffAdapter } from './coff-adapter.js';
import { DolAdapter } from './dol-adapter.js';
import { ElfAdapter } from './elf-adapter.js';
import { GcmAdapter } from './gcm-adapter.js';
import { MachOAdapter } from './macho-adapter.js';
import { PeAdapter } from './pe-adapter.js';
import { RawBinaryAdapter } from './raw-adapter.js';
import { ReferenceMaterialAdapter } from './reference-adapter.js';
import { ZipAdapter } from './zip-adapter.js';

/** Registry of input adapters. New formats are added by registering another adapter. */
export class AdapterRegistry {
  private readonly adapters: InputAdapter[] = [];
  readonly reference = new ReferenceMaterialAdapter();

  register(adapter: InputAdapter): this {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered.`);
    }
    this.adapters.push(adapter);
    return this;
  }

  get(id: string): InputAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  list(): readonly InputAdapter[] {
    return this.adapters;
  }

  /** Returns the best detection across all adapters (highest confidence; ties by registration order). */
  async detect(filePath: string): Promise<DetectionResult> {
    let best: DetectionResult = {
      adapterId: 'none',
      kind: 'unknown',
      confidence: 0,
      description: 'Unrecognized file',
    };
    const reference = await this.reference.detect(filePath);
    if (reference.confidence > best.confidence) best = reference;
    for (const adapter of this.adapters) {
      const result = await adapter.detect(filePath);
      if (result.confidence > best.confidence) best = result;
    }
    return best;
  }

  /** Like detect, but only considers analyzable binaries (not archives or reference files). */
  async detectBinary(filePath: string): Promise<DetectionResult | undefined> {
    let best: DetectionResult | undefined;
    for (const adapter of this.adapters) {
      if (adapter.id === 'zip' || adapter.id === 'raw') continue;
      const result = await adapter.detect(filePath);
      if (
        result.kind === 'binary' &&
        result.confidence >= 0.5 &&
        result.confidence > (best?.confidence ?? 0)
      ) {
        best = result;
      }
    }
    return best;
  }
}

export function createDefaultRegistry(
  archiveLimits: ArchiveLimits,
  options: { discConverter?: DiscConverter | undefined } = {},
): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry
    .register(new ElfAdapter())
    .register(new PeAdapter())
    .register(new MachOAdapter())
    .register(new CoffAdapter())
    .register(new GcmAdapter(options.discConverter))
    .register(new DolAdapter())
    .register(new RawBinaryAdapter());
  registry.register(new ZipAdapter(registry, archiveLimits));
  return registry;
}
