import assert from "node:assert/strict";
import test from "node:test";

import {
  axisRotation,
  horizontalCorrectionDegrees,
  interpolateRotation,
  matrixToCss3d,
  orientationMatrix,
  relativeInverse,
  scaleRotation,
  signedYawDegrees,
  transposeRotation,
  tiltDegrees,
  viewerAngles,
} from "./orientation.ts";

const EPSILON = 1e-9;

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function assertMatrixClose(
  actual: readonly number[],
  expected: readonly number[],
  tolerance = EPSILON,
): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assertClose(actual[index], expected[index], tolerance);
  }
}

function multiply3(a: readonly number[], b: readonly number[]): number[] {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

function rotationZ(degrees: number): number[] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function rotationAngle(matrix: readonly number[]): number {
  return Math.acos(Math.max(-1, Math.min(1, (matrix[0] + matrix[4] + matrix[8] - 1) / 2))) * 180 / Math.PI;
}

function transformVector(matrix: readonly number[], vector: readonly number[]): number[] {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ];
}

test("zero W3C reading is the identity matrix", () => {
  assertMatrixClose(orientationMatrix({ alpha: 0, beta: 0, gamma: 0 }, 0), [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
});

test("relative inverse reverses a known single-axis pitch", () => {
  const reference = orientationMatrix({ alpha: 0, beta: 0, gamma: 0 }, 0);
  const current = orientationMatrix({ alpha: 0, beta: 30, gamma: 0 }, 0);
  const inverse = relativeInverse(current, reference);

  assertClose(inverse[5], Math.sin(Math.PI / 6));
  assertClose(inverse[7], -Math.sin(Math.PI / 6));
  assertClose(tiltDegrees(inverse), 30);
});

test("calibrating at beta=70 removes the absolute starting tilt", () => {
  const reference = orientationMatrix({ alpha: 0, beta: 70, gamma: 0 }, 0);
  const samePose = orientationMatrix({ alpha: 0, beta: 70, gamma: 0 }, 0);
  assertMatrixClose(relativeInverse(samePose, reference), [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], 1e-8);

  const current = orientationMatrix({ alpha: 0, beta: 80, gamma: 0 }, 0);
  assertClose(tiltDegrees(relativeInverse(current, reference)), 10, 1e-8);
});

test("relative inverse stays in the local screen frame for a non-commuting calibration", () => {
  const reference = orientationMatrix({ alpha: 30, beta: 70, gamma: 0 }, 0);
  const localDelta = axisRotation(12, -18);
  const current = multiply3(reference, localDelta);
  const expected = transposeRotation(localDelta);

  assertMatrixClose(relativeInverse(current, reference), expected, 1e-9);
});

test("alpha crossing +/-180 stays a two-degree relative rotation", () => {
  const reference = orientationMatrix({ alpha: 179, beta: 0, gamma: 0 }, 0);
  const current = orientationMatrix({ alpha: -179, beta: 0, gamma: 0 }, 0);
  const inverse = relativeInverse(current, reference);

  assert.ok(rotationAngle(inverse) < 3);
  assertClose(inverse[0], Math.cos(2 * Math.PI / 180));
});

test("screen rotation changes only the local screen basis", () => {
  const reading = { alpha: 27, beta: 31, gamma: -14 };
  const portrait = orientationMatrix(reading, 0);
  const landscape = orientationMatrix(reading, 90);
  assertMatrixClose(landscape, multiply3(portrait, rotationZ(-90)), 1e-9);
});

test("CSS conversion flips y basis and uses column-major matrix3d order", () => {
  const css = matrixToCss3d(rotationZ(90));
  assert.equal(
    css,
    "matrix3d(0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)",
  );
});

test("axis rotation and tilt use the documented positive axes", () => {
  const pitch = axisRotation(30, 0);
  const yaw = axisRotation(0, 30);
  assertClose(tiltDegrees(pitch), 30);
  assertClose(tiltDegrees(yaw), 30);
  assertClose(pitch[5], -Math.sin(Math.PI / 6));
  assertClose(yaw[2], Math.sin(Math.PI / 6));
});

test("viewerAngles extracts normal yaw and pitch while ignoring roll", () => {
  const purePitch = viewerAngles(axisRotation(32, 0));
  assertClose(purePitch.yaw, 0);
  assertClose(purePitch.pitch, 32);

  const pureYaw = viewerAngles(axisRotation(0, -37));
  assertClose(pureYaw.yaw, -37);
  assertClose(pureYaw.pitch, 0);

  const pureRoll = viewerAngles(rotationZ(46));
  assertClose(pureRoll.yaw, 0);
  assertClose(pureRoll.pitch, 0);

  const pole = viewerAngles(axisRotation(90, 47));
  assertClose(pole.yaw, 0);
  assertClose(pole.pitch, 90);

  const degenerate = viewerAngles([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertClose(degenerate.yaw, 0);
  assertClose(degenerate.pitch, 0);
});

test("viewerAngles reconstructs the screen normal for mixed rotations", () => {
  const rotations = [
    multiply3(rotationZ(23), axisRotation(-31, 47)),
    multiply3(axisRotation(18, -39), rotationZ(-26)),
    multiply3(rotationZ(-17), multiply3(axisRotation(42, 13), rotationZ(9))),
  ];

  for (const rotation of rotations) {
    const angles = viewerAngles(rotation);
    const expected = transformVector(rotation, [0, 0, 1]);
    const reconstructed = transformVector(axisRotation(angles.pitch, angles.yaw), [0, 0, 1]);
    for (let index = 0; index < 3; index += 1) {
      assertClose(reconstructed[index], expected[index], 1e-8);
    }
  }
});

test("viewerAngles remains local after non-zero calibration", () => {
  const references = [
    orientationMatrix({ alpha: 30, beta: 70, gamma: -14 }, 0),
    orientationMatrix({ alpha: -123, beta: 58, gamma: 21 }, 90),
    orientationMatrix({ alpha: 211, beta: -67, gamma: 32 }, -90),
  ];
  const localDeltas = [
    multiply3(rotationZ(23), axisRotation(-31, 47)),
    multiply3(axisRotation(18, -39), rotationZ(-26)),
    multiply3(rotationZ(-17), multiply3(axisRotation(42, 13), rotationZ(9))),
  ];

  for (let index = 0; index < references.length; index += 1) {
    const current = multiply3(references[index], localDeltas[index]);
    const correction = relativeInverse(current, references[index]);
    const angles = viewerAngles(correction);
    const expected = transformVector(correction, [0, 0, 1]);
    const reconstructed = transformVector(axisRotation(angles.pitch, angles.yaw), [0, 0, 1]);
    for (let component = 0; component < 3; component += 1) {
      assertClose(reconstructed[component], expected[component], 1e-8);
    }
  }
});

test("horizontal correction ignores pitch and roll while retaining the same side turn", () => {
  for (const yaw of [-70, -35, 0, 35, 70]) {
    for (const pitch of [-70, -30, 0, 30, 70]) {
      for (const roll of [-35, 0, 35]) {
        const physical = multiply3(axisRotation(pitch, yaw), rotationZ(roll));
        assertClose(horizontalCorrectionDegrees(transposeRotation(physical)), -yaw);
      }
    }
  }
});

test("horizontal correction remains independent of local pitch after arbitrary calibration", () => {
  for (const screenAngle of [-90, 0, 90]) {
    const reference = orientationMatrix({ alpha: 123, beta: 68, gamma: 17 }, screenAngle);
    assertClose(horizontalCorrectionDegrees(relativeInverse(reference, reference)), 0);
    for (const yaw of [-45, 0, 45]) {
      for (const pitch of [-60, 0, 60]) {
        const current = multiply3(reference, axisRotation(pitch, yaw));
        assertClose(horizontalCorrectionDegrees(relativeInverse(current, reference)), -yaw);
      }
    }
  }
});

test("portrait sensor beta changes do not alter a held horizontal turn", () => {
  const reference = orientationMatrix({ alpha: 0, beta: 90, gamma: 0 });
  for (const alpha of [-55, -35, 0, 35, 55]) {
    for (const beta of [35, 55, 70, 90, 110, 125, 145]) {
      const current = orientationMatrix({ alpha, beta, gamma: 0 });
      assertClose(horizontalCorrectionDegrees(relativeInverse(current, reference)), -alpha);
    }
  }
});

test("signedYawDegrees extracts positive and negative pure Y twist", () => {
  assertClose(signedYawDegrees(axisRotation(0, 30)), 30);
  assertClose(signedYawDegrees(axisRotation(0, -30)), -30);
});

test("signedYawDegrees ignores pure pitch and roll", () => {
  assertClose(signedYawDegrees(axisRotation(70, 0)), 0);
  assertClose(signedYawDegrees(rotationZ(45)), 0);
});

test("signedYawDegrees keeps known twist when swing is present", () => {
  const swing = axisRotation(55, 0);
  const twist = axisRotation(0, 35);
  const combined = multiply3(swing, twist);
  assertClose(signedYawDegrees(combined), 35, 1e-8);
});

test("signedYawDegrees returns zero for calibrated relative identity and degenerate swing", () => {
  const reference = orientationMatrix({ alpha: 30, beta: 70, gamma: 0 }, 0);
  const relative = relativeInverse(reference, reference);
  assertClose(signedYawDegrees(relative), 0);
  assertClose(signedYawDegrees([0, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
});

test("scaleRotation scales and caps axis-angle rotation while preserving orthogonality", () => {
  const scaled = scaleRotation(axisRotation(30, 0), 2, 65);
  assertClose(tiltDegrees(scaled), 60, 1e-8);

  const capped = scaleRotation(axisRotation(40, 0), 3, 65);
  assertClose(tiltDegrees(capped), 65, 1e-8);

  const dotRow0Row1 = capped[0] * capped[3] + capped[1] * capped[4] + capped[2] * capped[5];
  const row0Length = Math.hypot(capped[0], capped[1], capped[2]);
  assertClose(dotRow0Row1, 0, 1e-8);
  assertClose(row0Length, 1, 1e-8);
});

test("scaleRotation with zero gain returns identity", () => {
  assertMatrixClose(scaleRotation(axisRotation(20, 15), 0), [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], 1e-8);
});

test("transposeRotation is the inverse for an orthonormal rotation", () => {
  const rotation = axisRotation(23, -17);
  const inverse = transposeRotation(rotation);
  assertMatrixClose(relativeInverse(rotation, [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]), inverse, 1e-10);
});

test("interpolateRotation follows the shortest spherical path", () => {
  const from = axisRotation(0, 0);
  const to = axisRotation(90, 0);
  const halfway = interpolateRotation(from, to, 0.5);
  assertClose(tiltDegrees(halfway), 45, 1e-8);

  const dotRow0Row1 = halfway[0] * halfway[3] + halfway[1] * halfway[4] + halfway[2] * halfway[5];
  assertClose(dotRow0Row1, 0, 1e-8);
});
