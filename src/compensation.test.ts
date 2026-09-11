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
  for (const strength of [0, 0.5, DEFAULT_COMPENSATION]) {
    compensatedViewerRotation(0, 0, strength).forEach((v, i) => close(v, identity[i]));
    close(projectedWidth(0, compensatedViewerRotation(0, 0, strength)), width);
  }
  compensatedViewerRotation(75, -30, 0).forEach((v, i) => close(v, identity[i]));
});

test('half compensation restores width gradually without the old expansion', () => {
  let previous = width;
  for (const angle of [15, 30, 45, 60, 80]) {
    const camera = compensatedViewerRotation(angle, 0, 0.5);
    const result = projectedWidth(angle, camera);
    const uncompensated = projectedWidth(angle, compensatedViewerRotation(angle, 0, 0));
    const a = radians(angle);
    const oldFull = projectedWidth(angle, [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]);
    assert.ok(result > uncompensated && result < oldFull, `${angle}: half compensation must lie between the two former modes`);
    assert.ok(result < previous && result < width, `${angle}: half compensation must leave the free edge inside the screen`);
    close(projectedWidth(-angle, compensatedViewerRotation(-angle, 0, 0.5)), result);
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

test('high-angle compensation remains linear through the bounded 80 degree range', () => {
  const cameraYaw = (a: number) => {
    const m = compensatedViewerRotation(a, 0, 1);
    return Math.atan2(m[2], m[8]) * 180 / Math.PI;
  };
  const step = 0.0001;
  close(cameraYaw(45), 45);
  close((cameraYaw(45) - cameraYaw(45 - step)) / step, 1, 0.00001);
  close((cameraYaw(45 + step) - cameraYaw(45)) / step, 1, 0.00001);
  close(cameraYaw(80), 80);
  close(cameraYaw(-80), -80);
  close(cameraYaw(800), cameraYaw(80));
  for (const yaw of [-80, 80]) {
    for (const pitch of [-80, 80]) {
      const m = compensatedViewerRotation(yaw, pitch, 1);
      assert.ok(m[8] > 0, 'camera remains in front of the screen for combined turns');
      close(Math.hypot(m[2], m[5], m[8]), 1);
    }
  }
});

test('compensation strength scales yaw and pitch linearly up to the 80 degree cap', () => {
  const readAngles = (matrix: readonly number[]) => ({
    yaw: Math.atan2(matrix[2], matrix[8]) * 180 / Math.PI,
    pitch: Math.atan2(-matrix[5], Math.hypot(matrix[2], matrix[8])) * 180 / Math.PI,
  });
  for (const [yaw, pitch] of [[15, -20], [-45, 35], [80, -80], [120, -120]]) {
    for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
      const actual = readAngles(compensatedViewerRotation(yaw, pitch, strength));
      close(actual.yaw, Math.sign(yaw) * Math.min(80, Math.abs(yaw)) * strength);
      close(actual.pitch, Math.sign(pitch) * Math.min(80, Math.abs(pitch)) * strength);
    }
  }
});

type Vec3 = [number, number, number];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function transform(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2],
  ];
}

function transpose(matrix: readonly number[]): number[] {
  return [
    matrix[0], matrix[3], matrix[6],
    matrix[1], matrix[4], matrix[7],
    matrix[2], matrix[5], matrix[8],
  ];
}

/**
 * Project a point on the rigid, rotated image onto the neutral phone screen.
 * This is intentionally independent from src/projection.ts and the renderer.
 */
function projectToScreen(point: Vec3, eye: Vec3): Vec3 {
  const rayToScreen = -eye[2] / (point[2] - eye[2]);
  return add(eye, [
    rayToScreen * (point[0] - eye[0]),
    rayToScreen * (point[1] - eye[1]),
    rayToScreen * (point[2] - eye[2]),
  ]);
}

/** Apply the phone's forward R^-1 and then project to a static frontal eye. */
function recoverAtStaticEye(screenPoint: Vec3, rotation: readonly number[], distance: number): Vec3 {
  const stationaryWorldPoint = transform(transpose(rotation), screenPoint);
  const frontalScale = distance / (distance - stationaryWorldPoint[2]);
  return [
    stationaryWorldPoint[0] * frontalScale,
    stationaryWorldPoint[1] * frontalScale,
    0,
  ];
}

test('rigid image round trip preserves a square through both hinges and viewing distances', () => {
  const width = 390;
  const squareHalf = 20;
  const angles = [-80, -75, -60, -45, -30, -15, 15, 30, 45, 60, 75, 80];
  // Keep both a normal desktop distance and a closer eye in the independent
  // model. The square is centered so every requested angle stays in front of
  // both eyes, including the 80 degree boundary.
  for (const distance of [780, 1950]) {
    for (const angle of angles) {
      // The physical phone and rigid plane use the measured angle, independent
      // of the production observer. A compressed observer must fail this test.
      const a = radians(angle);
      const rotation = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
      const eye = transform(compensatedViewerRotation(angle, 0, 1), [0, 0, distance]);
      const pivot: Vec3 = [angle >= 0 ? -width / 2 : width / 2, 0, 0];
      const corners: Vec3[] = [];
      for (const x of [-squareHalf, squareHalf]) {
        for (const y of [-squareHalf, squareHalf]) {
          const source: Vec3 = [x, y, 0];
          const rigidPoint = add(pivot, transform(rotation, subtract(source, pivot)));
          const screenPoint = projectToScreen(rigidPoint, eye);
          const recovered = recoverAtStaticEye(screenPoint, rotation, distance);
          assert.ok(recovered.every(Number.isFinite),
            `${angle} degrees/${distance}px produced a non-finite corner`);
          corners.push(recovered);
        }
      }

      const minX = Math.min(...corners.map(point => point[0]));
      const maxX = Math.max(...corners.map(point => point[0]));
      const minY = Math.min(...corners.map(point => point[1]));
      const maxY = Math.max(...corners.map(point => point[1]));
      close(maxX - minX, maxY - minY, 1e-7);
      close(maxX - minX, squareHalf * 2 * distance / (distance + width / 2 * Math.abs(Math.sin(a))), 1e-7);
      close(corners[0][0], corners[1][0], 1e-7);
      close(corners[2][0], corners[3][0], 1e-7);
      close(corners[0][1], corners[2][1], 1e-7);
      close(corners[1][1], corners[3][1], 1e-7);
      assert.ok(maxX > minX && maxY > minY,
        `${angle} degrees/${distance}px collapsed the recovered square`);
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
