/* MIT License. Copyright 2024 Divy Srivastava */

import { readAll } from "jsr:@std/io@0.224.6/read-all";
import { parse } from "jsr:@std/flags@0.224.0";

const args = parse(Deno.args, {
  string: ["lib", "l"],
});

if (!args.lib && !args.l) {
  console.error("missing -l argument");
  Deno.exit(1);
}

const lib = args.lib || args.l;

const inp = await readAll(Deno.stdin);
const str = new TextDecoder().decode(inp);

const symbols = JSON.parse(str) as Definition[];

type Definition = {
  tag: "typedef" | "struct";
  ns: number;
  name: string;
  location: string;
  type: Type;
} | {
  tag: "function";
  name: string;
  location: string;
  variadic?: boolean;
  inline?: boolean;
  "storage-class"?: "static" | "extern";
  ns: number;
  parameters: Parameter[];
  "return-type": Type;
};

type Parameter = {
  tag: string;
  name: string;
  type: Type;
};

function denoFFIParameter(p: Parameter): Deno.NativeType | null {
  if (p.tag !== "parameter") {
    throw new Error(`unexpected parameter tag ${p.tag}`);
  }

  const ty = denoFFIType(p.type);
  if (ty == "void") {
    throw new Error(`unexpected void parameter ${p.name}`);
  }

  return ty;
}

type Type = {
  tag: string;

  "bit-size"?: number;
  "bit-alignment"?: number;

  /* struct */
  fields?: Type[];
  type?: Type;
};

const tagMapping: Record<string, Deno.NativeResultType> = {
  "__uint16_t": "u16",
  "__uint32_t": "u32",
  "__uint64_t": "u64",
  "__uint8_t": "u8",
  "__int16_t": "i16",
  "__int32_t": "i32",
  "__int64_t": "i64",
  "__int8_t": "i8",
  ":int": "i32",
  ":unsigned-int": "u32",
  ":long": "i64",
  ":long-long": "i64",
  ":long-double": "f64",
  ":short": "i16",
  ":unsigned": "u32",
  ":unsigned-long": "u64",
  ":unsigned-short": "u16",
  ":unsigned-char": "u8",
  ":char": "u8",
  ":pointer": "pointer",
  ":function-pointer": "pointer",
  ":void": "void",
};

function denoFFIType(t: Type, hint?: string): Deno.NativeResultType | null {
  if (t.tag === ":struct" || t.tag === "struct") {
    if (t.fields === undefined) {
      return null;
    }
    // @ts-ignore
    const fields = t.fields!.map((f) => denoFFIType(f.type));
    if (fields.includes(null)) {
      const missing = fields.indexOf(null);
      console.error(
        `skipping ${hint || "struct"}. reason: field ${
          JSON.stringify(t.fields![missing])
        } has no mapping`,
      );
      return null;
    }

    return {
      struct: fields as Deno.NativeType[],
    };
  }
  return tagMapping[t.tag] ?? (resolvedTypeDefs.get(t.tag) ?? null);
}

const resolvedTypeDefs = new Map<string, Deno.NativeResultType>();

const symbolSource: Record<string, Deno.ForeignFunction & { doc: string }> = {};

let total = 0, generated = 0;
let totalTypeDefs = 0, generatedTypeDefs = 0;
const unknowns = new Map<string, number>();

for (const x of symbols) {
  switch (x.tag) {
    case "struct": {
	    /* Pass it on as a typedef */
	    x.type = x;
    }
    case "typedef": {
      totalTypeDefs++;
      let result = denoFFIType(x.type, x.name);
      if (!result) {
        // Maybe we have not yet resolved the type. Do another pass.
        for (const y of symbols) {
          if (y.tag === "typedef" && y.name === x.type.tag) {
            result = denoFFIType(y.type, x.name);
            if (result === null) {
              continue;
            }

            resolvedTypeDefs.set(x.name, result);
          }
        }
      }

      if (result === null) {
        continue;
      }
      resolvedTypeDefs.set(x.name, result);
      generatedTypeDefs++;
      break;
    }
    case "function": {
      total++;
      if (x.inline || x.variadic) {
        // skip
        console.error(
          `skipping ${x.name}. reason: ${x.inline ? "inline" : "variadic"}`,
        );
        continue;
      }

      const parameters = x.parameters.map(denoFFIParameter);
      if (parameters.includes(null)) {
        const missing = parameters.indexOf(null);
        console.error(
          `skipping ${x.name}. reason: parameter ${
            JSON.stringify(x.parameters[missing])
          } has no mapping`,
        );
        continue;
      }
      const result = denoFFIType(x["return-type"]);
      if (result === null) {
        console.error(
          `skipping ${x.name}. reason: return type ${
            JSON.stringify(x["return-type"])
          } has no mapping`,
        );
        continue;
      }
      symbolSource[x.name] = {
        parameters: parameters as Deno.NativeType[],
        result,
        doc: `${x.name} @ ${x.location}`,
      };
      generated++;
      break;
    }
    default: {
      const tag = (x as any).tag;
      unknowns.set(tag, (unknowns.get(tag) ?? 0) + 1);
      console.error(`unknown tag ${tag}`);
      break;
    }
  }
}

console.error("=== GENERATED ===");
console.error(
  `unknowns  => ${Array.from(unknowns.entries()).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
);
console.error(
  `functions => total: ${total}, generated: ${generated}, skipped: ${
    total - generated
  }`,
);
console.error(
  `typedefs  => total: ${totalTypeDefs}, generated: ${generatedTypeDefs}, skipped: ${
    totalTypeDefs - generatedTypeDefs
  }`,
);

const source = `// Generated by littledivy/ffigen
const _ = {
${
  Object.entries(symbolSource).map(([name, { parameters, result, doc }]) => {
    return `  // ${doc}
  ${name}: {
    parameters: ${JSON.stringify(parameters)},
    result: "${result}",
  }`;
  }).join(",\n")
}
} as const;

const { symbols } = Deno.dlopen(${JSON.stringify(lib)}, _);

export default symbols;
`;

console.log(source);
