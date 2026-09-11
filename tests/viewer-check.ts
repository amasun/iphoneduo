import { createRenderer } from '../src/renderer';
import { axisRotation } from '../src/orientation';

type Vec3 = [number, number, number];

function transform(rotation: readonly number[], point: Vec3): Vec3 {
  return [
    rotation[0] * point[0] + rotation[1] * point[1] + rotation[2] * point[2],
    rotation[3] * point[0] + rotation[4] * point[1] + rotation[5] * point[2],
    rotation[6] * point[0] + rotation[7] * point[1] + rotation[8] * point[2],
  ];
}

function inverse(rotation: readonly number[]): number[] {
  return [
    rotation[0], rotation[3], rotation[6],
    rotation[1], rotation[4], rotation[7],
    rotation[2], rotation[5], rotation[8],
  ];
}

interface Layout {
  coverScale: number;
  pivotX: number;
  camera: Vec3;
}

function projectWorld(
  world: Vec3,
  camera: Vec3,
  width: number,
  height: number,
): [number, number] {
  const t = camera[2] / Math.max(camera[2] - world[2], 0.0001);
  return [width / 2 + camera[0] + (world[0] - camera[0]) * t,
    height / 2 + camera[1] + (world[1] - camera[1]) * t];
}

/** Independently model the fixed-size plane and cover texture. */
function layoutFor(
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  rotation: readonly number[],
  viewerRotation: readonly number[],
  hinge: 'left' | 'right',
  perspective: number,
): Layout {
  return {
    coverScale: Math.max(width / imageWidth, height / imageHeight),
    pivotX: (hinge === 'left' ? -1 : 1) * width / 2,
    camera: transform(viewerRotation, [0, 0, perspective]),
  };
}

/** Undo the physical phone rotation, then project from the fixed frontal eye. */
function recoverFrontalPoint(
  screenX: number,
  screenY: number,
  rotation: readonly number[],
  perspective: number,
): [number, number] {
  const phonePoint = transform(inverse(rotation), [screenX, screenY, 0]);
  const factor = perspective / Math.max(perspective - phonePoint[2], 0.0001);
  return [phonePoint[0] * factor, phonePoint[1] * factor];
}

interface Marker {
  x: number;
  y: number;
  half: number;
  color: string;
  channel: number;
}

function expectedRecoveredBounds(
  marker: Marker,
  sourceWidth: number,
  sourceHeight: number,
  layout: Layout,
  rotation: readonly number[],
  width: number,
  height: number,
  perspective: number,
): [number, number, number, number] {
  const points: Array<[number, number]> = [];
  const baseX = (marker.x - sourceWidth / 2) * layout.coverScale;
  const baseY = (sourceHeight / 2 - marker.y) * layout.coverScale;
  for (const dx of [-marker.half * layout.coverScale, marker.half * layout.coverScale]) {
    for (const dy of [-marker.half * layout.coverScale, marker.half * layout.coverScale]) {
      const localX = baseX + dx;
      const localY = baseY + dy;
      const delta = transform(rotation, [localX - layout.pivotX, localY, 0]);
      const world: Vec3 = [layout.pivotX + delta[0], delta[1], delta[2]];
      const screen = projectWorld(world, layout.camera, width, height);
      points.push(recoverFrontalPoint(screen[0] - width / 2, screen[1] - height / 2,
        rotation, perspective));
    }
  }
  return [Math.min(...points.map(point => point[0])),
    Math.max(...points.map(point => point[0])),
    Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[1]))];
}

/** Verify that a physical phone observer keeps screen UI square and frontal. */
export async function runViewerChecks() {
  const width = 390;
  const height = 844;
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const paint = source.getContext('2d')!;
  paint.fillStyle = '#e9ece4';
  paint.fillRect(0, 0, width, height);
  const markers: Marker[] = [
    { x: 75, y: 422, half: 24, color: '#ed3025', channel: 0 },
    { x: 195, y: 422, half: 24, color: '#2adc47', channel: 1 },
    { x: 315, y: 422, half: 24, color: '#3366ee', channel: 2 },
  ];
  for (const marker of markers) {
    paint.fillStyle = marker.color;
    paint.fillRect(marker.x - marker.half, marker.y - marker.half,
      marker.half * 2, marker.half * 2);
  }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:-1000px;top:0;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const errors: string[] = [];
  const renderer = createRenderer(canvas, source.toDataURL(), message => { if (message) errors.push(message); });
  const gl = canvas.getContext('webgl2')!;
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const results: Record<string, unknown>[] = [];
  try {
    let ready = false;
    const identity = axisRotation(0, 0);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(25);
      renderer.render({ rotation: identity, viewerRotation: identity, hinge: 'left',
        blur: 0, dim: 0, perspective: 1950 });
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (pixel[1] > 170 && pixel[0] < 80) { ready = true; break; }
    }
    assert(ready, `Viewer fixture failed to load: ${errors.join('; ')}`);

    const runs: Array<{ perspective: number; angles: number[] }> = [
      { perspective: 1950, angles: [0, 15, -15, 35, -35, 55, -55, 70, -70] },
      // A closer eye makes an incorrect camera hinge or stale angle gain visible.
      { perspective: 780, angles: [0, 35, -35, 70, -70] },
    ];
    for (const run of runs) {
      for (const angle of run.angles) {
        const rotation = axisRotation(0, angle);
        const hinge = angle >= 0 ? 'left' : 'right';
        renderer.render({ rotation, viewerRotation: rotation, hinge,
          blur: 0, dim: 0, perspective: run.perspective });
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const bounds = markers.map(() => ({
          minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, count: 0,
          recoveredMinX: Infinity, recoveredMinY: Infinity,
          recoveredMaxX: -Infinity, recoveredMaxY: -Infinity,
        }));
        const classify = (r: number, g: number, b: number): number => {
          if (r > 170 && g < 90 && b < 95) return 0;
          if (g > 150 && r < 90 && b < 120) return 1;
          if (b > 170 && r < 110 && g < 150) return 2;
          return -1;
        };
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            const channel = classify(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
            if (channel < 0) continue;
            const box = bounds[channel];
            box.minX = Math.min(box.minX, x);
            box.maxX = Math.max(box.maxX, x);
            box.minY = Math.min(box.minY, y);
            box.maxY = Math.max(box.maxY, y);
            box.count += 1;
            const screenX = (x + 0.5) * width / canvas.width - width / 2;
            const screenY = (y + 0.5) * height / canvas.height - height / 2;
            const recovered = recoverFrontalPoint(screenX, screenY, rotation, run.perspective);
            box.recoveredMinX = Math.min(box.recoveredMinX, recovered[0]);
            box.recoveredMaxX = Math.max(box.recoveredMaxX, recovered[0]);
            box.recoveredMinY = Math.min(box.recoveredMinY, recovered[1]);
            box.recoveredMaxY = Math.max(box.recoveredMaxY, recovered[1]);
          }
        }
        const layout = layoutFor(width, height, width, height, rotation, rotation,
          hinge, run.perspective);
        let maximumError = 0;
        let minimumRecoveredSize = Infinity;
        // The far-side markers may leave the fixed screen aperture at large
        // angles. Probe the marker nearest the physical hinge, which must stay
        // visible when the screen edge is retained by the fixed-size plane.
        const probeIndex = angle >= 0 ? 0 : 2;
        for (const marker of markers.filter(item => item.channel === probeIndex)) {
          const box = bounds[marker.channel];
          assert(box.maxX >= 0,
            `Missing ${marker.color} viewer marker at ${angle}°/${run.perspective}px`);
          const actual: [number, number, number, number] = [
            box.recoveredMinX, box.recoveredMaxX,
            box.recoveredMinY, box.recoveredMaxY,
          ];
          const expected = expectedRecoveredBounds(marker, width, height, layout,
            rotation, width, height, run.perspective);
          const error = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
          maximumError = Math.max(maximumError, error);
          assert(error < 3,
            `${angle}°/${run.perspective}px, marker ${marker.channel}: frontal recovery error ${error.toFixed(2)}px`);
          const recoveredWidth = actual[1] - actual[0];
          const recoveredHeight = actual[3] - actual[2];
          minimumRecoveredSize = Math.min(minimumRecoveredSize, recoveredWidth, recoveredHeight);
          assert(recoveredWidth > 4 && recoveredHeight > 4,
            `${angle}°/${run.perspective}px, marker ${marker.channel}: landmark was clipped`);
          const ratio = recoveredWidth / Math.max(recoveredHeight, 0.001);
          assert(ratio > 0.9 && ratio < 1.1,
            `${angle}°/${run.perspective}px, marker ${marker.channel}: recovered aspect ${ratio.toFixed(2)}`);
        }
        assert(gl.getError() === gl.NO_ERROR,
          `WebGL error during viewer regression at ${angle}°/${run.perspective}px`);
        results.push({ perspective: run.perspective, angle, probe: probeIndex,
          maximumError, minimumRecoveredSize });
      }
    }
    assert(errors.length === 0, errors.join('; '));
    return results;
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}
