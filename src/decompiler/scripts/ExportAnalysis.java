// Exports analysis results of the current program as JSON for ReCode.
// Usage (as -postScript): ExportAnalysis.java <outputDir> <maxFunctions> <entryAddress|-> [decompilerThreads]
//@category ReCode

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.block.BasicBlockModel;
import ghidra.program.model.block.CodeBlockIterator;
import ghidra.program.model.data.AbstractStringDataType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.symbol.ExternalLocation;
import ghidra.program.model.symbol.ExternalLocationIterator;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.data.ArchiveType;
import ghidra.program.model.data.Composite;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.DataTypeComponent;
import ghidra.program.model.data.Enum;
import ghidra.program.model.data.SourceArchive;
import ghidra.program.model.data.TypeDef;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SourceType;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class ExportAnalysis extends GhidraScript {

	private static final int DECOMPILE_TIMEOUT_SECONDS = 120;
	private static final int MAX_SYMBOLS = 200000;
	private static final int MAX_TYPES = 50000;
	private static final int MAX_STRINGS = 20000;
	private static final int MAX_DATA_REFS_PER_FUNCTION = 200;
	private static final int MAX_STRING_CHARS = 200;

	/** Decompiler output of one function, produced on a worker thread when decompilerThreads > 1. */
	private static final class Decompiled {
		String c;
		String error;
	}

	private final List<String> factsWarnings = new ArrayList<>();
	private int decompilerThreads = 1;

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 3) {
			throw new IllegalArgumentException(
				"usage: ExportAnalysis.java <outputDir> <maxFunctions> <entryAddress|->");
		}
		Path out = Paths.get(args[0]);
		int maxFunctions = Integer.parseInt(args[1]);
		String entry = args[2];
		if (args.length >= 4) {
			decompilerThreads = Math.max(1, Math.min(16, Integer.parseInt(args[3])));
		}
		Files.createDirectories(out.resolve("decompiled"));
		Files.createDirectories(out.resolve("asm"));

		if (!"-".equals(entry)) {
			createEntryFunction(entry);
		}

		int functionCount = exportFunctions(out, maxFunctions);
		int symbolCount = exportSymbols(out);
		int typeCount = exportTypes(out);

		// Written last: its presence marks a complete export.
		String program = "{" +
			"\"ghidraVersion\":" + q(Application.getApplicationVersion()) + "," +
			"\"language\":" + q(currentProgram.getLanguageID().toString()) + "," +
			"\"compiler\":" + q(currentProgram.getCompilerSpec().getCompilerSpecID().toString()) + "," +
			"\"imageBase\":" + q(hex(currentProgram.getImageBase())) + "," +
			"\"executableFormat\":" + q(String.valueOf(currentProgram.getExecutableFormat())) + "," +
			"\"functionCount\":" + functionCount + "," +
			"\"symbolCount\":" + symbolCount + "," +
			"\"typeCount\":" + typeCount + "}";
		write(out.resolve("program.json"), program);
	}

	private void createEntryFunction(String entry) throws Exception {
		Address address = toAddr(entry);
		if (address == null || !currentProgram.getMemory().contains(address)) {
			throw new IllegalStateException("Entry point " + entry
				+ " is not in program memory; the import script probably failed (see the log).");
		}
		if (getFunctionAt(address) == null) {
			disassemble(address);
			createFunction(address, null);
			analyzeChanges(currentProgram);
		}
	}

	private Decompiled decompileOne(DecompInterface decompiler, Function function) {
		Decompiled out = new Decompiled();
		DecompileResults result =
			decompiler.decompileFunction(function, DECOMPILE_TIMEOUT_SECONDS, monitor);
		if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
			out.c = result.getDecompiledFunction().getC();
		} else {
			out.error = String.valueOf(result.getErrorMessage());
		}
		return out;
	}

	private int exportFunctions(Path out, int maxFunctions) throws Exception {
		DecompInterface decompiler = new DecompInterface();
		decompiler.openProgram(currentProgram);
		// Optional parallel decompilation: every worker thread owns its own decompiler process (the same pattern
		// Ghidra's ParallelDecompiler uses). Results are consumed in function order, so the output is identical.
		ExecutorService pool = decompilerThreads > 1 ? Executors.newFixedThreadPool(decompilerThreads) : null;
		List<DecompInterface> workerDecompilers = new ArrayList<>();
		ThreadLocal<DecompInterface> perThread = new ThreadLocal<>();
		ArrayDeque<Future<Decompiled>> window = new ArrayDeque<>();
		BasicBlockModel blockModel = new BasicBlockModel(currentProgram);
		try (BufferedWriter functions = open(out.resolve("functions.json"));
				BufferedWriter references = open(out.resolve("references.json"));
				BufferedWriter callGraph = open(out.resolve("call-graph.json"));
				BufferedWriter facts = open(out.resolve("facts.json"))) {
			functions.write("{\"functions\":[");
			facts.write("{\"functions\":[");
			boolean firstFact = true;
			references.write("{\"references\":[");
			callGraph.write("{\"edges\":[");
			boolean firstFunction = true;
			boolean firstReference = true;
			boolean firstEdge = true;
			int count = 0;

			List<Function> selected = new ArrayList<>();
			FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
			while (iterator.hasNext() && selected.size() < maxFunctions && !monitor.isCancelled()) {
				selected.add(iterator.next());
			}
			int nextToSubmit = 0;
			for (int index = 0; index < selected.size() && !monitor.isCancelled(); index++) {
				Function function = selected.get(index);
				String address = hex(function.getEntryPoint());
				String stem = String.format("function_%08x", function.getEntryPoint().getOffset());

				String decompiledPath = null;
				String decompileError = null;
				if (pool != null) {
					// keep a bounded look-ahead of submitted decompilations (memory stays small)
					while (nextToSubmit < selected.size() && window.size() < decompilerThreads * 4) {
						final Function target = selected.get(nextToSubmit++);
						if (target.isThunk()) {
							window.add(null);
							continue;
						}
						window.add(pool.submit((Callable<Decompiled>) () -> {
							DecompInterface mine = perThread.get();
							if (mine == null) {
								mine = new DecompInterface();
								mine.openProgram(currentProgram);
								synchronized (workerDecompilers) {
									workerDecompilers.add(mine);
								}
								perThread.set(mine);
							}
							return decompileOne(mine, target);
						}));
					}
					Future<Decompiled> future = window.poll();
					if (future != null) {
						Decompiled done = future.get();
						if (done.c != null) {
							decompiledPath = "decompiled/" + stem + ".c";
							write(out.resolve(decompiledPath), done.c);
						} else {
							decompileError = done.error;
						}
					}
				} else if (!function.isThunk()) {
					Decompiled done = decompileOne(decompiler, function);
					if (done.c != null) {
						decompiledPath = "decompiled/" + stem + ".c";
						write(out.resolve(decompiledPath), done.c);
					} else {
						decompileError = done.error;
					}
				}

				StringBuilder assembly = new StringBuilder();
				Set<String> calls = new LinkedHashSet<>();
				Set<String> dataRefs = new LinkedHashSet<>();
				int instructionCount = 0;
				int indirectCalls = 0;
				int computedJumps = 0;
				InstructionIterator instructions =
					currentProgram.getListing().getInstructions(function.getBody(), true);
				while (instructions.hasNext()) {
					Instruction instruction = instructions.next();
					instructionCount++;
					FlowType flow = instruction.getFlowType();
					if (flow.isComputed()) {
						if (flow.isCall()) indirectCalls++;
						else if (flow.isJump()) computedJumps++;
					}
					assembly.append(hex(instruction.getAddress())).append(": ")
						.append(instruction).append('\n');
					for (Reference reference : instruction.getReferencesFrom()) {
						boolean isCall = reference.getReferenceType().isCall();
						String to = hex(reference.getToAddress());
						if (!firstReference) references.write(",");
						firstReference = false;
						references.write("{\"from\":" + q(hex(instruction.getAddress())) +
							",\"to\":" + q(to) +
							",\"type\":" + q(reference.getReferenceType().getName()) +
							",\"fromFunction\":" + q(address) +
							",\"external\":" + reference.isExternalReference() + "}");
						if (isCall) {
							calls.add(to);
						} else if (reference.getReferenceType().isData() && !reference.isExternalReference()
								&& dataRefs.size() < MAX_DATA_REFS_PER_FUNCTION
								&& getFunctionAt(reference.getToAddress()) == null) {
							dataRefs.add(to);
						}
					}
				}
				int basicBlocks = 0;
				try {
					CodeBlockIterator blocks =
						blockModel.getCodeBlocksContaining(function.getBody(), monitor);
					while (blocks.hasNext()) {
						blocks.next();
						basicBlocks++;
					}
				} catch (Exception e) {
					factsWarnings.add("basic blocks of " + address + ": " + e.getMessage());
				}
				StringBuilder dataRefsJson = new StringBuilder();
				for (String ref : dataRefs) {
					if (dataRefsJson.length() > 0) dataRefsJson.append(",");
					dataRefsJson.append(q(ref));
				}
				if (!firstFact) facts.write(",");
				firstFact = false;
				facts.write("{\"address\":" + q(address) +
					",\"basicBlocks\":" + basicBlocks +
					",\"instructionCount\":" + instructionCount +
					",\"indirectCalls\":" + indirectCalls +
					",\"computedJumps\":" + computedJumps +
					",\"hasNoReturn\":" + function.hasNoReturn() +
					",\"stackFrameSize\":" + Math.max(0, function.getStackFrame().getFrameSize()) +
					",\"dataRefs\":[" + dataRefsJson + "]}");

				String assemblyPath = "asm/" + stem + ".asm";
				write(out.resolve(assemblyPath), assembly.toString());

				for (String target : calls) {
					if (!firstEdge) callGraph.write(",");
					firstEdge = false;
					callGraph.write("{\"from\":" + q(address) + ",\"to\":" + q(target) + "}");
				}

				StringBuilder calledBy = new StringBuilder();
				for (Function caller : function.getCallingFunctions(monitor)) {
					if (calledBy.length() > 0) calledBy.append(",");
					calledBy.append(q(hex(caller.getEntryPoint())));
				}
				StringBuilder callsJson = new StringBuilder();
				for (String target : calls) {
					if (callsJson.length() > 0) callsJson.append(",");
					callsJson.append(q(target));
				}

				if (!firstFunction) functions.write(",");
				firstFunction = false;
				functions.write("{\"address\":" + q(address) +
					",\"name\":" + q(function.getName()) +
					",\"signature\":" + q(function.getPrototypeString(false, false)) +
					",\"returnType\":" + q(function.getReturnType().getName()) +
					",\"callingConvention\":" + q(function.getCallingConventionName()) +
					",\"parameterCount\":" + function.getParameterCount() +
					",\"size\":" + function.getBody().getNumAddresses() +
					",\"isThunk\":" + function.isThunk() +
					",\"isExternal\":" + function.isExternal() +
					",\"hasUserDefinedName\":" +
					(function.getSymbol().getSource() != SourceType.DEFAULT) +
					",\"calls\":[" + callsJson + "]" +
					",\"calledBy\":[" + calledBy + "]" +
					",\"decompiledFile\":" + (decompiledPath == null ? "null" : q(decompiledPath)) +
					",\"decompileError\":" + (decompileError == null ? "null" : q(decompileError)) +
					",\"disassemblyFile\":" + q(assemblyPath) + "}");
				count++;
			}
			functions.write("]}");
			references.write("]}");
			callGraph.write("]}");
			facts.write("]");
			writeFactsTail(facts);
			facts.write("}");
			return count;
		} finally {
			if (pool != null) pool.shutdownNow();
			synchronized (workerDecompilers) {
				for (DecompInterface worker : workerDecompilers) worker.dispose();
			}
			decompiler.dispose();
		}
	}

	/** Strings, imports and exports of the program. Each part is optional: a failure becomes a warning. */
	private void writeFactsTail(BufferedWriter facts) throws IOException {
		facts.write(",\"strings\":[");
		try {
			DataIterator data = currentProgram.getListing().getDefinedData(true);
			int strings = 0;
			while (data.hasNext() && strings < MAX_STRINGS && !monitor.isCancelled()) {
				Data item = data.next();
				if (!(item.getDataType() instanceof AbstractStringDataType)) continue;
				Object value = item.getValue();
				if (value == null) continue;
				String text = String.valueOf(value);
				if (text.length() > MAX_STRING_CHARS) text = text.substring(0, MAX_STRING_CHARS);
				if (strings > 0) facts.write(",");
				facts.write("{\"address\":" + q(hex(item.getAddress())) + ",\"value\":" + q(text) +
					",\"length\":" + item.getLength() + "}");
				strings++;
			}
		} catch (Exception e) {
			factsWarnings.add("strings: " + e.getMessage());
		}
		facts.write("],\"imports\":[");
		try {
			boolean first = true;
			for (String library : currentProgram.getExternalManager().getExternalLibraryNames()) {
				ExternalLocationIterator locations =
					currentProgram.getExternalManager().getExternalLocations(library);
				while (locations.hasNext()) {
					ExternalLocation location = locations.next();
					if (!first) facts.write(",");
					first = false;
					Address address = location.getAddress();
					facts.write("{\"library\":" + q(library) + ",\"name\":" + q(location.getLabel()) +
						",\"address\":" + (address == null ? "null" : q(hex(address))) + "}");
				}
			}
		} catch (Exception e) {
			factsWarnings.add("imports: " + e.getMessage());
		}
		facts.write("],\"exports\":[");
		try {
			AddressIterator entries = currentProgram.getSymbolTable().getExternalEntryPointIterator();
			boolean first = true;
			while (entries.hasNext()) {
				Address address = entries.next();
				Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(address);
				if (symbol == null) continue;
				if (!first) facts.write(",");
				first = false;
				facts.write("{\"name\":" + q(symbol.getName()) + ",\"address\":" + q(hex(address)) + "}");
			}
		} catch (Exception e) {
			factsWarnings.add("exports: " + e.getMessage());
		}
		facts.write("],\"warnings\":[");
		for (int i = 0; i < factsWarnings.size() && i < 50; i++) {
			if (i > 0) facts.write(",");
			facts.write(q(factsWarnings.get(i)));
		}
		facts.write("]");
	}

	private int exportSymbols(Path out) throws Exception {
		int count = 0;
		try (BufferedWriter writer = open(out.resolve("symbols.json"))) {
			writer.write("{\"symbols\":[");
			SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
			boolean first = true;
			while (symbols.hasNext() && count < MAX_SYMBOLS && !monitor.isCancelled()) {
				Symbol symbol = symbols.next();
				if (symbol.getSource() == SourceType.DEFAULT) continue;
				if (!first) writer.write(",");
				first = false;
				writer.write("{\"name\":" + q(symbol.getName()) +
					",\"address\":" + q(hex(symbol.getAddress())) +
					",\"type\":" + q(symbol.getSymbolType().toString()) +
					",\"source\":" + q(symbol.getSource().toString()) +
					",\"namespace\":" + q(symbol.getParentNamespace().getName()) +
					",\"isExternal\":" + symbol.isExternal() + "}");
				count++;
			}
			writer.write("]}");
		}
		return count;
	}

	private int exportTypes(Path out) throws Exception {
		int count = 0;
		try (BufferedWriter writer = open(out.resolve("types.json"))) {
			writer.write("{\"types\":[");
			Iterator<DataType> types = currentProgram.getDataTypeManager().getAllDataTypes();
			boolean first = true;
			while (types.hasNext() && count < MAX_TYPES && !monitor.isCancelled()) {
				DataType type = types.next();
				if (!isProgramLocal(type)) continue;
				String json = describeType(type);
				if (json == null) continue;
				if (!first) writer.write(",");
				first = false;
				writer.write(json);
				count++;
			}
			writer.write("]}");
		}
		return count;
	}

	private boolean isProgramLocal(DataType type) {
		SourceArchive archive = type.getSourceArchive();
		return archive == null || archive.getArchiveType() == ArchiveType.PROGRAM;
	}

	private String describeType(DataType type) {
		String common = "{\"name\":" + q(type.getName()) +
			",\"category\":" + q(type.getCategoryPath().getPath()) +
			",\"size\":" + type.getLength();
		if (type instanceof Composite) {
			Composite composite = (Composite) type;
			StringBuilder fields = new StringBuilder();
			for (DataTypeComponent component : composite.getDefinedComponents()) {
				if (fields.length() > 0) fields.append(",");
				String fieldName = component.getFieldName();
				if (fieldName == null) fieldName = "field_" + component.getOffset();
				fields.append("{\"name\":").append(q(fieldName))
					.append(",\"type\":").append(q(component.getDataType().getName()))
					.append(",\"offset\":").append(component.getOffset())
					.append(",\"size\":").append(component.getLength()).append("}");
			}
			String kind = composite instanceof ghidra.program.model.data.Union ? "union" : "struct";
			return common + ",\"kind\":" + q(kind) + ",\"fields\":[" + fields + "]}";
		}
		if (type instanceof Enum) {
			Enum enumeration = (Enum) type;
			StringBuilder values = new StringBuilder();
			for (String name : enumeration.getNames()) {
				if (values.length() > 0) values.append(",");
				values.append("{\"name\":").append(q(name))
					.append(",\"value\":").append(enumeration.getValue(name)).append("}");
			}
			return common + ",\"kind\":\"enum\",\"values\":[" + values + "]}";
		}
		if (type instanceof TypeDef) {
			TypeDef typedef = (TypeDef) type;
			return common + ",\"kind\":\"typedef\",\"baseType\":" +
				q(typedef.getBaseDataType().getName()) + "}";
		}
		return null;
	}

	private static String hex(Address address) {
		return "0x" + Long.toHexString(address.getOffset());
	}

	private static BufferedWriter open(Path path) throws IOException {
		return Files.newBufferedWriter(path, StandardCharsets.UTF_8);
	}

	private static void write(Path path, String content) throws IOException {
		Files.write(path, content.getBytes(StandardCharsets.UTF_8));
	}

	private static String q(String value) {
		if (value == null) return "null";
		StringBuilder builder = new StringBuilder("\"");
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			switch (c) {
				case '"': builder.append("\\\""); break;
				case '\\': builder.append("\\\\"); break;
				case '\n': builder.append("\\n"); break;
				case '\r': builder.append("\\r"); break;
				case '\t': builder.append("\\t"); break;
				default:
					if (c < 0x20) builder.append(String.format("\\u%04x", (int) c));
					else builder.append(c);
			}
		}
		return builder.append('"').toString();
	}
}
