/**
 * A W3C DeviceOrientation reading in degrees.
 *
 * The matrix helpers in this module use a right-handed, y-up coordinate
 * system: x points right, y points up, and z points towards the viewer. The
 * matrices are row-major 3x3 active rotations that map a vector from the
 * device-local frame into the world frame.
 */
export interface OrientationReading {
  alpha: number;
  beta: number;
  gamma: number;
}

/** The default cap used for the visual head-tracking approximation. */
export const DEFAULT_MAX_ROTATION_DEGREES = 65;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EPSILON = 1e-12;
const IDENTITY: number[] = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertMatrix(matrix: readonly number[], name = "matrix"): void {
  if (matrix.length !== 9) {
    throw new RangeError(`${name} must contain exactly 9 numbers`);
  }
  for (const value of matrix) {
    assertFinite(value, name);
  }
}

function radians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function transpose3(matrix: readonly number[]): number[] {
  return [
    matrix[0], matrix[3], matrix[6],
    matrix[1], matrix[4], matrix[7],
    matrix[2], matrix[5], matrix[8],
  ];
}

/** Return the transpose (and therefore inverse for a rotation) of a matrix. */
export function transposeRotation(matrix: readonly number[]): number[] {
  assertMatrix(matrix);
  return transpose3(matrix);
}

function rotationX(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    1, 0, 0,
    0, c, -s,
    0, s, c,
  ];
}

function rotationY(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    c, 0, s,
    0, 1, 0,
    -s, 0, c,
  ];
}

function rotationZ(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    c, -s, 0,
    s, c, 0,
    0, 0, 1,
  ];
}

/**
 * Convert W3C alpha/beta/gamma to a row-major active rotation matrix.
 *
 * W3C's alpha, beta and gamma are rotations around z, x and y respectively.
 * They are composed as `Rz(alpha) * Rx(beta) * Ry(gamma)`. `screenAngle` is
 * the current screen orientation in degrees (0 portrait, usually +/-90 for
 * landscape); changing the local screen basis is represented by the final
 * `Rz(-screenAngle)` factor. Keeping this factor on the right means the
 * returned matrix remains a device-local-to-world transform.
 *
 * Angle wrapping is naturally continuous here because sine and cosine are
 * periodic. The function has no browser dependency and accepts any finite
 * degree values, including values outside the ranges normally emitted by a
 * browser event.
 */
export function orientationMatrix(
  reading: OrientationReading,
  screenAngleDegrees = 0,
): number[] {
  assertFinite(reading.alpha, "reading.alpha");
  assertFinite(reading.beta, "reading.beta");
  assertFinite(reading.gamma, "reading.gamma");
  assertFinite(screenAngleDegrees, "screenAngleDegrees");

  const deviceRotation = multiply3(
    multiply3(
      rotationZ(radians(reading.alpha)),
      rotationX(radians(reading.beta)),
    ),
    rotationY(radians(reading.gamma)),
  );

  return multiply3(
    deviceRotation,
    rotationZ(-radians(screenAngleDegrees)),
  );
}

/**
 * Return the inverse of the current pose relative to a calibrated reference.
 *
 * For device-to-world matrices, a current screen pose can be written as
 * `current = reference * localDelta`. The reference-plane-to-current-screen
 * transform is `transpose(current) * reference`, which is the inverse local
 * delta. This order matters when the calibrated pose is not identity: using
 * `reference * transpose(current)` would express the inverse around world
 * axes instead. At calibration (`current === reference`) this is identity,
 * including when the phone starts at a non-zero beta.
 */
export function relativeInverse(
  current: readonly number[],
  reference: readonly number[],
): number[] {
  assertMatrix(current, "current");
  assertMatrix(reference, "reference");
  return multiply3(transpose3(current), reference);
}

function toCssCoordinateMatrix(matrix: readonly number[]): number[] {
  // CSS uses y-down screen coordinates. Conjugating by diag(1, -1, 1)
  // changes the basis while preserving the active rotation semantics.
  return [
    matrix[0], -matrix[1], matrix[2],
    -matrix[3], matrix[4], -matrix[5],
    matrix[6], -matrix[7], matrix[8],
  ];
}

function cssNumber(value: number): string {
  const rounded = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));
  return String(rounded);
}

/**
 * Convert a row-major y-up 3x3 rotation to a CSS `matrix3d` string.
 *
 * `matrix3d` receives its sixteen values in column-major order. The y-down
 * CSS basis conversion is applied before embedding the 3x3 matrix in a 4x4
 * homogeneous transform. Translation and perspective remain zero.
 */
export function matrixToCss3d(matrix: readonly number[]): string {
  assertMatrix(matrix);
  const css = toCssCoordinateMatrix(matrix);
  const values = [
    css[0], css[3], css[6], 0,
    css[1], css[4], css[7], 0,
    css[2], css[5], css[8], 0,
    0, 0, 0, 1,
  ];
  return `matrix3d(${values.map(cssNumber).join(", ")})`;
}

/**
 * Return the angle between the transformed local +z normal and world +z.
 * This is the visual tilt/off-axis angle in degrees, independent of any
 * rotation around the normal itself.
 */
export function tiltDegrees(matrix: readonly number[]): number {
  assertMatrix(matrix);
  const normalX = matrix[2];
  const normalY = matrix[5];
  const normalZ = matrix[8];
  return Math.atan2(
    Math.hypot(normalX, normalY),
    normalZ,
  ) * RAD_TO_DEG;
}

/**
 * Decompose a screen normal into the yaw and pitch needed by the observer
 * model. Roll is intentionally discarded because it rotates the screen
 * around its own normal and does not change where the screen faces.
 *
 * The returned angles reconstruct the direction of `rotation * +z` through
 * `axisRotation(pitch, yaw)`, while keeping yaw deterministic at the poles.
 */
export function viewerAngles(
  rotation: readonly number[],
): { yaw: number; pitch: number } {
  assertMatrix(rotation);

  let normalX = rotation[2];
  let normalY = rotation[5];
  let normalZ = rotation[8];
  const normalLength = Math.hypot(normalX, normalY, normalZ);
  if (normalLength < EPSILON) {
    return { yaw: 0, pitch: 0 };
  }

  normalX /= normalLength;
  normalY /= normalLength;
  normalZ /= normalLength;
  const horizontalLength = Math.hypot(normalX, normalZ);
  const yaw = horizontalLength < EPSILON
    ? 0
    : Math.atan2(normalX, normalZ) * RAD_TO_DEG;
  const pitch = Math.atan2(-normalY, horizontalLength) * RAD_TO_DEG;

  return {
    yaw: Number.isFinite(yaw) ? yaw : 0,
    pitch: Number.isFinite(pitch) ? pitch : 0,
  };
}

/**
 * Isolate the phone's horizontal heading in the calibrated screen frame,
 * then reverse that scalar angle for the UI. Decomposing the inverse normal
 * instead would let local pitch change the apparent yaw during a side turn.
 * Local pitch and roll are discarded before either plane or camera is built.
 */
export function horizontalCorrectionDegrees(correction: readonly number[]): number {
  assertMatrix(correction, "correction");
  const yaw = viewerAngles(transpose3(correction)).yaw;
  return yaw === 0 ? 0 : -yaw;
}

/**
 * Build a manual test rotation. Positive pitch rotates around x and positive
 * yaw around y. Yaw is applied in world coordinates after pitch:
 * `Ry(yaw) * Rx(pitch)`.
 */
export function axisRotation(pitchDegrees: number, yawDegrees: number): number[] {
  assertFinite(pitchDegrees, "pitchDegrees");
  assertFinite(yawDegrees, "yawDegrees");
  return multiply3(
    rotationY(radians(yawDegrees)),
    rotationX(radians(pitchDegrees)),
  );
}

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

function normaliseQuaternion(quaternion: Quaternion): Quaternion {
  const length = Math.hypot(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w,
  );
  if (length < EPSILON) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length,
  };
}

function quaternionFromMatrix(matrix: readonly number[]): Quaternion {
  const trace = matrix[0] + matrix[4] + matrix[8];
  let quaternion: Quaternion;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    quaternion = {
      w: 0.25 * s,
      x: (matrix[7] - matrix[5]) / s,
      y: (matrix[2] - matrix[6]) / s,
      z: (matrix[3] - matrix[1]) / s,
    };
  } else if (matrix[0] > matrix[4] && matrix[0] > matrix[8]) {
    const s = Math.sqrt(Math.max(0, 1 + matrix[0] - matrix[4] - matrix[8])) * 2;
    quaternion = {
      w: (matrix[7] - matrix[5]) / s,
      x: 0.25 * s,
      y: (matrix[1] + matrix[3]) / s,
      z: (matrix[2] + matrix[6]) / s,
    };
  } else if (matrix[4] > matrix[8]) {
    const s = Math.sqrt(Math.max(0, 1 - matrix[0] + matrix[4] - matrix[8])) * 2;
    quaternion = {
      w: (matrix[2] - matrix[6]) / s,
      x: (matrix[1] + matrix[3]) / s,
      y: 0.25 * s,
      z: (matrix[5] + matrix[7]) / s,
    };
  } else {
    const s = Math.sqrt(Math.max(0, 1 - matrix[0] - matrix[4] + matrix[8])) * 2;
    quaternion = {
      w: (matrix[3] - matrix[1]) / s,
      x: (matrix[2] + matrix[6]) / s,
      y: (matrix[5] + matrix[7]) / s,
      z: 0.25 * s,
    };
  }

  quaternion = normaliseQuaternion(quaternion);
  // q and -q represent the same rotation. Keeping w >= 0 makes the axis
  // angle path choose the shortest representation around the identity.
  if (quaternion.w < 0) {
    return {
      x: -quaternion.x,
      y: -quaternion.y,
      z: -quaternion.z,
      w: -quaternion.w,
    };
  }
  return quaternion;
}

function wrapSignedDegrees(degrees: number): number {
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  // The public interval is (-180, 180], so choose +180 at the seam.
  if (wrapped <= -180 + 1e-10) return 180;
  return Math.abs(wrapped) < 1e-10 ? 0 : wrapped;
}

/**
 * Extract the signed twist around the local +Y axis in degrees.
 *
 * `rotation` is a row-major active rotation in the module's x-right, y-up,
 * z-towards-viewer convention. A quaternion's vector part projected onto Y,
 * together with its scalar part, is the Y swing-twist component; the other
 * two vector components belong to swing and are ignored. This makes pure X
 * pitch and pure Z roll return zero while preserving a Y twist when combined
 * with a swing. The result is in (-180, 180]; a degenerate twist projection
 * (for example an exact 180-degree swing) returns zero rather than NaN.
 */
export function signedYawDegrees(rotation: readonly number[]): number {
  assertMatrix(rotation, "rotation");
  const quaternion = quaternionFromMatrix(rotation);
  if (![quaternion.x, quaternion.y, quaternion.z, quaternion.w].every(Number.isFinite)) {
    return 0;
  }

  const twistLength = Math.hypot(quaternion.y, quaternion.w);
  if (twistLength < EPSILON) {
    return 0;
  }

  const twistAngle = 2 * Math.atan2(quaternion.y, quaternion.w) * RAD_TO_DEG;
  return Number.isFinite(twistAngle) ? wrapSignedDegrees(twistAngle) : 0;
}

function matrixFromQuaternion(quaternion: Quaternion): number[] {
  const q = normaliseQuaternion(quaternion);
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const yz = q.y * q.z;
  const wx = q.w * q.x;
  const wy = q.w * q.y;
  const wz = q.w * q.z;

  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/**
 * Spherical-linear interpolation between two rotation matrices.
 *
 * `amount` is normally in [0, 1], but is allowed outside that interval for
 * controlled extrapolation. Quaternion signs are aligned before interpolation
 * so the shortest path is used; the result remains an orthonormal rotation.
 */
export function interpolateRotation(
  from: readonly number[],
  to: readonly number[],
  amount: number,
): number[] {
  assertMatrix(from, "from");
  assertMatrix(to, "to");
  assertFinite(amount, "amount");

  if (amount === 0) {
    return [...from];
  }
  if (amount === 1) {
    return [...to];
  }

  const start = quaternionFromMatrix(from);
  let end = quaternionFromMatrix(to);
  let dot = start.x * end.x + start.y * end.y + start.z * end.z + start.w * end.w;

  if (dot < 0) {
    end = { x: -end.x, y: -end.y, z: -end.z, w: -end.w };
    dot = -dot;
  }

  dot = clamp(dot, -1, 1);
  let interpolated: Quaternion;
  if (dot > 0.9995) {
    interpolated = normaliseQuaternion({
      x: start.x + amount * (end.x - start.x),
      y: start.y + amount * (end.y - start.y),
      z: start.z + amount * (end.z - start.z),
      w: start.w + amount * (end.w - start.w),
    });
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const startWeight = Math.sin((1 - amount) * theta) / sinTheta;
    const endWeight = Math.sin(amount * theta) / sinTheta;
    interpolated = normaliseQuaternion({
      x: startWeight * start.x + endWeight * end.x,
      y: startWeight * start.y + endWeight * end.y,
      z: startWeight * start.z + endWeight * end.z,
      w: startWeight * start.w + endWeight * end.w,
    });
  }

  return matrixFromQuaternion(interpolated);
}

/**
 * Scale a rotation by gain and cap its axis-angle magnitude.
 *
 * The operation converts to a unit quaternion, scales the quaternion's
 * shortest axis-angle representation, and reconstructs a matrix. It therefore
 * preserves orthogonality. The default cap of 65 degrees is intentionally a
 * head-tracking approximation rather than a claim that the phone's absolute
 * pose can be recovered from DeviceOrientation alone.
 */
export function scaleRotation(
  matrix: readonly number[],
  gain: number,
  maxDegrees = DEFAULT_MAX_ROTATION_DEGREES,
): number[] {
  assertMatrix(matrix);
  assertFinite(gain, "gain");
  assertFinite(maxDegrees, "maxDegrees");
  if (maxDegrees < 0) {
    throw new RangeError("maxDegrees must be non-negative");
  }

  const quaternion = quaternionFromMatrix(matrix);
  const vectorLength = Math.hypot(quaternion.x, quaternion.y, quaternion.z);
  if (vectorLength < EPSILON || gain === 0 || maxDegrees === 0) {
    return [...IDENTITY];
  }

  const sourceAngle = 2 * Math.atan2(vectorLength, quaternion.w);
  const requestedAngle = sourceAngle * gain;
  const limit = radians(maxDegrees);
  const targetAngle = clamp(requestedAngle, -limit, limit);
  const halfTarget = targetAngle / 2;
  const scale = Math.sin(halfTarget) / vectorLength;

  return matrixFromQuaternion({
    x: quaternion.x * scale,
    y: quaternion.y * scale,
    z: quaternion.z * scale,
    w: Math.cos(halfTarget),
  });
}
