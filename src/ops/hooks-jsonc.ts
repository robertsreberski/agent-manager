interface JsoncNodeBase {
  start: number;
  end: number;
}

export interface JsoncProperty extends JsoncNodeBase {
  key: string;
  value: JsoncNode;
}

export interface JsoncObject extends JsoncNodeBase {
  type: "object";
  closeStart: number;
  properties: JsoncProperty[];
}

export interface JsoncArray extends JsoncNodeBase {
  type: "array";
  closeStart: number;
  elements: JsoncNode[];
}

export interface JsoncScalar extends JsoncNodeBase {
  type: "scalar";
  value: unknown;
}

export type JsoncNode = JsoncObject | JsoncArray | JsoncScalar;

class Parser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsoncNode {
    this.#skipTrivia();
    const result = this.#parseValue();
    this.#skipTrivia();
    if (this.#index !== this.#text.length) this.#fail("unexpected trailing content");
    return result;
  }

  #parseValue(): JsoncNode {
    this.#skipTrivia();
    const character = this.#text[this.#index];
    if (character === "{") return this.#parseObject();
    if (character === "[") return this.#parseArray();
    if (character === '"') return this.#parseStringScalar();
    return this.#parsePrimitive();
  }

  #parseObject(): JsoncObject {
    const start = this.#index++;
    const properties: JsoncProperty[] = [];
    this.#skipTrivia();
    while (this.#text[this.#index] !== "}") {
      const propertyStart = this.#index;
      const key = this.#parseString();
      this.#skipTrivia();
      if (this.#text[this.#index++] !== ":") this.#fail("expected ':'");
      const value = this.#parseValue();
      properties.push({ key, value, start: propertyStart, end: value.end });
      this.#skipTrivia();
      if (this.#text[this.#index] === ",") {
        this.#index += 1;
        this.#skipTrivia();
        if (this.#text[this.#index] === "}") break;
      } else if (this.#text[this.#index] !== "}") {
        this.#fail("expected ',' or '}'");
      }
      if (this.#index >= this.#text.length) this.#fail("unterminated object");
    }
    const closeStart = this.#index;
    this.#index += 1;
    return { type: "object", start, end: this.#index, closeStart, properties };
  }

  #parseArray(): JsoncArray {
    const start = this.#index++;
    const elements: JsoncNode[] = [];
    this.#skipTrivia();
    while (this.#text[this.#index] !== "]") {
      elements.push(this.#parseValue());
      this.#skipTrivia();
      if (this.#text[this.#index] === ",") {
        this.#index += 1;
        this.#skipTrivia();
        if (this.#text[this.#index] === "]") break;
      } else if (this.#text[this.#index] !== "]") {
        this.#fail("expected ',' or ']'");
      }
      if (this.#index >= this.#text.length) this.#fail("unterminated array");
    }
    const closeStart = this.#index;
    this.#index += 1;
    return { type: "array", start, end: this.#index, closeStart, elements };
  }

  #parseStringScalar(): JsoncScalar {
    const start = this.#index;
    const value = this.#parseString();
    return { type: "scalar", start, end: this.#index, value };
  }

  #parseString(): string {
    const start = this.#index;
    if (this.#text[this.#index++] !== '"') this.#fail("expected string key");
    let escaped = false;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index++]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          return JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          this.#fail("invalid JSON string");
        }
      } else if (character === "\n" || character === "\r") {
        this.#fail("newline in string");
      }
    }
    this.#fail("unterminated string");
  }

  #parsePrimitive(): JsoncScalar {
    const start = this.#index;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index]!;
      if (/[,\]}\s]/.test(character) || this.#text.startsWith("//", this.#index) || this.#text.startsWith("/*", this.#index)) break;
      this.#index += 1;
    }
    if (start === this.#index) this.#fail("expected value");
    const raw = this.#text.slice(start, this.#index);
    try {
      return { type: "scalar", start, end: this.#index, value: JSON.parse(raw) };
    } catch {
      this.#fail(`invalid primitive ${raw}`);
    }
  }

  #skipTrivia(): void {
    while (this.#index < this.#text.length) {
      if (/\s/.test(this.#text[this.#index]!)) {
        this.#index += 1;
        continue;
      }
      if (this.#text.startsWith("//", this.#index)) {
        const newline = this.#text.indexOf("\n", this.#index + 2);
        this.#index = newline < 0 ? this.#text.length : newline + 1;
        continue;
      }
      if (this.#text.startsWith("/*", this.#index)) {
        const end = this.#text.indexOf("*/", this.#index + 2);
        if (end < 0) this.#fail("unterminated block comment");
        this.#index = end + 2;
        continue;
      }
      break;
    }
  }

  #fail(message: string): never {
    throw new Error(`Invalid JSONC at byte ${Buffer.byteLength(this.#text.slice(0, this.#index), "utf8")}: ${message}`);
  }
}

export function parseJsonc(text: string): JsoncNode {
  return new Parser(text).parse();
}

export function objectProperty(
  object: JsoncObject,
  key: string,
): JsoncProperty | null {
  const matches = object.properties.filter((property) => property.key === key);
  if (matches.length > 1) throw new Error(`Duplicate JSONC property ${key} is not safe to edit`);
  return matches[0] ?? null;
}

export function scalarString(node: JsoncNode): string | null {
  return node.type === "scalar" && typeof node.value === "string" ? node.value : null;
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[\t ]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function hasTrailingComma(text: string, lastEnd: number, closeStart: number): boolean {
  const between = text.slice(lastEnd, closeStart)
    .replace(/\/\/[^\n]*(?:\n|$)/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return between.includes(",");
}

function indentBlock(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, index) => index === 0 ? line : `${indent}${line}`)
    .join("\n");
}

export function insertObjectProperty(
  text: string,
  object: JsoncObject,
  key: string,
  value: unknown,
): string {
  if (objectProperty(object, key)) throw new Error(`JSONC property ${key} already exists`);
  const closeIndent = lineIndent(text, object.closeStart);
  const childIndent = `${closeIndent}  `;
  const property = `${JSON.stringify(key)}: ${indentBlock(value, childIndent)}`;
  const last = object.properties.at(-1);
  const prefix = !last
    ? `\n${childIndent}`
    : `${hasTrailingComma(text, last.end, object.closeStart) ? "" : ","}\n${childIndent}`;
  const suffix = `\n${closeIndent}`;
  return text.slice(0, object.closeStart) + prefix + property + suffix + text.slice(object.closeStart);
}

export function insertArrayElement(
  text: string,
  array: JsoncArray,
  value: unknown,
): string {
  const closeIndent = lineIndent(text, array.closeStart);
  const childIndent = `${closeIndent}  `;
  const element = indentBlock(value, childIndent);
  const last = array.elements.at(-1);
  const prefix = !last
    ? `\n${childIndent}`
    : `${hasTrailingComma(text, last.end, array.closeStart) ? "" : ","}\n${childIndent}`;
  const suffix = `\n${closeIndent}`;
  return text.slice(0, array.closeStart) + prefix + element + suffix + text.slice(array.closeStart);
}

function separatingComma(text: string, start: number, end: number): number {
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < end; index += 1) {
    const current = text[index]!;
    const next = text[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === ",") return index;
  }
  throw new Error("JSONC collection separator is missing");
}

export function removeArrayElement(
  text: string,
  array: JsoncArray,
  target: JsoncNode,
): string {
  const index = array.elements.indexOf(target);
  if (index < 0) throw new Error("JSONC array element does not belong to array");
  if (array.elements.length === 1) {
    return text.slice(0, target.start) + text.slice(target.end);
  }
  const next = array.elements[index + 1];
  if (next) {
    const comma = separatingComma(text, target.end, next.start);
    return text.slice(0, target.start)
      + text.slice(target.end, comma)
      + text.slice(comma + 1);
  }
  const previous = array.elements[index - 1]!;
  const comma = separatingComma(text, previous.end, target.start);
  return text.slice(0, comma)
    + text.slice(comma + 1, target.start)
    + text.slice(target.end);
}

export function removeObjectProperty(
  text: string,
  object: JsoncObject,
  target: JsoncProperty,
): string {
  const index = object.properties.indexOf(target);
  if (index < 0) throw new Error("JSONC property does not belong to object");
  if (object.properties.length === 1) {
    return text.slice(0, target.start) + text.slice(target.end);
  }
  const next = object.properties[index + 1];
  if (next) {
    const comma = separatingComma(text, target.end, next.start);
    return text.slice(0, target.start)
      + text.slice(target.end, comma)
      + text.slice(comma + 1);
  }
  const previous = object.properties[index - 1]!;
  const comma = separatingComma(text, previous.end, target.start);
  return text.slice(0, comma)
    + text.slice(comma + 1, target.start)
    + text.slice(target.end);
}
