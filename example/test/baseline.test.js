import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../src/elapsed.js';

test('baseline: zero seconds', () => {
  assert.equal(formatElapsed(0), '00:00');
});

test('baseline: seconds within a minute', () => {
  assert.equal(formatElapsed(9), '00:09');
  assert.equal(formatElapsed(59), '00:59');
});

test('baseline: exact minute', () => {
  assert.equal(formatElapsed(60), '01:00');
});

test('baseline: several minutes', () => {
  assert.equal(formatElapsed(125), '02:05');
});

test('baseline: minutes may exceed 59', () => {
  assert.equal(formatElapsed(7203), '120:03');
});

test('baseline: rejects non-numeric values without coercion', () => {
  for (const value of ['3', null, undefined, {}]) {
    assert.throws(() => formatElapsed(value), TypeError);
  }
});

test('baseline: rejects non-finite values', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => formatElapsed(value), TypeError);
  }
});

test('baseline: rejects negative duration', () => {
  assert.throws(() => formatElapsed(-1), RangeError);
  assert.throws(() => formatElapsed(-0.1), RangeError);
});
