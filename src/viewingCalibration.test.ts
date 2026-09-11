import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALIBRATION, parseViewingCalibration, perspectiveDistancePx, referenceShortEdge, serializeViewingCalibration } from './viewingCalibration.ts';

test('physical centimetres map to the same perspective at different rendering scales', () => {
  // A 6.5 cm screen viewed from 52 cm is eight screen widths away.
  const calibration = { distanceCm: 52, screenShortCm: 6.5 };
  assert.equal(perspectiveDistancePx(390, calibration), 3120);
  assert.equal(perspectiveDistancePx(260, calibration), 2080);
  assert.equal(perspectiveDistancePx(390, { ...calibration, distanceCm: 26 }), 1560);
});

test('phone orientation and browser toolbars do not change physical pixel scale', () => {
  assert.equal(referenceShortEdge(393, 852, 393, 852, true), 393);
  assert.equal(referenceShortEdge(393, 700, 393, 852, true), 393);
  assert.equal(referenceShortEdge(852, 300, 852, 393, true), 393);
  assert.equal(referenceShortEdge(244, 530, 1920, 1080, false), 244);
});

test('saved calibration loads independently and malformed values fall back to device defaults', () => {
  assert.deepEqual(parseViewingCalibration('{"distanceCm":42,"screenShortCm":6.8}'), { distanceCm: 42, screenShortCm: 6.8 });
  for (const raw of [null, '{broken', 'null', '[]', '{"distanceCm":"50","screenShortCm":0}']) {
    assert.deepEqual(parseViewingCalibration(raw), DEFAULT_CALIBRATION);
  }
  assert.deepEqual(parseViewingCalibration('{"distanceCm":45,"screenShortCm":999}'), { distanceCm: 45, screenShortCm: 6.51 });
  assert.deepEqual(parseViewingCalibration('{"distanceCm":50,"screenShortCm":6.8}'), { distanceCm: 40, screenShortCm: 6.8 });
  for (const distanceCm of [40, 50, 68]) {
    const calibration = { distanceCm, screenShortCm: 6.8 };
    assert.deepEqual(parseViewingCalibration(serializeViewingCalibration(calibration)), calibration);
  }
});
