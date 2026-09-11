import { axisRotation } from './orientation.ts';

/** A visual tuning default, independent of the image's rotation gain. */
export const DEFAULT_COMPENSATION = 1;

function compensatedAngle(degrees: number, strength: number): number {
  // Keep the observer on the same bounded, linear yaw/pitch scale as the
  // physical preview.  At full strength this is exactly the measured angle;
  // lower strengths interpolate from the fixed-eye pose without changing the
  // image rotation itself.
  return Math.sign(degrees) * Math.min(80, Math.abs(degrees)) * strength;
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
