import { createRenderer, type RenderState } from '../src/renderer';
import { axisRotation } from '../src/orientation';

/** Browser pixel regressions: these exercise real WebGL output, not shader source strings. */
export async function runPostprocessChecks() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:-1000px;top:0;width:240px;height:400px';
  document.body.append(canvas);
  const source = document.createElement('canvas');
  source.width = 240;
  source.height = 400;
  const paint = source.getContext('2d')!;
  paint.fillStyle = '#fff';
  paint.fillRect(0, 0, source.width, source.height);
  // Fine stripes at each hinge expose loss of real detail; a solid white
  // fixture alone would also pass if the supposedly clear side were blurred.
  paint.fillStyle = '#111';
  for (let y = 0; y < source.height; y += 4) {
    paint.fillRect(0, y, 14, 2);
    paint.fillRect(source.width - 14, y, 14, 2);
  }
  // A separate vertical band makes the stronger-radius regression measurable
  // without depending on the projected cavity edge. Keep it in the middle
  // rows so the older tilted edge probes still see the white fixture. At a
  // far enough probe, 72px should spread this feature while 22px should leave
  // the white field nearly unchanged.
  paint.fillRect(64, 80, 24, 240);
  const errors: string[] = [];
  const renderer = createRenderer(canvas, source.toDataURL(), message => {
    if (message && !message.includes('context lost')) errors.push(message);
  });
  const gl = canvas.getContext('webgl2');
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  assert(!!gl, 'WebGL2 unavailable');
  const context = gl!;
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const neutral: RenderState = { rotation: axisRotation(0, 0), viewerRotation: axisRotation(0, 0), hinge: 'left', blur: 0, dim: 0, perspective: 550 };
  const capture = (state: RenderState) => {
    renderer.render(state);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const sample = (pixels: Uint8Array, x: number, y: number) => {
    const px = Math.min(canvas.width - 1, Math.floor(x * canvas.width / canvas.clientWidth));
    const py = Math.min(canvas.height - 1, Math.floor(y * canvas.height / canvas.clientHeight));
    const index = (py * canvas.width + px) * 4;
    return (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
  };
  const averageSample = (pixels: Uint8Array, x: number, startY = 24, endY = 376) => {
    let total = 0;
    let count = 0;
    for (let y = startY; y <= endY; y += 4) {
      total += sample(pixels, x, y);
      count += 1;
    }
    return total / Math.max(1, count);
  };
  const results: Record<string, unknown>[] = [];
  try {
    // Wait for the renderer's image upload without relying on a fixed network delay.
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      await wait(25);
      if (sample(capture(neutral), 120, 200) > 245) { ready = true; break; }
      if (errors.length) break;
    }
    assert(ready, `Wallpaper did not become ready: ${errors.join('; ')}`);

    for (const hinge of ['left', 'right'] as const) {
      const angle = hinge === 'left' ? 35 : -35;
      const state: RenderState = { ...neutral, hinge, rotation: axisRotation(0, angle), viewerRotation: axisRotation(0, angle) };
      const sharp = capture(state);
      const blurred = capture({ ...state, blur: 22 });
      const x = hinge === 'left' ? 192 : 48;
      // Find a projected image-to-cavity edge from actual sharp pixels. Search
      // for softening on BOTH sides; an image-only filter fails the outside test.
      let outsideLift = 0;
      let insideLoss = 0;
      let boundaryFound = false;
      for (let y = 2; y < 398; y++) {
        const a = sample(sharp, x, y);
        const b = sample(blurred, x, y);
        if (a < 25) { outsideLift = Math.max(outsideLift, b - a); boundaryFound = true; }
        if (a > 235) insideLoss = Math.max(insideLoss, a - b);
      }
      assert(boundaryFound, `${hinge}: fixture has no visible cavity at the probe column`);
      assert(outsideLift > 10, `${hinge}: blur was clipped to the image; outside lift=${outsideLift.toFixed(2)}`);
      assert(insideLoss > 10, `${hinge}: cavity did not mix into image; inside loss=${insideLoss.toFixed(2)}`);
      const pivotX = hinge === 'left' ? 1 : 239;
      let pivotDelta = 0;
      for (let y = 20; y < 380; y += 20) {
        pivotDelta = Math.max(pivotDelta, Math.abs(sample(sharp, pivotX, y) - sample(blurred, pivotX, y)));
      }
      assert(pivotDelta <= 3, `${hinge}: anchored clear side lost detail; delta=${pivotDelta.toFixed(2)}`);
      const wideBlurred = capture({ ...state, blur: 72 });
      let widePivotDelta = 0;
      for (let y = 20; y < 380; y += 20) {
        widePivotDelta = Math.max(widePivotDelta,
          Math.abs(sample(sharp, pivotX, y) - sample(wideBlurred, pivotX, y)));
      }
      assert(widePivotDelta <= 3,
        `${hinge}: anchored clear side lost detail at the larger radius; delta=${widePivotDelta.toFixed(2)}`);
      const unblurredAgain = capture(state);
      assert(sharp.every((value, index) => value === unblurredAgain[index]), `${hinge}: zero blur changed the sharp render`);
      assert(context.getError() === context.NO_ERROR, `${hinge}: WebGL error after postprocessing`);
      results.push({ hinge, outsideLift, insideLoss, pivotDelta, widePivotDelta, zeroBlurExact: true });
    }

    // The new radius must have a visible effect beyond the previous 24px cap.
    // The fixture's central band is outside this probe, so the comparison
    // measures actual feature spread instead of merely a darker edge.
    const neutralSharp = capture({ ...neutral, dim: 0 });
    const mediumBlurred = capture({ ...neutral, blur: 22, dim: 0 });
    const broadBlurred = capture({ ...neutral, blur: 72, dim: 0 });
    const sharpProbe = averageSample(neutralSharp, 108, 160, 240);
    const mediumProbe = averageSample(mediumBlurred, 108, 160, 240);
    const broadProbe = averageSample(broadBlurred, 108, 160, 240);
    const mediumLoss = sharpProbe - mediumProbe;
    const broadLoss = sharpProbe - broadProbe;
    assert(broadLoss > mediumLoss + 5,
      `large blur did not spread the central feature: mediumLoss=${mediumLoss.toFixed(2)}, broadLoss=${broadLoss.toFixed(2)}`);
    assert(broadLoss > 8,
      `large blur radius is not visibly stronger than the previous cap: broadLoss=${broadLoss.toFixed(2)}`);
    let broadMaxStep = 0;
    for (let x = 90; x < 136; x += 1) {
      broadMaxStep = Math.max(broadMaxStep,
        Math.abs(sample(broadBlurred, x + 1, 200) - sample(broadBlurred, x, 200)));
    }
    assert(broadMaxStep < 30,
      `large blur has a visible sampling step: maxAdjacentDelta=${broadMaxStep.toFixed(2)}`);
    results.push({ blurExtent: { sharpProbe, mediumLoss, broadLoss, broadMaxStep, radius: 72 } });

    // Dim is applied by the final postprocess field. It must leave the hinge
    // bright, become stronger toward the receding side, and mirror when the
    // physical hinge changes sides.
    const leftBase = capture({ ...neutral, hinge: 'left', blur: 72, dim: 0 });
    const leftHalfDimmed = capture({ ...neutral, hinge: 'left', blur: 72, dim: 0.5 });
    const leftDimmed = capture({ ...neutral, hinge: 'left', blur: 72, dim: 1 });
    const rightBase = capture({ ...neutral, hinge: 'right', blur: 72, dim: 0 });
    const rightDimmed = capture({ ...neutral, hinge: 'right', blur: 72, dim: 1 });
    const attenuationRatio = (base: Uint8Array, dimmed: Uint8Array, x: number) =>
      averageSample(dimmed, x, 160, 240) / Math.max(averageSample(base, x, 160, 240), 1);
    const leftNearRatio = attenuationRatio(leftBase, leftDimmed, 2);
    const leftFarRatio = attenuationRatio(leftBase, leftDimmed, 216);
    const leftHalfFarRatio = attenuationRatio(leftBase, leftHalfDimmed, 216);
    const rightNearRatio = attenuationRatio(rightBase, rightDimmed, 238);
    const rightFarRatio = attenuationRatio(rightBase, rightDimmed, 24);
    assert(leftNearRatio > 0.97,
      `left hinge was darkened inside its clear strip: ratio=${leftNearRatio.toFixed(3)}`);
    assert(rightNearRatio > 0.97,
      `right hinge was darkened inside its clear strip: ratio=${rightNearRatio.toFixed(3)}`);
    assert(leftFarRatio < leftNearRatio - 0.25,
      `left receding side did not darken with blur: near=${leftNearRatio.toFixed(3)}, far=${leftFarRatio.toFixed(3)}`);
    assert(rightFarRatio < rightNearRatio - 0.25,
      `right receding side did not darken with blur: near=${rightNearRatio.toFixed(3)}, far=${rightFarRatio.toFixed(3)}`);
    assert(leftFarRatio < leftHalfFarRatio - 0.1,
      `left darkness did not increase with dim progress: half=${leftHalfFarRatio.toFixed(3)}, full=${leftFarRatio.toFixed(3)}`);
    assert(Math.abs(leftFarRatio - rightFarRatio) < 0.08,
      `darkness gradient did not mirror across hinges: left=${leftFarRatio.toFixed(3)}, right=${rightFarRatio.toFixed(3)}`);

    // Even an explicit dim value must not tint a true zero-blur copy.
    const zeroBlurDimmed = capture({ ...neutral, blur: 0, dim: 1 });
    assert(neutralSharp.every((value, index) => value === zeroBlurDimmed[index]),
      'zero blur was darkened even though it should be an exact copy');
    results.push({
      darkness: { leftNearRatio, leftHalfFarRatio, leftFarRatio, rightNearRatio, rightFarRatio },
      zeroBlurDimExact: true,
    });

    canvas.style.width = '180px';
    canvas.style.height = '280px';
    renderer.resize();
    const resized = capture({ ...neutral, rotation: axisRotation(0, 25), blur: 48 });
    assert(resized.length === canvas.width * canvas.height * 4 && sample(resized, 20, 140) > 220, 'Resize lost framebuffer content');
    assert(context.getError() === context.NO_ERROR, 'WebGL error after framebuffer resize');
    results.push({ resize: [canvas.width, canvas.height], valid: true });

    const lifecycle = context.getExtension('WEBGL_lose_context');
    if (lifecycle) {
      const restored = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebGL context did not restore')), 5000);
        canvas.addEventListener('webglcontextrestored', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      lifecycle.loseContext();
      await wait(100);
      lifecycle.restoreContext();
      await restored;
      const afterRestore = capture({ ...neutral, rotation: axisRotation(0, 25), blur: 48 });
      assert(sample(afterRestore, 20, 140) > 220, 'Context restore lost scene or postprocess targets');
      assert(context.getError() === context.NO_ERROR, 'WebGL error after context restore');
      results.push({ contextRestore: 'passed' });
    }
    assert(errors.length === 0, errors.join('; '));
    return results;
  } finally {
    renderer.dispose();
    renderer.dispose();
    canvas.remove();
  }
}
