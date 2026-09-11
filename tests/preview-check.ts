type Vec3 = [number, number, number];

interface SceneDraw {
  rotation: number[];
  camera: Vec3;
  perspectiveStrength: number;
}

interface ContextCapture {
  rotation: number[] | null;
  camera: Vec3 | null;
  scenePending: boolean;
  draws: SceneDraw[];
}

interface WebGLPrototypeHooks {
  uniformMatrix3fv: (...args: any[]) => void;
  uniform3f: (...args: any[]) => void;
  drawArrays: (...args: any[]) => void;
}

const IDENTITY = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

function multiply(a: readonly number[], b: readonly number[]): number[] {
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

function transform(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2],
  ];
}

function rotationX(degrees: number): number[] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotationY(degrees: number): number[] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function rotationZ(degrees: number): number[] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function transpose(matrix: readonly number[]): number[] {
  return [
    matrix[0], matrix[3], matrix[6],
    matrix[1], matrix[4], matrix[7],
    matrix[2], matrix[5], matrix[8],
  ];
}

function normalize(point: Vec3): Vec3 {
  const length = Math.hypot(...point);
  return length > 0.000001 ? [point[0] / length, point[1] / length, point[2] / length] : [0, 0, 1];
}

function independentOrientationMatrix(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): number[] {
  return multiply(multiply(multiply(rotationZ(alpha), rotationX(beta)), rotationY(gamma)), rotationZ(-screenAngle));
}

function expectedRelativeForward(
  calibration: [number, number, number],
  current: [number, number, number],
  screenAngle: number,
): Vec3 {
  const reference = independentOrientationMatrix(...calibration, screenAngle);
  const pose = independentOrientationMatrix(...current, screenAngle);
  // The physical relative pose is calibration^-1 * current. Keep this
  // independent from production orientation code so axis/order regressions
  // remain visible in the browser fixture.
  return normalize(transform(multiply(transpose(reference), pose), [0, 0, 1]));
}

function expectedHorizontalYaw(
  calibration: [number, number, number],
  current: [number, number, number],
  screenAngle: number,
): number {
  const normal = expectedRelativeForward(calibration, current, screenAngle);
  const heading = Math.atan2(normal[0], normal[2]) * 180 / Math.PI;
  return clamp(-heading, -80, 80);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function angularDifference(first: number, second: number): number {
  const wrapped = ((first - second + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped);
}

/**
 * Keep this model independent from production compensation.ts. The expected
 * observer follows the same linear yaw response used by the App while the
 * test remains able to catch a helper wired with the wrong axis/order.
 */
function compensatedAxis(degrees: number, strength: number): number {
  return clamp(degrees, -80, 80) * clamp(strength, 0, 1);
}

function compensatedViewerRotation(yaw: number, pitch: number, strength: number): number[] {
  return multiply(rotationY(compensatedAxis(yaw, strength)), rotationX(compensatedAxis(pitch, strength)));
}

function compensatedCamera(yaw: number, pitch: number, strength: number, distance: number): Vec3 {
  return transform(compensatedViewerRotation(yaw, pitch, strength), [0, 0, distance]);
}

function maxDifference(actual: readonly number[], expected: readonly number[]): number {
  return Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
}

function parseTransform(value: string): number[] {
  if (value === 'none' || value.trim() === '') return [...IDENTITY];
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  const payload = open >= 0 && close > open ? value.slice(open + 1, close) : '';
  const numbers = payload.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  if (value.startsWith('matrix3d(') && numbers.length === 16) {
    // CSS matrix3d values are column-major; return the 3x3 y-down row matrix.
    return [
      numbers[0], numbers[4], numbers[8],
      numbers[1], numbers[5], numbers[9],
      numbers[2], numbers[6], numbers[10],
    ];
  }
  if (value.startsWith('matrix(') && numbers.length === 6) {
    return [numbers[0], numbers[2], 0, numbers[1], numbers[3], 0, 0, 0, 1];
  }
  throw new Error(`Unexpected device transform: ${value}`);
}

function cssToYUp(matrix: readonly number[]): number[] {
  // CSS uses y-down coordinates. Conjugating by diag(1, -1, 1) restores the
  // renderer's y-up basis; the result is the inverse phone rotation.
  return [
    matrix[0], -matrix[1], matrix[2],
    -matrix[3], matrix[4], -matrix[5],
    matrix[6], -matrix[7], matrix[8],
  ];
}

function yawDegrees(matrix: readonly number[]): number {
  return Math.atan2(matrix[2], matrix[0]) * 180 / Math.PI;
}

function determinant(matrix: readonly number[]): number {
  return matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
    - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
    + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, message: string, timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(message);
    await wait(25);
  }
}

function setRangeValue(
  frameWindow: Window,
  input: HTMLInputElement,
  value: number,
): void {
  const realm = frameWindow as Window & {
    HTMLInputElement: { prototype: HTMLInputElement };
    Event: new (type: string, init?: EventInit) => Event;
  };
  const setter = Object.getOwnPropertyDescriptor(
    realm.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Unable to set iframe range input');
  setter.call(input, String(value));
  input.dispatchEvent(new realm.Event('input', { bubbles: true }));
  input.dispatchEvent(new realm.Event('change', { bubbles: true }));
}

/**
 * Exercise the real non-immersive App and compare its scene rotation with the
 * CSS phone rotation. This is intentionally separate from renderer-check:
 * WebGL pixels alone cannot observe the outer framed preview transform.
 */
export async function runPreviewChecks() {
  const iframe = document.createElement('iframe');
  iframe.title = 'preview regression fixture';
  iframe.style.cssText = [
    'position:fixed', 'left:-10000px', 'top:0',
    'width:1200px', 'height:1000px', 'border:0',
  ].join(';');

  const captures = new WeakMap<WebGL2RenderingContext, ContextCapture>();
  let prototype: WebGLPrototypeHooks | null = null;
  let originalMatrix: WebGLPrototypeHooks['uniformMatrix3fv'] | null = null;
  let originalUniform3f: WebGLPrototypeHooks['uniform3f'] | null = null;
  let originalDrawArrays: WebGLPrototypeHooks['drawArrays'] | null = null;

  try {
    // Keep the iframe document in the same realm while loading the actual App
    // module, so the hooks run before React creates the renderer context.
    const origin = new URL('/', document.baseURI).href;
    const base = origin.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    iframe.srcdoc = `<!doctype html><html><head><base href="${base}"></head><body><div id="root"></div></body></html>`;
    const loaded = new Promise<void>((resolve, reject) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.addEventListener('error', () => reject(new Error('Preview iframe failed to load')), { once: true });
    });
    document.body.append(iframe);
    await loaded;

    const frameWindow = iframe.contentWindow;
    const frameDocument = iframe.contentDocument;
    const constructor = (frameWindow as (Window & {
      WebGL2RenderingContext?: { prototype: WebGLPrototypeHooks };
    }) | null)?.WebGL2RenderingContext;
    if (!frameWindow || !frameDocument || !constructor) {
      throw new Error('Preview iframe has no WebGL2 realm');
    }

    prototype = constructor.prototype;
    originalMatrix = prototype.uniformMatrix3fv;
    originalUniform3f = prototype.uniform3f;
    originalDrawArrays = prototype.drawArrays;
    const contextState = (gl: WebGL2RenderingContext): ContextCapture => {
      const existing = captures.get(gl);
      if (existing) return existing;
      const created: ContextCapture = {
        rotation: null,
        camera: null,
        scenePending: false,
        draws: [],
      };
      captures.set(gl, created);
      return created;
    };

    prototype.uniformMatrix3fv = function (this: WebGL2RenderingContext, ...args: any[]) {
      const value = args[2] as ArrayLike<number> | undefined;
      const state = contextState(this);
      if (value && value.length === 9) {
        const columnMajor = Array.from(value);
        state.rotation = [
          columnMajor[0], columnMajor[3], columnMajor[6],
          columnMajor[1], columnMajor[4], columnMajor[7],
          columnMajor[2], columnMajor[5], columnMajor[8],
        ];
        state.scenePending = true;
      }
      return originalMatrix!.apply(this, args);
    };
    prototype.uniform3f = function (this: WebGL2RenderingContext, ...args: any[]) {
      const state = contextState(this);
      if (args.length >= 4 && [args[1], args[2], args[3]].every(Number.isFinite)) {
        state.camera = [args[1], args[2], args[3]];
      }
      return originalUniform3f!.apply(this, args);
    };
    prototype.drawArrays = function (this: WebGL2RenderingContext, ...args: any[]) {
      const state = contextState(this);
      if (state.scenePending && state.rotation && state.camera) {
        const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
        const location = this.getUniformLocation(program, 'u_perspectiveStrength');
        state.draws.push({ rotation: [...state.rotation], camera: [...state.camera],
          perspectiveStrength: location ? this.getUniform(program, location) as number : NaN });
        state.scenePending = false;
      }
      return originalDrawArrays!.apply(this, args);
    };

    // Vite's React transform expects this preamble before any transformed
    // component module executes. Append the App only after it is installed.
    const preamble = frameDocument.createElement('script');
    preamble.type = 'module';
    preamble.textContent = [
      `import RefreshRuntime from ${JSON.stringify(new URL('/@react-refresh', origin).href)};`,
      'RefreshRuntime.injectIntoGlobalHook(window);',
      'window.$RefreshReg$ = () => {};',
      'window.$RefreshSig$ = () => type => type;',
      'window.__vite_plugin_react_preamble_installed__ = true;',
      `const app = document.createElement('script'); app.type = 'module'; app.src = ${JSON.stringify(new URL('/src/main.tsx', origin).href)}; document.body.append(app);`,
    ].join('\n');
    frameDocument.body.append(preamble);
    await waitFor(() => Boolean(frameDocument.querySelector('canvas')),
      'Preview App did not mount its canvas');
    await waitFor(() => {
      const canvas = frameDocument.querySelector<HTMLCanvasElement>('canvas');
      return Boolean(canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0);
    }, 'Preview App canvas has no layout size');

    const canvas = frameDocument.querySelector<HTMLCanvasElement>('canvas')!;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('Preview App did not create WebGL2');
    await waitFor(() => captures.has(gl), 'Preview App WebGL hooks saw no context');
    const state = captures.get(gl)!;
    await waitFor(() => state.draws.length > 0, 'Preview App made no scene draw');

    const yawInput = frameDocument.querySelector<HTMLInputElement>('#range-左右倾斜');
    const compensationInput = frameDocument.querySelector<HTMLInputElement>('#range-拉伸补偿');
    const perspectiveInput = frameDocument.querySelector<HTMLInputElement>('#range-远侧收缩');
    const distanceInput = frameDocument.querySelector<HTMLInputElement>('#range-透视距离');
    const screenShortCm = 6.51;
    const stage = frameDocument.querySelector<HTMLElement>('.stage');
    const device = frameDocument.querySelector<HTMLElement>('.device');
    if (!yawInput || !compensationInput || !perspectiveInput || !distanceInput || !stage || !device) {
      throw new Error('Preview App controls are incomplete');
    }
    if (yawInput.min !== '-180' || yawInput.max !== '180') {
      throw new Error(`Model yaw slider does not cover a full turn: ${yawInput.min}..${yawInput.max}`);
    }
    if (compensationInput.min !== '0' || compensationInput.max !== '100'
      || compensationInput.value !== '60') {
      throw new Error(`Stretch compensation range is not the default 0..100/60: ${compensationInput.min}..${compensationInput.max}/${compensationInput.value}`);
    }
    if (distanceInput.min !== '20' || distanceInput.max !== '100' || distanceInput.value !== '40') {
      throw new Error(`Viewing distance range is not the default 20..100/40: ${distanceInput.min}..${distanceInput.max}/${distanceInput.value}`);
    }
    if (frameDocument.querySelector('#range-屏幕短边')) {
      throw new Error('Device screen size should be fixed internally, not exposed as a slider');
    }

    const framedCompensation = Number(compensationInput.value) / 100;
    // Image loading can draw once before the App's first animation frame
    // applies its configured defaults to the renderer.
    await waitFor(() => Math.abs(state.draws.at(-1)!.perspectiveStrength - 0.5) < 0.0001,
      'Far-side perspective did not initialize to 50% on the GPU');
    if (perspectiveInput.min !== '0' || perspectiveInput.max !== '200' || perspectiveInput.value !== '50'
      || Math.abs(state.draws.at(-1)!.perspectiveStrength - 0.5) > 0.0001) {
      throw new Error('Far-side perspective did not initialize to 50% on the GPU');
    }
    const perspectiveResults: Record<string, unknown>[] = [];
    const checkPerspectiveControl = async (mode: string) => {
      const settledPlane = mode === 'sensor' ? IDENTITY : rotationY(-Number(yawInput.value));
      await waitFor(() => maxDifference(state.draws.at(-1)!.rotation, settledPlane) < 0.00002,
        `${mode}: plane easing did not settle before the perspective sweep`);
      const baseline = state.draws.at(-1)!;
      for (const value of [0, 100, 200, 50]) {
        const before = state.draws.length;
        setRangeValue(frameWindow, perspectiveInput, value);
        await waitFor(() => state.draws.length > before
          && Math.abs(state.draws.at(-1)!.perspectiveStrength - value / 100) < 0.0001,
        `${mode}: far-side slider ${value}% did not redraw the GPU`);
        const draw = state.draws.at(-1)!;
        if (maxDifference(draw.rotation, baseline.rotation) > 0.003
          || maxDifference(draw.camera, baseline.camera) > 3) {
          throw new Error(`${mode}: far-side slider changed the plane angle or calibrated eye`);
        }
        perspectiveResults.push({ mode, value, actual: draw.perspectiveStrength });
      }
    };

    const results: Record<string, unknown>[] = [];
    for (const requestedYaw of [55, -55]) {
      const before = state.draws.length;
      setRangeValue(frameWindow, yawInput, requestedYaw);
      await waitFor(() => state.draws.length > before,
        `Framed/${requestedYaw}: slider caused no scene draw`);
      // Manual pose easing settles in a few frames. Read after it reaches
      // the requested angle so a stale intermediate transform cannot pass.
      await wait(260);
      const draw = state.draws[state.draws.length - 1];
      const cssYDown = parseTransform(frameWindow.getComputedStyle(device).transform);
      const outerInverse = cssToYUp(cssYDown);
      const rotationError = maxDifference(multiply(draw.rotation, outerInverse), IDENTITY);
      const outerDeterminantError = Math.abs(determinant(outerInverse) - 1);
      const poseYaw = yawDegrees(draw.rotation);
      const perspective = Number.parseFloat(frameWindow.getComputedStyle(stage).perspective);
      const expectedCamera = compensatedCamera(poseYaw, 0, framedCompensation, perspective);
      const expectedFramedPerspective = Number(distanceInput.value) / screenShortCm
        * Math.min(canvas.clientWidth, canvas.clientHeight);
      const cameraError = maxDifference(draw.camera, expectedCamera);
      const origin = frameWindow.getComputedStyle(stage).perspectiveOrigin;
      const expectedOriginX = device.offsetLeft + device.offsetWidth / 2;
      const expectedOriginY = device.offsetTop + device.offsetHeight / 2;
      const originNumbers = origin.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) ?? [];
      const originError = originNumbers.length >= 2
        ? Math.max(Math.abs(originNumbers[0] - expectedOriginX), Math.abs(originNumbers[1] - expectedOriginY))
        : Infinity;

      if (!Number.isFinite(perspective) || perspective <= 0) {
        throw new Error(`Framed/${requestedYaw}: missing stage perspective`);
      }
      if (Math.abs(perspective - expectedFramedPerspective) > 1.5) {
        throw new Error(`Framed/${requestedYaw}: perspective ${perspective.toFixed(2)}px != calibrated ${expectedFramedPerspective.toFixed(2)}px`);
      }
      if (Math.abs(Math.abs(poseYaw) - 55) > 2.5) {
        throw new Error(`Framed/${requestedYaw}: pose stopped at ${poseYaw.toFixed(2)}°`);
      }
      if (rotationError > 0.002 || outerDeterminantError > 0.002) {
        throw new Error(`Framed/${requestedYaw}: scene/CSS rotation product error ${rotationError.toFixed(4)}`);
      }
      if (cameraError > 1.5) {
        throw new Error(`Framed/${requestedYaw}: camera pose error ${cameraError.toFixed(2)}px`);
      }
      if (originError > 1.5) {
        throw new Error(`Framed/${requestedYaw}: perspective origin error ${originError.toFixed(2)}px`);
      }
      results.push({ requestedYaw, poseYaw, rotationError, cameraError, perspective,
        expectedFramedPerspective, originError });
    }

    await checkPerspectiveControl('framed');

    // Horizontal laps remain unrestricted, including at either pitch limit.
    const frontButton = frameDocument.querySelector<HTMLButtonElement>('.simulation-bottom button')!;
    const modelRotation = () => cssToYUp(parseTransform(frameWindow.getComputedStyle(device).transform));
    const orbitResults: Record<string, unknown>[] = [];
    frontButton.click();
    await waitFor(() => maxDifference(modelRotation(), IDENTITY) < 0.0001, 'Orbit reset failed');
    const pointerRealm = frameWindow as Window & { PointerEvent: typeof PointerEvent };
    const oldCapture = stage.setPointerCapture;
    stage.setPointerCapture = () => {};
    try {
      let yaw = 0, pitch = 0;
      for (const [dx, dy] of [[300, 0], [300, 0], [300, 0], [300, 0], [-600, 0], [0, 450], [300, 300], [0, -450], [-300, -300], [0, 15]]) {
        for (const [type, x, y] of [['pointerdown', 200, 250], ['pointermove', 200 + dx, 250 + dy], ['pointerup', 200 + dx, 250 + dy]] as const) {
          stage.dispatchEvent(new pointerRealm.PointerEvent(type, { bubbles: true, pointerId: 1,
            pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y }));
        }
        yaw += dx * 0.4;
        pitch = Math.max(-10, Math.min(10, pitch + dy * 0.4));
        const expected = multiply(rotationY(yaw), rotationX(pitch));
        await waitFor(() => maxDifference(modelRotation(), expected) < 0.0001,
          `Model orbit mismatch at yaw ${yaw}, pitch ${pitch}`);
        orbitResults.push({ yaw, pitch, error: maxDifference(modelRotation(), expected) });
      }
      frontButton.click();
      await waitFor(() => maxDifference(modelRotation(), IDENTITY) < 0.0001, 'Orbit did not reset both axes');
    } finally {
      stage.setPointerCapture = oldCapture;
    }

    // Switch the same fresh App to immersive mode, then exercise the actual
    // permission and DeviceOrientation event path. The first reading is the
    // calibration pose; subsequent readings are checked independently from
    // B^T * A * +Z rather than reusing the production orientation helper.
    const enterButton = Array.from(frameDocument.querySelectorAll<HTMLButtonElement>('.preview-footer button'))
      .find(button => button.textContent?.includes('iPhone 预览'));
    if (!enterButton) throw new Error('Missing immersive preview button');
    enterButton.click();
    await waitFor(() => frameDocument.querySelector('.app')?.classList.contains('is-immersive') === true,
      'Preview App did not enter immersive mode');

    // Use the phone-sized layout before connecting the sensor. In immersive
    // mode there is no CSS phone frame, so the WebGL camera must use the same
    // calibrated distance as the eventual sensor path.
    iframe.style.width = '390px';
    iframe.style.height = '844px';
    await waitFor(() => canvas.clientWidth >= 380 && canvas.clientWidth <= 400
      && canvas.clientHeight >= 830 && canvas.clientHeight <= 860,
    'Preview App did not settle to the phone-sized canvas');
    const expectedDistance = Number(distanceInput.value) / screenShortCm
      * Math.min(canvas.clientWidth, canvas.clientHeight);

    // Before enabling the sensor, check the same manual plane angle and
    // camera rule. This catches the old immersive-only gain and
    // max-angle branch, which made the desktop and phone paths disagree.
    const immersiveManualResults: Record<string, unknown>[] = [];
    const manualAngles = [30, -30, 60, -60, 75, -75, 80, -80];
    for (const requestedYaw of manualAngles) {
      const before = state.draws.length;
      setRangeValue(frameWindow, yawInput, requestedYaw);
      await waitFor(() => state.draws.length > before,
        `Immersive ${requestedYaw}: slider caused no scene draw`);
      const expectedYaw = clamp(-requestedYaw, -80, 80);
      const expectedPlane = rotationY(expectedYaw);
      // Compare settled geometry. A fixed delay can sample the manual easing
      // mid-flight, especially when traversing from +80 to -80 degrees.
      await waitFor(() => maxDifference(state.draws[state.draws.length - 1].rotation, expectedPlane) < 0.0002,
        `Immersive ${requestedYaw}: plane did not settle to the requested angle`);
      const draw = state.draws[state.draws.length - 1];
      const expectedCamera = compensatedCamera(expectedYaw, 0,
        Number(compensationInput.value) / 100, expectedDistance);
      const planeError = maxDifference(draw.rotation, expectedPlane);
      const cameraError = maxDifference(draw.camera, expectedCamera);
      const actualYaw = yawDegrees(draw.rotation);
      if (planeError > 0.003 || angularDifference(actualYaw, expectedYaw) > 1.5) {
        throw new Error(`Immersive ${requestedYaw}: plane ${actualYaw.toFixed(2)}° != ${expectedYaw.toFixed(2)}°`);
      }
      if (cameraError > 3) {
        throw new Error(`Immersive ${requestedYaw}: camera error ${cameraError.toFixed(2)}px`);
      }
      if (Math.abs(draw.camera[1]) > 0.01) {
        throw new Error(`Immersive ${requestedYaw}: camera responded to a non-yaw axis`);
      }
      immersiveManualResults.push({ requestedYaw, expectedYaw, actualYaw,
        planeError, cameraError, expectedDistance });
    }

    await checkPerspectiveControl('immersive');

    // Keep one manual pose to compare with the identical calibrated sensor
    // pose below. Alpha +35° produces the same -35° horizontal plane yaw.
    const manualParityBefore = state.draws.length;
    setRangeValue(frameWindow, yawInput, 35);
    await waitFor(() => state.draws.length > manualParityBefore,
      'Immersive manual parity pose caused no scene draw');
    await waitFor(() => maxDifference(state.draws[state.draws.length - 1].rotation, rotationY(-35)) < 0.0002,
      'Immersive manual parity pose did not settle');
    const manualParityDraw: SceneDraw = {
      rotation: [...state.draws[state.draws.length - 1].rotation],
      camera: [...state.draws[state.draws.length - 1].camera],
      perspectiveStrength: state.draws.at(-1)!.perspectiveStrength,
    };

    const mockDeviceOrientationEvent = function MockDeviceOrientationEvent() {};
    Object.defineProperty(mockDeviceOrientationEvent, 'requestPermission', {
      configurable: true,
      value: () => Promise.resolve('granted'),
    });
    Object.defineProperty(frameWindow, 'DeviceOrientationEvent', {
      configurable: true,
      writable: true,
      value: mockDeviceOrientationEvent,
    });
    const frameRealm = frameWindow as Window & {
      Event: new (type: string, init?: EventInit) => Event;
      screen: Screen & { orientation?: ScreenOrientation };
    };
    const dispatchOrientation = (reading: [number, number, number]): void => {
      const event = new frameRealm.Event('deviceorientation');
      Object.defineProperties(event, {
        alpha: { configurable: true, value: reading[0] },
        beta: { configurable: true, value: reading[1] },
        gamma: { configurable: true, value: reading[2] },
      });
      frameWindow.dispatchEvent(event);
    };
    // The controls panel is hidden on a phone-sized iframe, but its real
    // connection button remains in the document and can trigger the same
    // React handler without inventing a test-only UI path.
    const sensorButton = frameDocument.querySelector<HTMLButtonElement>('.connection-card .primary-button')
      ?? frameDocument.querySelector<HTMLButtonElement>('.immersive-actions .status-button')
      ?? frameDocument.querySelector<HTMLButtonElement>('.intro-card .primary-button');
    if (!sensorButton) throw new Error('Missing immersive sensor button');
    sensorButton.click();
    await waitFor(() => frameDocument.querySelector('.sensor-message')?.textContent?.includes('正在等待方向数据') === true,
      'Preview App did not request orientation data');

    const calibration: [number, number, number] = [0, 90, 0];
    const screenAngle = Number(frameRealm.screen.orientation?.angle ?? 0);
    dispatchOrientation(calibration);
    await waitFor(() => frameDocument.querySelector('.sensor-message')?.textContent?.includes('体感已连接') === true,
      'Preview App did not accept the calibration orientation');
    const sensorResults: Record<string, unknown>[] = [];
    let lastExpectedSignature: number[] | null = null;
    let lastDraw: SceneDraw | null = null;
    const sensorReadings: Array<[string, [number, number, number]]> = [
      // Same pose as the manual +35° fixture above: the calibrated sensor
      // heading must produce the same -35° plane and observer camera.
      ['parity', [35, 90, 0]],
      ['forward', [35, 70, 10]],
      ['mirror', [-35, 70, -10]],
      // Pure beta change must leave both the one-axis UI and the observer
      // camera neutral: the live preview intentionally ignores phone pitch.
      ['pitch', [0, 70, 0]],
      // This is a true local roll around the calibrated screen normal. It
      // must leave the horizontal heading and camera at neutral.
      ['roll', [90, 80, -90]],
      // Keep an alpha-only case as a separate non-zero yaw before reset.
      ['yaw', [10, 90, 0]],
      ['reset', calibration],
    ];
    for (const [name, reading] of sensorReadings) {
      const expectedPoseDirection = expectedRelativeForward(calibration, reading, screenAngle);
      const expectedYaw = expectedHorizontalYaw(calibration, reading, screenAngle);
      const compensationStrength = Number(compensationInput.value) / 100;
      const expectedPlane = rotationY(expectedYaw);
      // Only the horizontal relative heading drives the camera. In
      // particular, its y component must remain zero for every sensor pose.
      const expectedCamera = compensatedCamera(expectedYaw, 0,
        compensationStrength, expectedDistance);
      const expectedSignature = [...expectedPlane, ...expectedCamera];
      const expectedGeometryChange = lastExpectedSignature === null
        || maxDifference(expectedSignature, lastExpectedSignature) > 0.0001;
      const before = state.draws.length;
      dispatchOrientation(reading);
      if (expectedGeometryChange) {
        await waitFor(() => state.draws.length > before,
          `Sensor ${name}: orientation event caused no scene draw`);
        await wait(180);
        lastDraw = state.draws[state.draws.length - 1];
      } else {
        // Reuse the previous draw only when both plane and camera signatures
        // are unchanged. A camera-only pose must trigger a fresh scene draw.
        await wait(80);
        if (state.draws.length > before) lastDraw = state.draws[state.draws.length - 1];
      }
      const draw = lastDraw;
      if (!draw) throw new Error(`Sensor ${name}: no scene draw available`);
      const actualCameraError = maxDifference(draw.camera, expectedCamera);
      const expectedDirection = normalize(expectedCamera);
      const actualDirection = normalize(draw.camera);
      const directionError = maxDifference(actualDirection, expectedDirection);
      const actualYaw = yawDegrees(draw.rotation);
      const uiSingleAxisError = Math.max(
        Math.abs(draw.rotation[1]), Math.abs(draw.rotation[3]),
        Math.abs(draw.rotation[5]), Math.abs(draw.rotation[7]),
        Math.abs(draw.rotation[4] - 1),
        Math.abs(draw.rotation[0] - draw.rotation[8]),
        Math.abs(draw.rotation[2] + draw.rotation[6]),
      );
      const actualDistance = Math.hypot(...draw.camera);
      const distanceError = Math.abs(actualDistance - expectedDistance);

      if (name === 'roll') {
        if (Math.abs(expectedPoseDirection[0]) > 0.003 || Math.abs(expectedPoseDirection[1]) > 0.003
          || expectedPoseDirection[2] < 0.997 || Math.abs(expectedYaw) > 0.2) {
          throw new Error(`Sensor roll fixture is not a neutral +Z direction`);
        }
      }

      if (directionError > 0.015) {
        throw new Error(`Sensor ${name}: eye direction error ${directionError.toFixed(3)}`);
      }
      if (angularDifference(actualYaw, expectedYaw) > 1.5) {
        throw new Error(`Sensor ${name}: UI yaw ${actualYaw.toFixed(2)}° != ${expectedYaw.toFixed(2)}°`);
      }
      if (uiSingleAxisError > 0.003) {
        throw new Error(`Sensor ${name}: UI rotation contains pitch/roll (${uiSingleAxisError.toFixed(4)})`);
      }
      if (distanceError > Math.max(4, expectedDistance * 0.01)) {
        throw new Error(`Sensor ${name}: eye distance error ${distanceError.toFixed(2)}px`);
      }
      if (actualCameraError > 3) {
        throw new Error(`Sensor ${name}: compensated camera error ${actualCameraError.toFixed(2)}px`);
      }
      if (Math.abs(draw.camera[1]) > 0.01) {
        throw new Error(`Sensor ${name}: camera responded to phone pitch (${draw.camera[1].toFixed(3)}px)`);
      }
      if (name === 'parity') {
        const parityPlaneError = maxDifference(draw.rotation, manualParityDraw.rotation);
        const parityCameraError = maxDifference(draw.camera, manualParityDraw.camera);
        if (parityPlaneError > 0.003 || parityCameraError > 3) {
          throw new Error(`Sensor/manual parity mismatch (plane ${parityPlaneError.toFixed(4)}, camera ${parityCameraError.toFixed(2)}px)`);
        }
      }
      sensorResults.push({ name, reading, expectedDirection, actualDirection, directionError,
        expectedPoseDirection, expectedYaw, expectedPitch: 0, actualYaw, uiSingleAxisError,
        compensationStrength, expectedCamera, actualCamera: draw.camera, actualCameraError,
        expectedDistance, actualDistance, distanceError, expectedGeometryChange,
        manualParity: name === 'parity' });
      lastExpectedSignature = expectedSignature;
    }

    // Hold a non-zero left or right heading while changing only beta. The
    // relative forward vector can gain a vertical component, but its
    // horizontal heading must stay fixed; neither the plane nor the camera
    // may follow those pitch changes.
    const pitchInvariantResults: Record<string, unknown>[] = [];
    let pitchInvariantPreviousSignature = [...IDENTITY, 0, 0, expectedDistance];
    for (const yawSign of [35, -35]) {
      let baselinePlane: number[] | null = null;
      let baselineCamera: Vec3 | null = null;
      for (const beta of [55, 70, 90, 110, 125]) {
        const reading: [number, number, number] = [yawSign, beta, 0];
        const expectedYaw = expectedHorizontalYaw(calibration, reading, screenAngle);
        const expectedPlane = rotationY(expectedYaw);
        const expectedCamera = compensatedCamera(expectedYaw, 0,
          Number(compensationInput.value) / 100, expectedDistance);
        const expectedSignature = [...expectedPlane, ...expectedCamera];
        const expectedGeometryChange = maxDifference(expectedSignature, pitchInvariantPreviousSignature) > 0.0001;
        const before = state.draws.length;
        dispatchOrientation(reading);
        if (expectedGeometryChange) {
          await waitFor(() => state.draws.length > before,
            `Pitch invariance ${yawSign}/${beta}: orientation event caused no scene draw`);
          await wait(120);
        } else {
          await wait(80);
        }
        const draw = state.draws[state.draws.length - 1];
        const planeError = maxDifference(draw.rotation, expectedPlane);
        const cameraError = maxDifference(draw.camera, expectedCamera);
        const yawError = angularDifference(yawDegrees(draw.rotation), expectedYaw);
        if (planeError > 0.003 || cameraError > 3 || yawError > 1.5) {
          throw new Error(`Pitch invariance ${yawSign}/${beta}: changed pose (plane ${planeError.toFixed(4)}, camera ${cameraError.toFixed(2)}, yaw ${yawError.toFixed(2)}°)`);
        }
        if (Math.abs(draw.camera[1]) > 0.01) {
          throw new Error(`Pitch invariance ${yawSign}/${beta}: camera y changed to ${draw.camera[1].toFixed(3)}px`);
        }
        if (baselinePlane && maxDifference(draw.rotation, baselinePlane) > 0.003) {
          throw new Error(`Pitch invariance ${yawSign}/${beta}: plane changed while beta changed`);
        }
        if (baselineCamera && maxDifference(draw.camera, baselineCamera) > 3) {
          throw new Error(`Pitch invariance ${yawSign}/${beta}: camera changed while beta changed`);
        }
        if (Math.abs(Math.abs(expectedYaw) - 35) > 0.2) {
          throw new Error(`Pitch invariance ${yawSign}/${beta}: expected horizontal heading ${expectedYaw.toFixed(2)}°`);
        }
        baselinePlane = [...draw.rotation];
        baselineCamera = [...draw.camera];
        pitchInvariantPreviousSignature = expectedSignature;
        pitchInvariantResults.push({ yawSign, beta, expectedYaw, planeError, cameraError,
          cameraY: draw.camera[1], actualYaw: yawDegrees(draw.rotation) });
      }
    }

    // Hold one mixed sensor pose and vary only the stretch compensation. The
    // plane hinge is fixed, while the observer camera must move at 0%, 50%,
    // and 100%. Compensation must remain independent from the image angle.
    const sweepReading: [number, number, number] = [35, 70, 10];
    const sweepYaw = expectedHorizontalYaw(calibration, sweepReading, screenAngle);
    const sweepPlane = rotationY(sweepYaw);
    const stretchResults: Record<string, unknown>[] = [];
    let previousStretchCamera: Vec3 | null = null;
    dispatchOrientation(sweepReading);
    await waitFor(() => maxDifference(state.draws[state.draws.length - 1].rotation, sweepPlane) < 0.003,
      'Stretch sweep did not reach its held sensor pose');
    for (const value of [0, 50, 100]) {
      const before = state.draws.length;
      setRangeValue(frameWindow, compensationInput, value);
      await waitFor(() => compensationInput.value === String(value),
        `Stretch compensation slider did not accept ${value}%`);
      const expectedCamera = compensatedCamera(sweepYaw, 0, value / 100, expectedDistance);
      await waitFor(() => state.draws.length > before,
        `Stretch compensation ${value}% caused no scene draw`);
      await wait(120);
      const draw = state.draws[state.draws.length - 1];
      const planeError = maxDifference(draw.rotation, sweepPlane);
      const cameraError = maxDifference(draw.camera, expectedCamera);
      if (planeError > 0.003) {
        throw new Error(`Stretch compensation ${value}% changed the UI plane (${planeError.toFixed(4)})`);
      }
      if (cameraError > 3) {
        throw new Error(`Stretch compensation ${value}% camera error ${cameraError.toFixed(2)}px`);
      }
      if (previousStretchCamera && maxDifference(draw.camera, previousStretchCamera) < 3) {
        throw new Error(`Stretch compensation ${value}% did not change the camera pose`);
      }
      previousStretchCamera = [...draw.camera];
      stretchResults.push({ value, expectedCamera, actualCamera: draw.camera, planeError, cameraError });
    }

    const highAngleResults: Record<string, unknown>[] = [];
    for (const alpha of [-80, -70, 70, 80]) {
      const reading: [number, number, number] = [alpha, 90, 0];
      const yaw = expectedHorizontalYaw(calibration, reading, screenAngle);
      const expectedCamera = compensatedCamera(yaw, 0, 1, expectedDistance);
      const before = state.draws.length;
      dispatchOrientation(reading);
      await waitFor(() => state.draws.length > before,
        `High angle ${alpha}: orientation event caused no scene draw`);
      const draw = state.draws[state.draws.length - 1];
      const planeError = maxDifference(draw.rotation, rotationY(yaw));
      const cameraError = maxDifference(draw.camera, expectedCamera);
      if (planeError > 0.003 || cameraError > 3) {
        throw new Error(`High angle ${alpha}: linear compensation error (plane ${planeError}, camera ${cameraError})`);
      }
      highAngleResults.push({ alpha, camera: draw.camera, planeError, cameraError });
    }

    // Viewing distance calibration affects only the observer
    // radius. The one-axis plane must remain at the same yaw, and the same
    // camera model must be shared by manual and sensor poses.
    const calibrationResults: Record<string, unknown>[] = [];
    const calibrationReading: [number, number, number] = [35, 90, 0];
    const calibrationYaw = expectedHorizontalYaw(calibration, calibrationReading, screenAngle);
    const calibrationPlane = rotationY(calibrationYaw);
    const calibrationBefore = state.draws.length;
    dispatchOrientation(calibrationReading);
    await waitFor(() => state.draws.length > calibrationBefore,
      'Calibration baseline orientation caused no scene draw');
    await wait(120);
    const calibrationBaseline = state.draws[state.draws.length - 1];
    const calibrationBaselineError = maxDifference(calibrationBaseline.rotation, calibrationPlane);
    if (calibrationBaselineError > 0.003) {
      throw new Error(`Calibration baseline plane error ${calibrationBaselineError.toFixed(4)}`);
    }

    const captureCalibration = async (name: string, expectedRadius: number, before: number): Promise<void> => {
      await waitFor(() => state.draws.length > before,
        `Calibration ${name}: control caused no scene draw`);
      await wait(120);
      const draw = state.draws[state.draws.length - 1];
      const planeError = maxDifference(draw.rotation, calibrationBaseline.rotation);
      const expectedCamera = compensatedCamera(calibrationYaw, 0,
        Number(compensationInput.value) / 100, expectedRadius);
      const cameraError = maxDifference(draw.camera, expectedCamera);
      const radiusError = Math.abs(Math.hypot(...draw.camera) - expectedRadius);
      if (planeError > 0.003) {
        throw new Error(`Calibration ${name}: changed plane (${planeError.toFixed(4)})`);
      }
      if (cameraError > 3 || radiusError > Math.max(4, expectedRadius * 0.01)) {
        throw new Error(`Calibration ${name}: camera ${cameraError.toFixed(2)}px/radius ${radiusError.toFixed(2)}px`);
      }
      calibrationResults.push({ name, expectedRadius, planeError, cameraError, radiusError,
        actualCamera: draw.camera });
    };

    const changedDistance = 68;
    const distanceBefore = state.draws.length;
    setRangeValue(frameWindow, distanceInput, changedDistance);
    await waitFor(() => Math.abs(Number(distanceInput.value) - changedDistance) < 0.001,
      'Viewing distance slider did not accept calibration value');
    await captureCalibration('distance', changedDistance / screenShortCm
      * Math.min(canvas.clientWidth, canvas.clientHeight), distanceBefore);

    const restoreDistanceBefore = state.draws.length;
    setRangeValue(frameWindow, distanceInput, 40);
    await waitFor(() => distanceInput.value === '40',
      'Viewing distance slider did not restore 40cm');
    await waitFor(() => state.draws.length > restoreDistanceBefore,
      'Viewing distance restore caused no scene draw');
    await wait(120);

    // Returning to the calibrated pose must neutralise both the one-axis plane
    // and the observer camera, regardless of the current 100% compensation.
    const neutralBefore = state.draws.length;
    dispatchOrientation(calibration);
    await waitFor(() => state.draws.length > neutralBefore,
      'Sensor calibration reset caused no scene draw');
    await wait(120);
    const neutralDraw = state.draws[state.draws.length - 1];
    const neutralCamera: Vec3 = [0, 0, expectedDistance];
    const neutralCameraError = maxDifference(neutralDraw.camera, neutralCamera);
    const neutralPlaneError = maxDifference(neutralDraw.rotation, IDENTITY);
    if (neutralCameraError > 3 || neutralPlaneError > 0.003) {
      throw new Error(`Sensor reset did not return to neutral (camera ${neutralCameraError.toFixed(2)}px, plane ${neutralPlaneError.toFixed(4)})`);
    }

    const resetButton = frameDocument.querySelector<HTMLButtonElement>('.subtle-reset');
    if (!resetButton) throw new Error('Missing effect reset button');
    await checkPerspectiveControl('sensor');
    setRangeValue(frameWindow, perspectiveInput, 170);
    await waitFor(() => Math.abs(state.draws.at(-1)!.perspectiveStrength - 1.7) < 0.0001,
      'Far-side slider did not accept a custom value before reset');
    setRangeValue(frameWindow, compensationInput, 50);
    await waitFor(() => compensationInput.value === '50',
      'Stretch compensation slider did not accept 50% before reset');
    resetButton.click();
    await waitFor(() => compensationInput.value === '60' && distanceInput.value === '40'
      && perspectiveInput.value === '50' && Math.abs(state.draws.at(-1)!.perspectiveStrength - 0.5) < 0.0001,
      'Effect reset did not restore 60% compensation, 40cm distance and 50% far-side perspective');

    return { framed: results, orbit: orbitResults, immersiveManual: immersiveManualResults,
      sensor: sensorResults, pitchInvariant: pitchInvariantResults,
      stretch: stretchResults, calibration: calibrationResults, perspective: perspectiveResults,
      highAngle: highAngleResults, resetCompensation: Number(compensationInput.value),
      neutralCamera: neutralDraw.camera, neutralPlaneError };
  } finally {
    if (prototype && originalMatrix && originalUniform3f && originalDrawArrays) {
      prototype.uniformMatrix3fv = originalMatrix;
      prototype.uniform3f = originalUniform3f;
      prototype.drawArrays = originalDrawArrays;
    }
    iframe.remove();
  }
}
