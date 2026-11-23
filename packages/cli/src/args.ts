import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { TincanError, type ContractDescriptor } from "@beyland/tincan-protocol";

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
}

export interface FlagSpec {
  key: string;
  /** For a field of an object option (`--agents-read` sets `agents.read`): the option's key. */
  parent?: string;
  flag: string;
  type: "string" | "number" | "boolean" | "array" | "json";
  required: boolean;
  description?: string;
  choices?: unknown[];
  default?: unknown;
}

export function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function primaryType(schema: JsonSchema): string | undefined {
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((s) => s.type !== "null");
    return nonNull ? primaryType(nonNull) : undefined;
  }
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
}

function enumOf(schema: JsonSchema): unknown[] | undefined {
  return schema.enum ?? schema.anyOf?.find((s) => s.enum)?.enum;
}

function flagType(prop: JsonSchema): FlagSpec["type"] {
  const t = primaryType(prop);
  return t === "boolean"
    ? "boolean"
    : t === "number" || t === "integer"
      ? "number"
      : t === "array"
        ? primaryType(prop.items ?? {}) === "object"
          ? "json"
          : "array"
        : t === "object"
          ? "json"
          : "string";
}

function objectSchema(prop: JsonSchema): JsonSchema | undefined {
  if (prop.properties) return prop;
  return prop.anyOf?.find((s) => s.properties);
}

/**
 * Derive CLI flags from a command's JSON schema: one per top-level property, and for an object
 * property one per field too (`--agents-read known` beside `--agents '{"read":"known"}'`).
 */
export function flagsFor(command: ContractDescriptor): FlagSpec[] {
  const schema = command.inputSchema as JsonSchema;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([key, prop]) => {
    const flag: FlagSpec = {
      key,
      flag: kebab(key),
      type: flagType(prop),
      required: required.has(key),
      description: prop.description,
      choices: enumOf(prop),
      default: prop.default,
    };
    const object = flag.type === "json" ? objectSchema(prop) : undefined;
    const fields = Object.entries(object?.properties ?? {})
      .map(([field, sub]): FlagSpec => ({
        key: field,
        parent: key,
        flag: `${kebab(key)}-${kebab(field)}`,
        type: flagType(sub),
        required: false,
        description: sub.description,
        choices: enumOf(sub),
        default: sub.default,
      }))
      .filter((f) => f.type !== "json");
    return [flag, ...fields];
  });
}

/**
 * Reads a value from a file, for `--input @file.json` and `--<option>-file <path>`. Only those
 * explicit forms read files: any other value, `@` at the start included, is taken literally, so
 * text from elsewhere (a received message in a script) can never make the CLI read and send a file.
 */
async function readValueFile(raw: string, cwd: string): Promise<string> {
  const file = path.resolve(cwd, raw);
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new TincanError("INVALID_INPUT", `Could not read file ${file}`);
  }
}

/** The suffix that reads a string option from a file: `--text-file ./message.txt`. */
const FILE_SUFFIX = "-file";

function parseJson(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TincanError("INVALID_INPUT", `--${flag} expects JSON`);
  }
}

/**
 * A number option's value. `none` (or `null`) is null, for a nullable number such as
 * `--agents-send-limit none`; the command's schema refuses it where null isn't allowed.
 */
function numberValue(raw: string): number | null {
  return raw === "none" || raw === "null" ? null : Number(raw);
}

/** Turn argv for a registry command into its input object. */
export async function parseCommandInput(
  command: ContractDescriptor,
  args: string[],
  cwd: string,
): Promise<Record<string, unknown>> {
  const flags = flagsFor(command);
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
    input: { type: "string" },
  };
  const taken = new Set(flags.flatMap((f) => [f.flag, f.key]));
  for (const f of flags) {
    const spec = {
      type: f.type === "boolean" ? ("boolean" as const) : ("string" as const),
      multiple: f.type === "array",
    };
    options[f.flag] = spec;
    if (f.parent) continue;
    if (f.flag !== f.key) options[f.key] = spec;
    const fileFlag = `${f.flag}${FILE_SUFFIX}`;
    if (f.type === "string" && !taken.has(fileFlag)) options[fileFlag] = { type: "string" };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    throw new TincanError(
      "INVALID_INPUT",
      `${(error as Error).message}. Run \`tincan ${command.name} --help\` for usage.`,
    );
  }
  const { values, positionals } = parsed;

  let input: Record<string, unknown> = {};
  if (typeof values.input === "string") {
    // `--input @file.json` reads the file; anything else is the JSON itself.
    const text = values.input.startsWith("@")
      ? await readValueFile(values.input.slice(1), cwd)
      : values.input;
    const json = parseJson("input", text);
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new TincanError("INVALID_INPUT", "--input must be a JSON object");
    input = { ...(json as Record<string, unknown>) };
  }

  if (positionals.length > command.positional.length) {
    throw new TincanError(
      "INVALID_INPUT",
      `Too many arguments for ${command.name}: ${positionals.slice(command.positional.length).join(" ")}`,
    );
  }
  const fromPositional = new Set<string>();
  for (const [i, value] of positionals.entries()) {
    const key = command.positional[i]!;
    fromPositional.add(key);
    const flag = flags.find((f) => f.key === key);
    input[key] = flag?.type === "number" ? numberValue(value) : value;
  }

  for (const f of flags) {
    if (f.parent) {
      const raw = values[f.flag];
      if (raw === undefined) continue;
      const value =
        f.type === "number"
          ? numberValue(raw as string)
          : f.type === "array"
            ? (raw as string[])
            : raw;
      const current = input[f.parent];
      const object =
        current && typeof current === "object" && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      input[f.parent] = { ...object, [f.key]: value };
      continue;
    }
    const fromFile = f.type === "string" ? values[`${f.flag}${FILE_SUFFIX}`] : undefined;
    const raw = values[f.flag] ?? values[f.key];
    if (fromFile !== undefined) {
      if (raw !== undefined || fromPositional.has(f.key)) {
        throw new TincanError(
          "INVALID_INPUT",
          `Pass --${f.flag} or --${f.flag}${FILE_SUFFIX}, not both`,
        );
      }
      input[f.key] = await readValueFile(fromFile as string, cwd);
      continue;
    }
    if (raw === undefined) continue;
    if (f.type === "boolean") input[f.key] = raw;
    else if (f.type === "array") input[f.key] = raw as string[];
    else if (f.type === "number") input[f.key] = numberValue(raw as string);
    else if (f.type === "json") input[f.key] = parseJson(f.flag, raw as string);
    else {
      const value = raw as string;
      // Nullable string fields accept "null" to clear them.
      input[f.key] = value === "null" && !f.required ? null : value;
    }
  }
  return input;
}

export function commandHelp(command: ContractDescriptor): string {
  const flags = flagsFor(command);
  const positional = command.positional.map((p) => `<${p}>`).join(" ");
  const lines = [
    `tincan ${command.name}${positional ? ` ${positional}` : ""} [options]`,
    "",
    command.description,
    "",
    "Options:",
  ];
  for (const f of flags) {
    if (command.positional.includes(f.key)) continue;
    const value =
      f.type === "boolean"
        ? ""
        : f.type === "array"
          ? " <value> (repeatable)"
          : f.type === "json"
            ? " <json>"
            : " <value>";
    const choices = f.choices ? ` [${f.choices.join("|")}]` : "";
    // A boolean that defaults to true is only useful negated.
    const name = f.type === "boolean" && f.default === true ? `[no-]${f.flag}` : f.flag;
    lines.push(`  --${name}${value}${f.required ? " (required)" : ""}${choices}`);
    if (f.description) lines.push(`      ${f.description}`);
  }
  lines.push(
    "  --input <json>",
    "      Full input as JSON (merged with other flags); --input @file.json reads it from a file",
  );
  if (flags.some((f) => f.type === "string")) {
    lines.push(
      "",
      "Text options can be read from a file with --<option>-file <path>, e.g. --text-file ./message.txt.",
      "Values are always taken literally otherwise, including ones that start with @.",
    );
  }
  return lines.join("\n");
}
