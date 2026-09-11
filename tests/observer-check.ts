import { createRenderer } from '../src/renderer';
import { axisRotation } from '../src/orientation';

const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Check landmarks across the image against independent forward projection.
 * This catches an incorrect eye elevation that a single center-row probe misses.
 */
export async function runObserverChecks() {
  const width = 390;
  const height = 844;
  const half = 17;
  const colors = [
    [240, 40, 40], [40, 230, 40], [40, 40, 240],
    [240, 230, 40], [230, 40, 240], [40, 230, 240],
    [240, 140, 40], [140, 40, 240], [40, 140, 240],
  ];
  const markers = [100, 422, 744].flatMap((y, row) =>
    [50, 195, 340].map((x, column) => ({ x, y, color: colors[row * 3 + column], row, column })));
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const paint = source.getContext('2d')!;
  paint.fillStyle = '#555555';
  paint.fillRect(0, 0, width, height);
  for (const marker of markers) {
    paint.fillStyle = `rgb(${marker.color.join(',')})`;
    paint.fillRect(marker.x - half, marker.y - half, half * 2, half * 2);
  }
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:-1000px;top:0;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const errors: string[] = [];
  const renderer = createRenderer(canvas, source.toDataURL(), message => { if (message) errors.push(message); });
  const gl = canvas.getContext('webgl2')!;
  const results: { yaw: number; pitch: number; distance: number; checked: number; maxError: number }[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(25);
      renderer.render({ rotation: axisRotation(0, 0), blur: 0, dim: 0, perspective: 1950 });
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (pixel[0] > 200 && pixel[1] < 65 && pixel[2] > 200) { ready = true; break; }
    }
    assert(ready, `Observer fixture failed to load: ${errors.join('; ')}`);
    for (const distance of [1950, 780]) {
      for (const [yaw, pitch] of [[0, 0], [0, 25], [20, 15], [-20, -15], [35, -20], [-35, 20]]) {
        const label = `observer yaw=${yaw}, pitch=${pitch}, distance=${distance}`;
        const hinge = yaw >= 0 ? 'left' : 'right';
        renderer.render({ rotation: axisRotation(0, yaw), viewerRotation: axisRotation(pitch, yaw),
          hinge, blur: 0, dim: 0, perspective: distance });
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const bounds = markers.map(() => [Infinity, -Infinity, Infinity, -Infinity]);
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            const match = colors.findIndex(color => color.every((v, channel) => Math.abs(v - pixels[offset + channel]) < 22));
            if (match < 0) continue;
            const sx = (x + 0.5) * width / canvas.width;
            const sy = (y + 0.5) * height / canvas.height;
            const box = bounds[match];
            box[0] = Math.min(box[0], sx); box[1] = Math.max(box[1], sx);
            box[2] = Math.min(box[2], sy); box[3] = Math.max(box[3], sy);
          }
        }
        // Independent pinhole camera and rigid edge hinge, using scalar geometry.
        const a = yaw * Math.PI / 180;
        const b = pitch * Math.PI / 180;
        const eye = [Math.sin(a) * Math.cos(b) * distance, -Math.sin(b) * distance,
          Math.cos(a) * Math.cos(b) * distance];
        const pivot = hinge === 'left' ? -width / 2 : width / 2;
        let checked = 0;
        let maxError = 0;
        const rows = new Set<number>();
        for (const [index, marker] of markers.entries()) {
          const corners = [-half, half].flatMap(dx => [-half, half].map(dy => {
            const localX = marker.x + dx - width / 2;
            const localY = height / 2 - marker.y + dy;
            const wx = pivot + (localX - pivot) * Math.cos(a);
            const wz = -(localX - pivot) * Math.sin(a);
            const t = eye[2] / (eye[2] - wz);
            return [width / 2 + eye[0] + (wx - eye[0]) * t,
              height / 2 + eye[1] + (localY - eye[1]) * t];
          }));
          // Clipping at the real screen aperture is intentional; measure whole markers.
          if (!corners.every(([x, y]) => x > 2 && x < width - 2 && y > 2 && y < height - 2)) continue;
          const expected = [Math.min(...corners.map(p => p[0])), Math.max(...corners.map(p => p[0])),
            Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[1]))];
          const error = Math.max(...expected.map((value, axis) => Math.abs(value - bounds[index][axis])));
          assert(error < 2.5, `${label}, marker ${index}: projected boundary error ${error.toFixed(2)}px`);
          maxError = Math.max(maxError, error);
          checked += 1;
          rows.add(marker.row);
        }
        assert(checked >= 6 && rows.size === 3, `${label}: insufficient full-image coverage (${checked} markers/${rows.size} rows)`);
        assert(gl.getError() === gl.NO_ERROR, `${label}: WebGL error`);
        results.push({ yaw, pitch, distance, checked, maxError });
      }
    }
    assert(errors.length === 0, errors.join('; '));
    return results;
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}
