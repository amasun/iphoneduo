export interface EffectSettings {
  gain: number;
  threshold: number;
  maxAngle: number;
  blur: number;
}
/** Blur radius at the reference screen width of 390 CSS pixels. */
export const MAX_BLUR = 120;
export const profiles: Record<string, EffectSettings> = {
  gentle: { gain: 0.85, threshold: 16, maxAngle: 28, blur: 16 },
  balanced: { gain: 1, threshold: 10, maxAngle: 45, blur: 48 },
  deep: { gain: 1.1, threshold: 5, maxAngle: 60, blur: 96 },
};
export function effectAtAngle(angle: number, settings: EffectSettings) {
  const linear = Math.max(0, Math.min(1, (Math.abs(angle) - settings.threshold) / (52 - settings.threshold)));
  const progress = linear * linear * (3 - 2 * linear);
  const blur = Math.max(0, Math.min(MAX_BLUR, settings.blur)) * progress;
  // Drive darkness from actual defocus, so reducing blur also restores light.
  // The renderer applies this strength spatially, preserving the sharp hinge.
  return { progress, blur, dim: 1 - Math.exp(-blur / 60) };
}
