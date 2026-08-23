import test from 'node:test';
import assert from 'node:assert/strict';
import { createLodRatios } from './sog-build-lib.mjs';

test('default five levels use equal ceil steps', () => {
  assert.deepEqual(createLodRatios(), [100, 80, 60, 40, 20]);
});

test('ten levels produce 100 through 10 percent', () => {
  assert.deepEqual(createLodRatios(10), [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
});

test('non-divisible levels always round upward', () => {
  assert.deepEqual(createLodRatios(6), [100, 84, 67, 50, 34, 17]);
});

test('invalid level counts are rejected', () => {
  assert.throws(() => createLodRatios(0), RangeError);
  assert.throws(() => createLodRatios(2.5), RangeError);
  assert.throws(() => createLodRatios(21), RangeError);
});
