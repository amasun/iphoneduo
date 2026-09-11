import { createPhoneModelRenderer, type PhoneModelRenderer } from '../src/phoneModelRenderer';

/** Project colored points independently through the public physical camera. */
export async function runPhoneModelChecks() {
  const source = document.createElement('canvas');
  source.width = 240;
  source.height = 520;
  const paint = source.getContext('2d')!;
  const output = document.createElement('canvas');
  output.style.cssText = 'position:fixed;left:-2000px;top:0;width:600px;height:650px';
  document.body.append(output);
  let model: PhoneModelRenderer | null = null;
  let timer = 0;
  try {
    let resolveReady!: (aspect: number) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      timer = window.setTimeout(() => reject(new Error('Phone model load timed out')), 15000);
    });
    model = createPhoneModelRenderer(output, source, '/models/iphone-17-pro-max/scene.gltf', {
      onReady: ({ screenAspect }) => resolveReady(screenAspect),
      onError: message => rejectReady(new Error(message)),
    });
    const aspect = await ready;
    clearTimeout(timer);
    if (!(aspect > 0.4 && aspect < 0.55)) throw new Error(`Unexpected phone display aspect ${aspect}`);
    const screen = { left: 165, top: 90, width: 200, height: 200 / aspect };
    source.height = Math.round(source.width / aspect);
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    colors.forEach((color, index) => {
      paint.fillStyle = color;
      paint.fillRect(index % 2 * source.width / 2, Math.floor(index / 2) * source.height / 2, source.width / 2, source.height / 2);
    });
    const gl = output.getContext('webgl2')!;
    const pixel = (x: number, y: number) => {
      const rgba = new Uint8Array(4);
      const ratioX = output.width / output.clientWidth;
      const ratioY = output.height / output.clientHeight;
      gl.readPixels(Math.floor(x * ratioX), output.height - 1 - Math.floor(y * ratioY), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return [...rgba];
    };
    let samples = 0;
    for (const degrees of [0, -60, 60, -80, 80]) {
      const theta = degrees * Math.PI / 180;
      const c = Math.cos(theta), s = Math.sin(theta);
      model!.setView({ rotation: [c, 0, s, 0, 1, 0, -s, 0, c], perspective: 1200, screenRect: screen });
      model!.updateScreen();
      for (let index = 0; index < 4; index++) {
        const x = (index % 2 ? 1 : -1) * screen.width / 4;
        const y = (index < 2 ? 1 : -1) * screen.height / 4;
        const distanceScale = 1200 / (1200 + x * s);
        const rgba = pixel(screen.left + screen.width / 2 + x * c * distanceScale,
          screen.top + screen.height / 2 - y * distanceScale);
        const channels = index === 0 ? [true, false, false] : index === 1 ? [false, true, false]
          : index === 2 ? [false, false, true] : [true, true, false];
        if (rgba[3] < 240 || channels.some((on, i) => on ? rgba[i] < 170 : rgba[i] > 100)) {
          throw new Error(`Phone ${degrees}° quadrant ${index}: ${rgba.join(',')} (screen mapping / occlusion)`);
        }
        samples++;
      }
    }
    // A changed texture must appear in the same synchronous render call.
    // Grow an already-uploaded source: immutable GPU texture storage must be
    // reallocated instead of attempting a too-large sub-image copy.
    source.width = 300;
    source.height = Math.round(300 / aspect);
    paint.fillStyle = '#ff00ff';
    paint.fillRect(0, 0, source.width, source.height);
    output.style.width = '740px';
    output.style.height = '700px';
    screen.left = 225;
    screen.top = 100;
    model!.setView({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], perspective: 1200, screenRect: screen });
    model!.updateScreen();
    const updated = pixel(screen.left + screen.width / 2, screen.top + screen.height / 2);
    if (updated[0] < 170 || updated[1] > 100 || updated[2] < 170 || updated[3] < 240)
      throw new Error(`Phone live texture / resized camera failed: ${updated}`);
    paint.fillStyle = '#808080';
    paint.fillRect(0, 0, source.width, source.height);
    model.updateScreen();
    const neutral = pixel(screen.left + screen.width / 2, screen.top + screen.height / 2);
    if (neutral.slice(0, 3).some(value => Math.abs(value - 128) > 20))
      throw new Error(`Phone screen color conversion failed: ${neutral}`);
    return { projectedColorSamples: samples, liveTextureAndResize: true, neutralColor: neutral, screenAspect: aspect };
  } finally {
    clearTimeout(timer);
    model?.dispose();
    output.remove();
  }
}
