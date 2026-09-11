export interface ViewingCalibration {
  distanceCm: number;
  screenShortCm: number;
}

export const CALIBRATION_STORAGE_KEY = 'inside.viewing-calibration.v1';
// iPhone 14 Pro: 1179 px / 460 ppi * 2.54, rounded to 0.01 cm.
// https://support.apple.com/en-us/111849
export const DEFAULT_CALIBRATION: ViewingCalibration = { distanceCm: 40, screenShortCm: 6.51 };

export function serializeViewingCalibration(calibration: ViewingCalibration): string {
  return JSON.stringify({ ...calibration, version: 2 });
}

export function parseViewingCalibration(raw: string | null): ViewingCalibration {
  try {
    const value = JSON.parse(raw ?? 'null');
    // Upgrade the old automatically saved default once. Versioned records
    // preserve later user choices, including choosing 50 cm again.
    const distanceCm = value?.version === undefined && value?.distanceCm === 50
      ? DEFAULT_CALIBRATION.distanceCm : value?.distanceCm;
    return {
      distanceCm: typeof distanceCm === 'number' && Number.isFinite(distanceCm)
        && distanceCm >= 20 && distanceCm <= 100 ? distanceCm : DEFAULT_CALIBRATION.distanceCm,
      screenShortCm: typeof value?.screenShortCm === 'number' && Number.isFinite(value.screenShortCm)
        && value.screenShortCm >= 5 && value.screenShortCm <= 10 ? value.screenShortCm : DEFAULT_CALIBRATION.screenShortCm,
    };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
}

/** Use full physical screen pixels on phones, regardless of browser toolbar size. */
export function referenceShortEdge(
  canvasWidth: number, canvasHeight: number,
  screenWidth = 0, screenHeight = 0, usePhysicalScreen = false,
): number {
  const physical = Math.min(screenWidth, screenHeight);
  if (usePhysicalScreen && Number.isFinite(physical) && physical > 0) return physical;
  return Math.min(canvasWidth, canvasHeight);
}

export function perspectiveDistancePx(shortEdgePx: number, calibration: ViewingCalibration): number {
  const { distanceCm, screenShortCm } = calibration;
  if (![shortEdgePx, distanceCm, screenShortCm].every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError('Screen size and viewing distance must be positive finite numbers');
  }
  return distanceCm / screenShortCm * shortEdgePx;
}
