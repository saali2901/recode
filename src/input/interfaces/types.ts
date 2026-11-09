import { z } from 'zod';

/** Hex-encoded address or size, e.g. "0x401000". Avoids 53-bit precision loss in JSON. */
export const HexSchema = z.string().regex(/^0x[0-9a-f]+$/);

export const BinaryFormatSchema = z.enum(['elf', 'pe', 'macho', 'coff', 'dol', 'raw']);
export type BinaryFormat = z.infer<typeof BinaryFormatSchema>;

export const BinaryKindSchema = z.enum(['executable', 'shared-library', 'object', 'raw', 'other']);
export type BinaryKind = z.infer<typeof BinaryKindSchema>;

export const ArchitectureSchema = z.enum([
  'x86',
  'x86_64',
  'arm',
  'aarch64',
  'mips',
  'mips64',
  'ppc',
  'ppc64',
  'riscv32',
  'riscv64',
  'unknown',
]);
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const EndiannessSchema = z.enum(['little', 'big']);
export type Endianness = z.infer<typeof EndiannessSchema>;

/** Console or system a binary was built for. Drives platform-specific analysis and agent guidance. */
export const PlatformSchema = z.enum(['gamecube']);
export type Platform = z.infer<typeof PlatformSchema>;

/** Identification of the game a binary belongs to, read from a disc image header. */
export const GameInfoSchema = z.object({
  gameId: z.string(),
  title: z.string(),
  region: z.string().optional(),
  discNumber: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional(),
});
export type GameInfo = z.infer<typeof GameInfoSchema>;

export const SectionSchema = z.object({
  name: z.string(),
  address: HexSchema,
  size: HexSchema,
  fileOffset: HexSchema.optional(),
  permissions: z.string().optional(),
});
export type Section = z.infer<typeof SectionSchema>;

export const SegmentSchema = z.object({
  name: z.string().optional(),
  address: HexSchema,
  size: HexSchema,
  fileOffset: HexSchema,
  fileSize: HexSchema,
  permissions: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const BinarySymbolSchema = z.object({
  name: z.string(),
  address: HexSchema,
  size: HexSchema.optional(),
  type: z.enum(['function', 'object', 'other']),
  binding: z.enum(['local', 'global', 'weak']).optional(),
});
export type BinarySymbol = z.infer<typeof BinarySymbolSchema>;

/** Facts extracted from a binary's own headers. Nothing in here is guessed. */
export const BinaryMetadataSchema = z.object({
  format: BinaryFormatSchema,
  kind: BinaryKindSchema,
  architecture: ArchitectureSchema,
  bits: z.union([z.literal(16), z.literal(32), z.literal(64)]),
  endianness: EndiannessSchema,
  entryPoint: HexSchema.optional(),
  baseAddress: HexSchema.optional(),
  sections: z.array(SectionSchema),
  segments: z.array(SegmentSchema),
  symbols: z.array(BinarySymbolSchema),
  symbolsTruncated: z.boolean().default(false),
  platform: PlatformSchema.optional(),
  /** Register values the startup code loads (e.g. PowerPC small-data anchors r2/r13); found by code scan, not by header. */
  initialRegisters: z.record(z.string(), HexSchema).optional(),
  game: GameInfoSchema.optional(),
  /** Where the information came from. "user" means supplied via CLI for raw binaries. */
  source: z.enum(['headers', 'user']).default('headers'),
  warnings: z.array(z.string()).default([]),
});
export type BinaryMetadata = z.infer<typeof BinaryMetadataSchema>;

export type DetectionKind = 'binary' | 'archive' | 'reference' | 'unknown';

export interface DetectionResult {
  adapterId: string;
  kind: DetectionKind;
  format?: BinaryFormat | 'gcm' | 'zip' | 'reference';
  /** 0..1; headers with valid magic and structure score 1. */
  confidence: number;
  description: string;
}

/** User-supplied facts required for raw binaries. */
export const RawBinaryOptionsSchema = z.object({
  architecture: ArchitectureSchema.exclude(['unknown']),
  bits: z.union([z.literal(16), z.literal(32), z.literal(64)]),
  endianness: EndiannessSchema,
  baseAddress: HexSchema,
  entryPoint: HexSchema.optional(),
});
export type RawBinaryOptions = z.infer<typeof RawBinaryOptionsSchema>;

export interface MetadataHints {
  raw?: RawBinaryOptions;
}

export interface PreparedBinary {
  /** Absolute path of the prepared file inside the project. */
  path: string;
  /** Human-readable origin, e.g. archive entry or Mach-O slice description. */
  origin: string;
  metadata: BinaryMetadata;
}

/** A converted copy of a disc image; `dispose` deletes the temporary files. */
export interface ConvertedDisc {
  isoPath: string;
  dispose(): Promise<void>;
}

/** Turns compressed disc containers (RVZ, WIA, GCZ, CISO, ...) into a plain ISO using an external tool. */
export interface DiscConverter {
  convertToIso(source: string, signal?: AbortSignal): Promise<ConvertedDisc>;
}

/** Contract for every supported input format. */
export interface InputAdapter {
  readonly id: string;
  /** Inspects magic bytes and structure; must never throw for ordinary garbage input. */
  detect(filePath: string): Promise<DetectionResult>;
  /** Places analyzable binaries below `outputDirectory` without overwriting existing files. */
  prepare(
    filePath: string,
    outputDirectory: string,
    hints?: MetadataHints,
  ): Promise<PreparedBinary[]>;
  getMetadata(filePath: string, hints?: MetadataHints): Promise<BinaryMetadata>;
}
