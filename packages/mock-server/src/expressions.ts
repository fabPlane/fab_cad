/**
 * A tiny evaluator for FreeCAD-style expressions, enough for the mock: numbers with optional
 * units (`10 mm`, `2in`, `45 deg`), `+ - * / ^`, parentheses, `pi`, and references to properties —
 * `Length` (same object), `Box.Length` (another object by internal name) or `<<My box>>.Length`
 * (by label). Quantities evaluate to their value in base units (mm, degrees).
 */
import { parseQuantity } from "@fab-cad/protocol";

export interface ExprRef {
  /** Internal name or `<<label>>`; `undefined` for the owning object. */
  object?: string;
  property: string;
}

type Token = { t: "num"; v: number } | { t: "ref"; ref: ExprRef } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*(?:µm|um|nm|mm|cm|dm|km|m(?![a-zA-Z_])|in(?![a-zA-Z_])|ft|deg|rad|°)?/.exec(
      src.slice(i),
    );
    if (num) {
      out.push({ t: "num", v: parseQuantity(num[0]).value });
      i += num[0].length;
      continue;
    }
    const ref = /^(?:(<<[^>]+>>|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
    if (ref) {
      if (!ref[1] && ref[2] === "pi") out.push({ t: "num", v: Math.PI });
      else out.push({ t: "ref", ref: ref[1] ? { object: ref[1], property: ref[2]! } : { property: ref[2]! } });
      i += ref[0].length;
      continue;
    }
    throw new Error(`unexpected '${c}' in expression`);
  }
  return out;
}

/** Parse once; returns the references and an evaluator. Throws on syntax errors. */
export function compileExpression(src: string): { refs: ExprRef[]; evaluate: (lookup: (ref: ExprRef) => number) => number } {
  const tokens = tokenize(src);
  const refs = tokens.filter((t): t is { t: "ref"; ref: ExprRef } => t.t === "ref").map((t) => t.ref);
  // Validate the syntax now with a dummy lookup.
  const run = (lookup: (ref: ExprRef) => number): number => {
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = (v: string) => {
      const t = peek();
      return t?.t === "op" && t.v === v;
    };
    const expr = (): number => {
      let v = term();
      while (isOp("+") || isOp("-")) {
        const op = (tokens[pos++] as { v: string }).v;
        const r = term();
        v = op === "+" ? v + r : v - r;
      }
      return v;
    };
    const term = (): number => {
      let v = power();
      while (isOp("*") || isOp("/")) {
        const op = (tokens[pos++] as { v: string }).v;
        const r = power();
        v = op === "*" ? v * r : v / r;
      }
      return v;
    };
    const power = (): number => {
      const base = unary();
      if (isOp("^")) {
        pos++;
        return base ** power();
      }
      return base;
    };
    const unary = (): number => {
      if (isOp("-")) return (pos++, -unary());
      if (isOp("+")) return (pos++, unary());
      return atom();
    };
    const atom = (): number => {
      const t = tokens[pos++];
      if (!t) throw new Error("unexpected end of expression");
      if (t.t === "num") return t.v;
      if (t.t === "ref") return lookup(t.ref);
      if (t.v === "(") {
        const v = expr();
        if (!isOp(")")) throw new Error("missing ')'");
        pos++;
        return v;
      }
      throw new Error(`unexpected '${t.v}'`);
    };
    const v = expr();
    if (pos !== tokens.length) throw new Error("trailing tokens in expression");
    return v;
  };
  run(() => 1);
  return { refs, evaluate: run };
}
