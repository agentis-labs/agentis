/**
 * Safe condition parser — replaces JS eval() entirely.
 *
 * Used for:
 *  - WorkflowEdge.condition
 *  - RouterNodeConfig.branches[].condition
 *
 * Grammar (intentionally tiny, easy to audit):
 *
 *   expr     := orExpr
 *   orExpr   := andExpr ( '||' andExpr )*
 *   andExpr  := notExpr ( '&&' notExpr )*
 *   notExpr  := '!' notExpr | cmpExpr
 *   cmpExpr  := value ( ('==' | '!=' | '<' | '<=' | '>' | '>=') value )?
 *   value    := number | string | bool | null | path
 *   path     := IDENT ('.' IDENT | '[' (number | string) ']')*
 *
 * `path` resolves against the supplied scope (typically
 * `{ scratchpad, inputs, output }`). Anything else throws.
 */

export type Scope = Record<string, unknown>;

export class SafeConditionError extends Error {}

export function evalCondition(expr: string, scope: Scope): boolean {
  // Empty / whitespace conditions are always true (n8n parity).
  if (!expr || !expr.trim()) return true;
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, scope);
  const result = parser.parseExpr();
  if (parser.notAtEnd()) {
    throw new SafeConditionError(`Unexpected token after expression: ${parser.peek()?.value ?? ''}`);
  }
  return Boolean(result);
}

// ────────────────────────────────────────────────────────────
// Tokenizer
// ────────────────────────────────────────────────────────────

interface Token {
  type:
    | 'number'
    | 'string'
    | 'bool'
    | 'null'
    | 'ident'
    | 'op'
    | 'lparen'
    | 'rparen'
    | 'lbracket'
    | 'rbracket'
    | 'dot'
    | 'not';
  value: string;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ type: c === '(' ? 'lparen' : 'rparen', value: c });
      i++;
      continue;
    }
    if (c === '[' || c === ']') {
      out.push({ type: c === '[' ? 'lbracket' : 'rbracket', value: c });
      i++;
      continue;
    }
    if (c === '.') {
      out.push({ type: 'dot', value: '.' });
      i++;
      continue;
    }
    if (c === '!' && input[i + 1] !== '=') {
      out.push({ type: 'not', value: '!' });
      i++;
      continue;
    }
    // Two-char operators
    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      out.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>') {
      out.push({ type: 'op', value: c });
      i++;
      continue;
    }
    // String literal
    if (c === '"' || c === "'") {
      const quote = c;
      let end = i + 1;
      while (end < input.length && input[end] !== quote) {
        if (input[end] === '\\') end++;
        end++;
      }
      if (input[end] !== quote) {
        throw new SafeConditionError('Unterminated string literal');
      }
      out.push({ type: 'string', value: JSON.parse(input.slice(i, end + 1).replace(/'/g, '"')) });
      i = end + 1;
      continue;
    }
    // Number
    if ((c >= '0' && c <= '9') || (c === '-' && input[i + 1] && input[i + 1]! >= '0' && input[i + 1]! <= '9')) {
      let end = i + 1;
      while (end < input.length && /[0-9.]/.test(input[end]!)) end++;
      out.push({ type: 'number', value: input.slice(i, end) });
      i = end;
      continue;
    }
    // Identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let end = i + 1;
      while (end < input.length && /[A-Za-z0-9_$]/.test(input[end]!)) end++;
      const word = input.slice(i, end);
      if (word === 'true' || word === 'false') {
        out.push({ type: 'bool', value: word });
      } else if (word === 'null') {
        out.push({ type: 'null', value: word });
      } else {
        out.push({ type: 'ident', value: word });
      }
      i = end;
      continue;
    }
    throw new SafeConditionError(`Unexpected character '${c}' at index ${i}`);
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────

class Parser {
  #i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: Scope,
  ) {}

  notAtEnd(): boolean {
    return this.#i < this.tokens.length;
  }
  peek(): Token | undefined {
    return this.tokens[this.#i];
  }
  consume(): Token {
    const t = this.tokens[this.#i];
    if (!t) throw new SafeConditionError('Unexpected end of expression');
    this.#i++;
    return t;
  }

  parseExpr(): unknown {
    return this.parseOr();
  }

  parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek()?.type === 'op' && this.peek()?.value === '||') {
      this.consume();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  parseAnd(): unknown {
    let left = this.parseNot();
    while (this.peek()?.type === 'op' && this.peek()?.value === '&&') {
      this.consume();
      const right = this.parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  parseNot(): unknown {
    if (this.peek()?.type === 'not') {
      this.consume();
      return !this.parseNot();
    }
    return this.parseCmp();
  }

  parseCmp(): unknown {
    const left = this.parseValue();
    const next = this.peek();
    if (next?.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(next.value)) {
      this.consume();
      const right = this.parseValue();
      switch (next.value) {
        case '==':
          // Loose-equal here mirrors how authors think of it for typed JSON.
          // Numbers compare as numbers; everything else compares strict.
          return looseEqual(left, right);
        case '!=':
          return !looseEqual(left, right);
        case '<':
          return (left as number) < (right as number);
        case '<=':
          return (left as number) <= (right as number);
        case '>':
          return (left as number) > (right as number);
        case '>=':
          return (left as number) >= (right as number);
      }
    }
    return left;
  }

  parseValue(): unknown {
    const t = this.peek();
    if (!t) throw new SafeConditionError('Unexpected end while parsing value');
    if (t.type === 'lparen') {
      this.consume();
      const inner = this.parseExpr();
      const close = this.consume();
      if (close.type !== 'rparen') throw new SafeConditionError("Expected ')'");
      return inner;
    }
    if (t.type === 'number') {
      this.consume();
      return Number(t.value);
    }
    if (t.type === 'string') {
      this.consume();
      return t.value;
    }
    if (t.type === 'bool') {
      this.consume();
      return t.value === 'true';
    }
    if (t.type === 'null') {
      this.consume();
      return null;
    }
    if (t.type === 'ident') {
      return this.parsePath();
    }
    throw new SafeConditionError(`Unexpected token: ${t.value}`);
  }

  parsePath(): unknown {
    const head = this.consume();
    let value: unknown = (this.scope as Record<string, unknown>)[head.value];
    while (this.peek()?.type === 'dot' || this.peek()?.type === 'lbracket') {
      const next = this.consume();
      if (next.type === 'dot') {
        const ident = this.consume();
        if (ident.type !== 'ident') throw new SafeConditionError('Expected identifier after .');
        value = (value as Record<string, unknown> | null | undefined)?.[ident.value];
      } else {
        const indexTok = this.consume();
        let key: string | number;
        if (indexTok.type === 'number') key = Number(indexTok.value);
        else if (indexTok.type === 'string') key = indexTok.value;
        else throw new SafeConditionError('Index must be string or number');
        const close = this.consume();
        if (close.type !== 'rbracket') throw new SafeConditionError("Expected ']'");
        value = (value as Record<string | number, unknown> | null | undefined)?.[key];
      }
    }
    return value;
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a == null || b == null) return a == b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return String(a) === String(b);
}
