import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../src/elapsed.js';

test('rounding: below half a second stays at zero', () => {
  assert.equal(formatElapsed(0.49), '00:00');
});

test('rounding: an exact half rounds upward', () => {
  assert.equal(formatElapsed(0.5), '00:01');
});

test('rounding: ordinary fractional duration rounds to nearest second', () => {
  assert.equal(formatElapsed(12.6), '00:13');
});

test('rounding: a fraction below half rounds downward', () => {
  assert.equal(formatElapsed(3.49), '00:03');
});

test('rounding: carry across the first minute produces 01:00', () => {
  assert.equal(formatElapsed(59.6), '01:00', '59.6 seconds must carry into the next minute');
});

test('rounding: carry across a later minute produces 02:00', () => {
  assert.equal(formatElapsed(119.5), '02:00', '119.5 seconds must carry into the next minute');
});

test('rounding: duration continues in minutes rather than wrapping hours', () => {
  assert.equal(formatElapsed(3599.6), '60:00', 'elapsed minutes must not wrap at one hour');
});
