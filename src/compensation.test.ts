import assert from 'node:assert/strict';
import test from 'node:test';
import { compensatedViewerRotation, DEFAULT_COMPENSATION } from './compensation.ts';

const width = 390;
const distance = 1950;
const radians = (angle: number) => angle * Math.PI / 180;
const close = (a: number, b: number, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

// Forward-project a rigid card from a pinhole eye; independent of renderer UVs.
function project(angle: number, observer: number[], x: number, y = 0) {
  const pivot = angle >= 0 ? -width / 2 : width / 2;
  const a = radians(angle);
  const worldX = pivot + (x - pivot) * Math.cos(a);
  const worldZ = -(x - pivot) * Math.sin(a);
  const eye = [observer[2] * distance, observer[5] * distance, observer[8] * distance];
  const t = eye[2] / (eye[2] - worldZ);
  return [width / 2 + eye[0] + (worldX - eye[0]) * t, eye[1] + (y - eye[1]) * t];
}

function projectedWidth(angle: number, observer: number[]) {
  const farX = angle >= 0 ? width / 2 : -width / 2;
  const x = project(angle, observer, farX)[0];
  return angle >= 0 ? x : width - x;
}

test('zero compensation restores fixed-eye perspective; neutral pose stays unchanged', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const strength of [0, DEFAULT_COMPENSATION, 1]) {
    compensatedViewerRotation(0, 0, strength).forEach((v, i) => close(v, identity[i]));
    close(projectedWidth(0, compensatedViewerRotation(0, 0, strength)), width);
  }
  compensatedViewerRotation(75, -30, 0).forEach((v, i) => close(v, identity[i]));
});

test('default compensation restores width gradually without the old expansion', () => {
  let previous = width;
  for (const angle of [15, 30, 45, 60, 80]) {
    const camera = compensatedViewerRotation(angle, 0);
    const result = projectedWidth(angle, camera);
    const uncompensated = projectedWidth(angle, compensatedViewerRotation(angle, 0, 0));
    const a = radians(angle);
    const oldFull = projectedWidth(angle, [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]);
    assert.ok(result > uncompensated && result < oldFull, `${angle}: default must lie between the two former modes`);
    assert.ok(result < previous && result < width, `${angle}: default must leave the free edge inside the screen`);
    close(projectedWidth(-angle, compensatedViewerRotation(-angle, 0)), result);
    previous = result;
  }
});

test('changing compensation preserves every point on the full-height hinge', () => {
  for (const angle of [-80, -45, 45, 80]) {
    for (const strength of [0, 0.5, 1]) {
      const pivot = angle >= 0 ? -width / 2 : width / 2;
      const camera = compensatedViewerRotation(angle, 18, strength);
      for (const y of [-422, -211, 0, 211, 422]) {
        const point = project(angle, camera, pivot, y);
        close(point[0], pivot + width / 2);
        close(point[1], y);
      }
    }
  }
});

test('compensation strength increases width continuously at the same image angle', () => {
  for (const angle of [20, 45, 70]) {
    let previous = 0;
    for (let i = 0; i <= 100; i += 1) {
      const result = projectedWidth(angle, compensatedViewerRotation(angle, 0, i / 100));
      assert.ok(Number.isFinite(result) && result > previous);
      previous = result;
    }
  }
});

test('high-angle compensation has a smooth shoulder and stays away from grazing', () => {
  const cameraYaw = (a: number) => {
    const m = compensatedViewerRotation(a, 0, 1);
    return Math.atan2(m[2], m[8]) * 180 / Math.PI;
  };
  const step = 0.0001;
  close(cameraYaw(45), 45);
  close((cameraYaw(45) - cameraYaw(45 - step)) / step, 1, 0.00001);
  close((cameraYaw(45 + step) - cameraYaw(45)) / step, 1, 0.00001);
  assert.ok(cameraYaw(80) > 60 && cameraYaw(80) < 65);
  close(cameraYaw(800), cameraYaw(80));
  for (const yaw of [-80, 80]) {
    for (const pitch of [-80, 80]) {
      const m = compensatedViewerRotation(yaw, pitch, 1);
      assert.ok(m[8] > 0.2, 'camera remains in front of the screen for combined turns');
      close(Math.hypot(m[2], m[5], m[8]), 1);
    }
  }
});

test('invalid input is rejected and strength is bounded', () => {
  for (const input of [NaN, Infinity, -Infinity]) {
    assert.throws(() => compensatedViewerRotation(input, 0, 0.5), TypeError);
    assert.throws(() => compensatedViewerRotation(0, input, 0.5), TypeError);
    assert.throws(() => compensatedViewerRotation(0, 0, input), TypeError);
  }
  assert.deepEqual(compensatedViewerRotation(30, 10, -2), compensatedViewerRotation(30, 10, 0));
  assert.deepEqual(compensatedViewerRotation(30, 10, 2), compensatedViewerRotation(30, 10, 1));
});
