# Platform notes: Nintendo GameCube

Static guidance from ReCode (not derived from the binary). The analyzed program is a GameCube DOL executable.

## CPU and ABI

- IBM PowerPC 750CXe "Gekko", 32-bit, big-endian. Floating point is IEEE single/double; many floating-point
  instructions are **paired singles** (`psq_l`, `psq_st`, `ps_add`, `ps_mul`, ...): two `f32` values per register.
  Model them as two scalar `f32` operations, or as a small struct of two floats, and say so in an assumption.
- EABI calling convention: integer/pointer arguments in r3-r10, floating-point arguments in f1-f8, return value in
  r3 (r3:r4 for 64-bit) or f1. Stack pointer r1; r0 and r11/r12 are scratch.
- **r13** and **r2** are small-data anchors: `lwz r3, -0x7XXX(r13)` reads a global in `.sdata`/`.sbss`,
  `lfs f1, -0x7XXX(r2)` reads a constant in `.sdata2`. Treat these as globals or constants, not as stack or
  parameters. ReCode fixes both registers to the values found in the startup code, so these accesses usually appear as
  named globals (`DAT_8001aa80`). If you still see `unaff_r13`/`unaff_r2`, the anchor was not found; treat it as the same kind of access.
- Compiler: Metrowerks CodeWarrior. Helper routines such as `_savegpr_NN`, `_restgpr_NN`, `__cvt_fp2unsigned`,
  `__shl2i`, `__div2i` and `__ptmf_scall` are compiler runtime, not game code.

## Memory map

| Range                   | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `0x80000000-0x817FFFFF` | Main memory (24 MiB), cached mirror; where DOL code lives |
| `0xC0000000-0xC17FFFFF` | Same memory, uncached mirror                              |
| `0xCC000000-0xCC00FFFF` | Hardware registers (VI, PI, DSP, DI, SI, EXI, AI)         |
| `0xCC008000`            | GX command FIFO write port                                |

Pointers into `0x80...` are ordinary data pointers. Reads and writes in `0xCC...` are hardware access: use
`volatile` and keep the constant address.

## SDK conventions

Most library code is the Dolphin SDK (names usually carry a prefix): `OS*` (system, threads, interrupts, `OSReport`),
`GX*` (graphics), `VI*` (video), `PAD*` (controllers), `DVD*` (disc), `AX*`/`AI*` (audio), `CARD*` (memory card),
`MTX*`/`PSMTX*` (matrices, often paired singles). The DOL has no symbols: recognize an SDK function from its
behavior and mark any such name as `speculative` unless the evidence is strong. Do not invent SDK signatures.

## Writing C for this platform

- Use fixed-width types (`u8`, `u16`, `u32`, `s32`, `f32`, `f64`) as defined in the shared types result; the
  reconstruction is compiled for a host machine, so never use inline assembly or PowerPC intrinsics.
- Keep big-endian data layouts as they are; add a comment when a struct mirrors on-disc or hardware layout.
- Where a function is mostly hardware or compiler runtime code, prefer a faithful prototype plus an explanatory
  assumption over guessing its purpose.
