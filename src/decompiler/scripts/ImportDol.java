// Rebuilds the memory map of a GameCube/Wii DOL executable.
// ReCode imports the DOL with Ghidra's BinaryLoader (the whole file as one block at address 0) and runs this as
// -preScript. The script replaces that block by the DOL's real sections, taken from the same file bytes.
// Usage: ImportDol.java <entryAddress> <name,address,size,fileOffset|-,perms>...
//@category ReCode

import ghidra.app.script.GhidraScript;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.util.ArrayList;
import java.util.List;

public class ImportDol extends GhidraScript {

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 2) {
			throw new IllegalArgumentException(
				"usage: ImportDol.java <entryAddress> <name,address,size,fileOffset|-,perms>...");
		}
		Memory memory = currentProgram.getMemory();
		List<FileBytes> allFileBytes = memory.getAllFileBytes();
		if (allFileBytes.isEmpty()) {
			throw new IllegalStateException("The program has no file bytes; was it imported with BinaryLoader?");
		}
		FileBytes fileBytes = allFileBytes.get(0);

		for (MemoryBlock block : memory.getBlocks()) {
			memory.removeBlock(block, monitor);
		}

		for (int i = 1; i < args.length; i++) {
			String[] part = args[i].split(",");
			if (part.length != 5) {
				throw new IllegalArgumentException("invalid section description: " + args[i]);
			}
			String name = part[0];
			Address start = toAddr(parseHex(part[1]));
			long size = parseHex(part[2]);
			String perms = part[4];

			MemoryBlock block;
			if ("-".equals(part[3])) {
				block = memory.createUninitializedBlock(name, start, size, false);
			}
			else {
				long fileOffset = parseHex(part[3]);
				if (fileOffset + size > fileBytes.getSize()) {
					throw new IllegalArgumentException("section " + name + " exceeds the file");
				}
				block = memory.createInitializedBlock(name, start, fileBytes, fileOffset, size, false);
			}
			block.setRead(perms.charAt(0) == 'r');
			block.setWrite(perms.charAt(1) == 'w');
			block.setExecute(perms.charAt(2) == 'x');
		}

		Address entry = toAddr(parseHex(args[0]));
		createLabel(entry, "__start", true);
		currentProgram.getSymbolTable().addExternalEntryPoint(entry);
	}

	private static long parseHex(String text) {
		if (!text.startsWith("0x")) {
			throw new IllegalArgumentException("expected a hex number, got: " + text);
		}
		return Long.parseLong(text.substring(2), 16);
	}
}
