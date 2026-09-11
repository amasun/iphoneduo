import { createRenderer, type RenderState } from '../src/renderer';
import { axisRotation } from '../src/orientation';

type Vec3 = [number, number, number];
type Hinge = 'left' | 'right';
type Bounds = [number, number, number, number];

// Keep this intersection model independent from src/projection.ts and the
// renderer shader. A ray starts at the neutral-screen sample s and points to
// k*s - camera. k=0 is parallel projection; k=1 is the former camera ray.
function transform(rotation: readonly number[], point: Vec3): Vec3 {
  return [
    rotation[0] * point[0] + rotation[1] * point[1] + rotation[2] * point[2],
    rotation[3] * point[0] + rotation[4] * point[1] + rotation[5] * point[2],
    rotation[6] * point[0] + rotation[7] * point[1] + rotation[8] * point[2],
  ];
}

function sourceToWorld(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: readonly number[],
  hinge: Hinge,
): Vec3 {
  const pivotX = hinge === 'left' ? -width / 2 : width / 2;
  const local: Vec3 = [x - width / 2, height / 2 - y, 0];
  const delta = transform(rotation, [local[0] - pivotX, local[1], 0]);
  return [pivotX + delta[0], delta[1], delta[2]];
}

function projectWorld(
  world: Vec3,
  camera: Vec3,
  strength: number,
): [number, number] {
  // For the shader ray O=s, D=k*s-C, z gives t=-world.z/C.z. Solving the
  // x/y components gives s=(world+t*C)/(1+k*t).
  const t = -world[2] / Math.max(camera[2], 0.0001);
  const denominator = 1 + strength * t;
  return [
    (world[0] + t * camera[0]) / denominator,
    (world[1] + t * camera[1]) / denominator,
  ];
}

function markerBounds(
  marker: Marker,
  width: number,
  height: number,
  rotation: readonly number[],
  hinge: Hinge,
  strength: number,
  perspective: number,
): Bounds {
  const points: Array<[number, number]> = [];
  const camera: Vec3 = [0, 0, perspective];
  for (const dx of [-marker.half, marker.half]) {
    for (const dy of [-marker.half, marker.half]) {
      const world = sourceToWorld(marker.x + dx, marker.y - dy,
        width, height, rotation, hinge);
      points.push(projectWorld(world, camera, strength));
    }
  }
  return [
    Math.min(...points.map(point => point[0])),
    Math.max(...points.map(point => point[0])),
    Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[1])),
  ];
}

interface Marker {
  x: number;
  y: number;
  half: number;
  color: [number, number, number];
}

function colorDistance(
  r: number,
  g: number,
  b: number,
  color: readonly [number, number, number],
): number {
  return Math.hypot(r - color[0], g - color[1], b - color[2]);
}

function state(
  rotation: number[],
  hinge: Hinge,
  perspective: number,
  perspectiveStrength: number,
): RenderState {
  return {
    rotation,
    viewerRotation: axisRotation(0, 0),
    hinge,
    blur: 0,
    dim: 0,
    perspective,
    perspectiveStrength,
  };
}

/** Read only a predicted marker neighborhood, avoiding full-frame snapshots. */
function readMarkerBounds(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  expected: Bounds,
  marker: Marker,
): Bounds | null {
  const scaleX = canvas.width / width;
  const scaleY = canvas.height / height;
  // A wrong projection should fail with a useful missing-marker error while
  // allowing filtering and one-pixel rasterization differences.
  const margin = 9;
  const x0 = Math.max(0, Math.floor((width / 2 + expected[0] - margin) * scaleX));
  const x1 = Math.min(canvas.width,
    Math.ceil((width / 2 + expected[1] + margin) * scaleX));
  const y0 = Math.max(0, Math.floor((height / 2 + expected[2] - margin) * scaleY));
  const y1 = Math.min(canvas.height,
    Math.ceil((height / 2 + expected[3] + margin) * scaleY));
  if (x1 <= x0 || y1 <= y0) return null;

  const pixels = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
  gl.readPixels(x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < y1 - y0; y += 1) {
    for (let x = 0; x < x1 - x0; x += 1) {
      const offset = (y * (x1 - x0) + x) * 4;
      if (colorDistance(pixels[offset], pixels[offset + 1], pixels[offset + 2], marker.color) > 72) {
        continue;
      }
      const localX = (x0 + x + 0.5) / scaleX - width / 2;
      const localY = (y0 + y + 0.5) / scaleY - height / 2;
      minX = Math.min(minX, localX);
      maxX = Math.max(maxX, localX);
      minY = Math.min(minY, localY);
      maxY = Math.max(maxY, localY);
    }
  }
  return Number.isFinite(minX) ? [minX, maxX, minY, maxY] : null;
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Verify the adjustable perspective strength against an independent model. */
export async function runPerspectiveChecks() {
  const width = 320;
  const height = 480;
  const perspective = 800;
  const angle = 35;
  const strengths = [0, 0.5, 1, 2];
  const markers: Marker[] = [
    { x: 44, y: 240, half: 18, color: [239, 48, 42] },
    { x: 160, y: 240, half: 18, color: [42, 218, 71] },
    { x: 276, y: 240, half: 18, color: [51, 102, 238] },
  ];
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const paint = source.getContext('2d')!;
  paint.fillStyle = '#656565';
  paint.fillRect(0, 0, width, height);
  for (const marker of markers) {
    paint.fillStyle = `rgb(${marker.color.join(',')})`;
    paint.fillRect(marker.x - marker.half, marker.y - marker.half,
      marker.half * 2, marker.half * 2);
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:-1000px;top:0;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const errors: string[] = [];
  const renderer = createRenderer(canvas, source.toDataURL(), message => {
    if (message) errors.push(message);
  });
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Perspective fixture requires WebGL2');
  const results: Array<Record<string, unknown>> = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(25);
      renderer.render(state(axisRotation(0, 0), 'left', perspective, 0));
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (colorDistance(pixel[0], pixel[1], pixel[2], markers[1].color) < 72) {
        ready = true;
        break;
      }
    }
    assert(ready, `Perspective fixture failed to load: ${errors.join('; ')}`);

    for (const hinge of ['left', 'right'] as const) {
      const yaw = hinge === 'left' ? angle : -angle;
      const rotation = axisRotation(0, yaw);
      const farIndex = hinge === 'left' ? 2 : 0;
      const farHeights: number[] = [];
      for (const strength of strengths) {
        renderer.render(state(rotation, hinge, perspective, strength));
        const actualBounds: Bounds[] = [];
        for (const [index, marker] of markers.entries()) {
          const expected = markerBounds(marker, width, height, rotation, hinge,
            strength, perspective);
          const actual = readMarkerBounds(gl, canvas, width, height, expected, marker);
          if (!actual) {
            throw new Error(`${hinge}, k=${strength}: marker ${index} missing near predicted bounds`);
          }
          const error = Math.max(...actual.map((value, index2) =>
            Math.abs(value - expected[index2])));
          assert(error < 3.5,
            `${hinge}, k=${strength}, marker ${index}: projection error ${error.toFixed(2)}px`);
          actualBounds.push(actual);
        }
        const farHeight = actualBounds[farIndex][3] - actualBounds[farIndex][2];
        farHeights.push(farHeight);
        results.push({ hinge, strength, farHeight });
      }
      for (let index = 1; index < farHeights.length; index += 1) {
        assert(farHeights[index] < farHeights[index - 1] - 0.5,
          `${hinge}: far-side height did not decrease from k=${strengths[index - 1]} to k=${strengths[index]}`);
      }
    }

    // A frontal plane has z=0 everywhere, so changing k cannot alter it.
    const neutralBounds: Bounds[][] = [];
    for (const strength of strengths) {
      renderer.render(state(axisRotation(0, 0), 'left', perspective, strength));
      neutralBounds.push(markers.map((marker, index) => {
        const expected = markerBounds(marker, width, height, axisRotation(0, 0),
          'left', strength, perspective);
        const actual = readMarkerBounds(gl, canvas, width, height, expected, marker);
        if (!actual) throw new Error(`front-facing k=${strength}: marker ${index} missing`);
        const error = Math.max(...actual.map((value, axis) => Math.abs(value - expected[axis])));
        assert(error < 3.5, `front-facing k=${strength}, marker ${index}: error ${error.toFixed(2)}px`);
        return actual;
      }));
    }
    for (let strengthIndex = 1; strengthIndex < neutralBounds.length; strengthIndex += 1) {
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
        const previous = neutralBounds[strengthIndex - 1][markerIndex];
        const current = neutralBounds[strengthIndex][markerIndex];
        assert(Math.max(...current.map((value, axis) => Math.abs(value - previous[axis]))) < 1.5,
          `front-facing marker ${markerIndex} changed when k changed`);
      }
    }

    // resize() redraws the last state. Keep k=2 and a turned plane active
    // through the call, catching state loss that silently returns to k=1.
    const resizeRotation = axisRotation(0, angle);
    const resizeStrength = 2;
    renderer.render(state(resizeRotation, 'left', perspective, resizeStrength));
    const resizeExpected = markerBounds(markers[2], width, height, resizeRotation,
      'left', resizeStrength, perspective);
    const beforeResize = readMarkerBounds(gl, canvas, width, height, resizeExpected, markers[2]);
    if (!beforeResize) throw new Error('resize state fixture missing far marker before resize');
    renderer.resize();
    const afterResize = readMarkerBounds(gl, canvas, width, height, resizeExpected, markers[2]);
    if (!afterResize) throw new Error('resize state fixture missing far marker after resize');
    const resizeError = Math.max(...afterResize.map((value, axis) =>
      Math.abs(value - resizeExpected[axis])));
    assert(resizeError < 3.5, `resize lost perspective strength state: error ${resizeError.toFixed(2)}px`);
    results.push({ resizePreserved: true, resizeError });

    assert(gl.getError() === gl.NO_ERROR, 'WebGL error during perspective strength checks');
    assert(errors.length === 0, errors.join('; '));
    return results;
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}
