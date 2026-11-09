// Exports analysis results of the current program as JSON for ReCode.
// Usage (as -postScript): ExportAnalysis.java <outputDir> <maxFunctions> <entryAddress|->
//@category ReCode

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
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
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;

public class ExportAnalysis extends GhidraScript {

	private static final int DECOMPILE_TIMEOUT_SECONDS = 120;
	private static final int MAX_SYMBOLS = 200000;
	private static final int MAX_TYPES = 50000;

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
		if (address != null && getFunctionAt(address) == null) {
			disassemble(address);
			createFunction(address, null);
			analyzeChanges(currentProgram);
		}
	}

	private int exportFunctions(Path out, int maxFunctions) throws Exception {
		DecompInterface decompiler = new DecompInterface();
		decompiler.openProgram(currentProgram);
		try (BufferedWriter functions = open(out.resolve("functions.json"));
				BufferedWriter references = open(out.resolve("references.json"));
				BufferedWriter callGraph = open(out.resolve("call-graph.json"))) {
			functions.write("{\"functions\":[");
			references.write("{\"references\":[");
			callGraph.write("{\"edges\":[");
			boolean firstFunction = true;
			boolean firstReference = true;
			boolean firstEdge = true;
			int count = 0;

			FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
			while (iterator.hasNext() && count < maxFunctions && !monitor.isCancelled()) {
				Function function = iterator.next();
				String address = hex(function.getEntryPoint());
				String stem = String.format("function_%08x", function.getEntryPoint().getOffset());

				String decompiledPath = null;
				String decompileError = null;
				if (!function.isThunk()) {
					DecompileResults result =
						decompiler.decompileFunction(function, DECOMPILE_TIMEOUT_SECONDS, monitor);
					if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
						decompiledPath = "decompiled/" + stem + ".c";
						write(out.resolve(decompiledPath), result.getDecompiledFunction().getC());
					} else {
						decompileError = String.valueOf(result.getErrorMessage());
					}
				}

				StringBuilder assembly = new StringBuilder();
				Set<String> calls = new LinkedHashSet<>();
				InstructionIterator instructions =
					currentProgram.getListing().getInstructions(function.getBody(), true);
				while (instructions.hasNext()) {
					Instruction instruction = instructions.next();
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
						}
					}
				}
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
			return count;
		} finally {
			decompiler.dispose();
		}
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
