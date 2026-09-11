import { axisRotation } from './orientation.ts';

/** A visual tuning default, independent of the image's rotation gain. */
export const DEFAULT_COMPENSATION = 1;

function compensatedAngle(degrees: number, strength: number): number {
  const scaled = Math.min(80, Math.abs(degrees)) * strength;
  // Match both value and slope at 45 degrees, then approach 65 gradually.
  // This keeps the eye away from grazing angles where expansion grows rapidly.
  const limited = scaled <= 45 ? scaled : 45 + 20 * (1 - Math.exp(-(scaled - 45) / 20));
  return Math.sign(degrees) * limited;
}

/**
 * Partially compensate physical viewing angle with one coherent perspective.
 * Strength changes the observer, never the rigid plane or its edge hinge.
 * It is not a horizontal scale factor or a guarantee of face tracking.
 */
export function compensatedViewerRotation(
  yawDegrees: number,
  pitchDegrees: number,
  strength = DEFAULT_COMPENSATION,
): number[] {
  if (![yawDegrees, pitchDegrees, strength].every(Number.isFinite)) {
    throw new TypeError('Compensation angles and strength must be finite');
  }
  const amount = Math.max(0, Math.min(1, strength));
  return axisRotation(compensatedAngle(pitchDegrees, amount), compensatedAngle(yawDegrees, amount));
}
