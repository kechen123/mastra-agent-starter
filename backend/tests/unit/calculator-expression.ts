import assert from 'node:assert/strict';
import { evaluateArithmeticExpression } from '../../src/tools/calculator/expression.js';

assert.equal(evaluateArithmeticExpression('2 + 3 * 4'), 14);
assert.equal(evaluateArithmeticExpression('(2 + 3) * -4'), -20);
assert.equal(evaluateArithmeticExpression('.5 + 1.5'), 2);
assert.equal(evaluateArithmeticExpression('--2'), 2);

for (const invalid of [
  '',
  '2(3)',
  '1..2',
  '1 / 0',
  '1 + Math.random()',
  `${'('.repeat(33)}1${')'.repeat(33)}`,
  '1'.repeat(201),
]) {
  assert.throws(() => evaluateArithmeticExpression(invalid), undefined, invalid);
}

console.log('calculator-expression: 通过');
