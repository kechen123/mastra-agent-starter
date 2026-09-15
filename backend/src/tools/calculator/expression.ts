const MAX_EXPRESSION_LENGTH = 200;
const MAX_NESTING_DEPTH = 32;

/** 只解析四则运算语法，不执行输入中的 JavaScript。 */
export function evaluateArithmeticExpression(input: string): number {
  const expression = input.replace(/\s/g, '');
  if (expression.length === 0 || expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error('INVALID_LENGTH');
  }
  if (!/^[\d+\-*/().]+$/.test(expression)) {
    throw new Error('INVALID_CHARACTER');
  }

  let position = 0;

  function parseExpression(depth: number): number {
    let value = parseTerm(depth);
    while (expression[position] === '+' || expression[position] === '-') {
      const operator = expression[position++];
      const right = parseTerm(depth);
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  function parseTerm(depth: number): number {
    let value = parseUnary(depth);
    while (expression[position] === '*' || expression[position] === '/') {
      const operator = expression[position++];
      const right = parseUnary(depth);
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }

  function parseUnary(depth: number): number {
    if (expression[position] === '+' || expression[position] === '-') {
      const operator = expression[position++];
      const value = parseUnary(depth);
      return operator === '-' ? -value : value;
    }
    return parsePrimary(depth);
  }

  function parsePrimary(depth: number): number {
    if (expression[position] === '(') {
      if (depth >= MAX_NESTING_DEPTH) throw new Error('TOO_DEEP');
      position += 1;
      const value = parseExpression(depth + 1);
      if (expression[position] !== ')') throw new Error('MISSING_PARENTHESIS');
      position += 1;
      return value;
    }

    const start = position;
    let dotCount = 0;
    while (position < expression.length) {
      const character = expression[position]!;
      if (character === '.') {
        dotCount += 1;
        if (dotCount > 1) throw new Error('INVALID_NUMBER');
        position += 1;
        continue;
      }
      if (!/\d/.test(character)) break;
      position += 1;
    }
    const token = expression.slice(start, position);
    if (token.length === 0 || token === '.') throw new Error('EXPECTED_NUMBER');
    return Number(token);
  }

  const result = parseExpression(0);
  if (position !== expression.length) throw new Error('UNEXPECTED_TOKEN');
  if (!Number.isFinite(result)) throw new Error('NON_FINITE_RESULT');
  return result;
}
