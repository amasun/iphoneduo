export interface EffectSettings {
  threshold: number;
  blur: number;
}
/** Blur radius at the reference screen width of 390 CSS pixels. */
export const MAX_BLUR = 120;
export const DEFAULT_EFFECT_SETTINGS: Readonly<EffectSettings> = { threshold: 5, blur: 36 };
export function effectAtAngle(angle: number, settings: EffectSettings) {
  const linear = Math.max(0, Math.min(1, (Math.abs(angle) - settings.threshold) / (52 - settings.threshold)));
  const progress = linear * linear * (3 - 2 * linear);
  const blur = Math.max(0, Math.min(MAX_BLUR, settings.blur)) * progress;
  // Drive darkness from actual defocus, so reducing blur also restores light.
  // The renderer applies this strength spatially, preserving the sharp hinge.
  return { progress, blur, dim: 1 - Math.exp(-blur / 60) };
}
