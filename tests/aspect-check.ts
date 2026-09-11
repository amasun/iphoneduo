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

interface Layout {
  coverScale: number;
  imageCenterY: number;
  pivotX: number;
  camera: Vec3;
}

/** Independent cover + fixed-size hinge model used only by this regression. */
function layoutFor(
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  hinge: 'left' | 'right',
  perspective: number,
): Layout {
  const coverScale = Math.max(width / imageWidth, height / imageHeight);
  return {
    coverScale,
    imageCenterY: (height - imageHeight * coverScale) / 2,
    pivotX: (hinge === 'left' ? -1 : 1) * width / 2,
    camera: [0, 0, perspective],
  };
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

interface Marker {
  x: number;
  y: number;
  half: number;
  color: string;
  channel: number;
}

function markerBounds(
  marker: Marker,
  sourceWidth: number,
  sourceHeight: number,
  layout: Layout,
  rotation: readonly number[],
  width: number,
  height: number,
): [number, number, number, number] {
  const points: Array<[number, number]> = [];
  const baseX = (marker.x - sourceWidth / 2) * layout.coverScale;
  const baseY = layout.imageCenterY + (sourceHeight / 2 - marker.y) * layout.coverScale;
  for (const dx of [-marker.half * layout.coverScale, marker.half * layout.coverScale]) {
    for (const dy of [-marker.half * layout.coverScale, marker.half * layout.coverScale]) {
      const delta = transform(rotation, [baseX + dx - layout.pivotX, baseY + dy, 0]);
      const world: Vec3 = [layout.pivotX + delta[0], delta[1], delta[2]];
      points.push(projectWorld(world, layout.camera, width, height));
    }
  }
  return [Math.min(...points.map(point => point[0])),
    Math.max(...points.map(point => point[0])),
    Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[1]))];
}

function colourDistance(r: number, g: number, b: number, colour: [number, number, number]): number {
  return Math.hypot(r - colour[0], g - colour[1], b - colour[2]);
}

/** Compare GPU landmarks against an independent fixed-plane cover projection. */
export async function runAspectChecks() {
  const sourceWidth = 300;
  const sourceHeight = 600;
  // Yellow and magenta stay outside the red/green/blue landmark classifiers
  // even after the renderer's linear edge filtering.
  const leftEdge: [number, number, number] = [238, 206, 70];
  const rightEdge: [number, number, number] = [220, 70, 190];
  const topBadge: [number, number, number] = [34, 47, 101];
  const createFixture = (markerY: number) => {
    const source = document.createElement('canvas');
    source.width = sourceWidth;
    source.height = sourceHeight;
    const paint = source.getContext('2d')!;
    paint.fillStyle = '#eee';
    paint.fillRect(0, 0, sourceWidth, sourceHeight);
    const markers: Marker[] = [
      { x: 100, y: markerY, half: 20, color: '#ed3025', channel: 0 },
      { x: 150, y: markerY, half: 20, color: '#2adc47', channel: 1 },
      { x: 200, y: markerY, half: 20, color: '#3366ee', channel: 2 },
    ];
    for (const marker of markers) {
      paint.fillStyle = marker.color;
      paint.fillRect(marker.x - marker.half, marker.y - marker.half,
        marker.half * 2, marker.half * 2);
    }
    // These full-height strips make an anchored image edge observable even
    // when the plane is rotated.
    paint.fillStyle = `rgb(${leftEdge.join(',')})`;
    paint.fillRect(0, 0, 18, sourceHeight);
    paint.fillStyle = `rgb(${rightEdge.join(',')})`;
    paint.fillRect(sourceWidth - 18, 0, 18, sourceHeight);
    // The top badge catches a regression that centers a taller cover image,
    // which would crop the source's top rows in a wide viewport.
    paint.fillStyle = `rgb(${topBadge.join(',')})`;
    paint.fillRect(sourceWidth / 2 - 12, 20, 24, 24);
    return { source, markers };
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:-1000px;top:0;width:300px;height:600px';
  document.body.append(canvas);
  const errors: string[] = [];
  const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const results: Record<string, unknown>[] = [];
  try {
    for (const [width, height] of [[300, 600], [390, 664], [393, 852], [844, 390]]) {
      // The landscape aperture crops the bottom of the cover image, so use a
      // source row that is actually inside the top-aligned image for that
      // viewport instead of silently skipping the geometry check.
      const markerY = height <= 500 ? 90 : 300;
      const { source, markers } = createFixture(markerY);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const renderer = createRenderer(canvas, source.toDataURL(), message => { if (message) errors.push(message); });
      const gl = canvas.getContext('webgl2')!;
      try {
      renderer.resize();
      const perspective = 850 * width / 390;
      const coverScale = Math.max(width / sourceWidth, height / sourceHeight);
      const imageCenterY = (height - sourceHeight * coverScale) / 2;
      const markerScreenY = height / 2 + imageCenterY
        + (sourceHeight / 2 - markerY) * coverScale;
      const draw = (angle: number) => renderer.render({
        rotation: axisRotation(0, angle),
        viewerRotation: axisRotation(0, 0),
        hinge: angle >= 0 ? 'left' : 'right',
        perspective,
        blur: 0,
        dim: 0,
      });
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await wait(25);
        draw(0);
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.floor(canvas.width / 2),
          Math.min(canvas.height - 1, Math.max(0, Math.floor(markerScreenY * canvas.height / height))), 1, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (pixel[1] > 170 && pixel[0] < 80) { ready = true; break; }
      }
      assert(ready, `Aspect fixture failed to load: ${errors.join('; ')}`);

      const readCssPixel = (pixels: Uint8Array, x: number, y: number): [number, number, number] => {
        const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(x * canvas.width / width)));
        const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(y * canvas.height / height)));
        const offset = (py * canvas.width + px) * 4;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      };

      for (const angle of [0, 30, -30, 45, -45, 55, -55]) {
        draw(angle);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const bounds = markers.map(() => ({
          minX: Infinity, minY: Infinity, maxX: -1, maxY: -1,
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
          }
        }

        const rotation = axisRotation(0, angle);
        const hinge = angle >= 0 ? 'left' : 'right';
        const layout = layoutFor(width, height, sourceWidth, sourceHeight, hinge, perspective);
        let maximumError = 0;
        for (const marker of markers) {
          const box = bounds[marker.channel];
          assert(box.maxX >= 0, `Missing ${marker.color} marker at ${width}×${height}, ${angle}°`);
          const actual: [number, number, number, number] = [
            box.minX * width / canvas.width,
            (box.maxX + 1) * width / canvas.width,
            box.minY * height / canvas.height,
            (box.maxY + 1) * height / canvas.height,
          ];
          const expected = markerBounds(marker, sourceWidth, sourceHeight, layout,
            rotation, width, height);
          const error = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
          maximumError = Math.max(maximumError, error);
          assert(error < 2.5,
            `${width}×${height}, ${angle}°, marker ${marker.channel}: cover projection error ${error.toFixed(2)} CSS px`);
          const ratio = (actual[1] - actual[0]) / Math.max(actual[3] - actual[2], 0.001);
          // A fixed observer sees perspective foreshortening; only prevent
          // horizontal widening, while viewer recovery checks frontal squares.
          assert(ratio <= 1.08,
            `${width}×${height}, ${angle}°: cover marker widened to ${ratio.toFixed(2)}`);
        }

        const edgeX = angle >= 0 ? 1 : width - 2;
        const expectedEdge = angle >= 0 ? leftEdge : rightEdge;
        let minimumEdgeBrightness = Infinity;
        let maximumEdgeDistance = 0;
        for (const y of [2, Math.round(height * 0.25), Math.round(height * 0.5),
          Math.round(height * 0.75), height - 3]) {
          const [r, g, b] = readCssPixel(pixels, edgeX, y);
          minimumEdgeBrightness = Math.min(minimumEdgeBrightness, (r + g + b) / 3);
          maximumEdgeDistance = Math.max(maximumEdgeDistance, colourDistance(r, g, b, expectedEdge));
        }
        assert(minimumEdgeBrightness > 65 && maximumEdgeDistance < 175,
          `${width}×${height}, ${angle}°: hinge edge lost its image from top to bottom`);

        if (angle !== 0 && Math.abs(angle) >= 30) {
          // The opposite edge must retreat into the aperture as the rigid
          // plane turns. Sample one CSS pixel inside the source strip at its
          // independently projected position, then sample the former canvas
          // boundary where the cavity should now be exposed.
          const farSign = angle >= 0 ? 1 : -1;
          const farLocalX = farSign * (width / 2 - 1);
          const farDelta = transform(rotation, [farLocalX - layout.pivotX, 0, 0]);
          const farWorld: Vec3 = [layout.pivotX + farDelta[0], farDelta[1], farDelta[2]];
          const farProjectedX = projectWorld(farWorld, layout.camera, width, height)[0];
          const inwardDistance = farSign > 0 ? width - farProjectedX : farProjectedX;
          assert(inwardDistance > 5,
            `${width}×${height}, ${angle}°: far edge did not naturally retreat (${inwardDistance.toFixed(2)}px)`);

          const farExpectedEdge = farSign > 0 ? rightEdge : leftEdge;
          let farStripBrightness = 0;
          let farStripDistance = Infinity;
          for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
            for (const y of [Math.round(height * 0.25), Math.round(height * 0.5),
              Math.round(height * 0.75)]) {
              const [r, g, b] = readCssPixel(pixels, farProjectedX + offset, y);
              farStripBrightness = Math.max(farStripBrightness, (r + g + b) / 3);
              farStripDistance = Math.min(farStripDistance,
                colourDistance(r, g, b, farExpectedEdge));
            }
          }
          assert(farStripBrightness > 65 && farStripDistance < 175,
            `${width}×${height}, ${angle}°: projected far edge lost its source strip`);

          const cavityX = farSign > 0 ? width - 1 : 0;
          let maximumCavityBrightness = 0;
          for (const y of [Math.round(height * 0.25), Math.round(height * 0.5),
            Math.round(height * 0.75)]) {
            const [r, g, b] = readCssPixel(pixels, cavityX, y);
            maximumCavityBrightness = Math.max(maximumCavityBrightness, (r + g + b) / 3);
          }
          assert(maximumCavityBrightness < 65,
            `${width}×${height}, ${angle}°: far-side outer cavity was not exposed`);
          results.push({
            viewport: [width, height], angle, farEdgeInward: inwardDistance,
            farStripDistance, outerCavityBrightness: maximumCavityBrightness,
          });
        }

        if (angle === 0) {
          const topBadgeY = height / 2 + imageCenterY
            + (sourceHeight / 2 - 32) * coverScale;
          const [badgeR, badgeG, badgeB] = readCssPixel(pixels, width / 2, topBadgeY);
          assert(colourDistance(badgeR, badgeG, badgeB, topBadge) < 30,
            `${width}×${height}: top-aligned cover cropped the source top badge`);
          let minimumNeutralBrightness = Infinity;
          for (const x of [0, width - 1]) {
            for (const y of [0, 1, Math.round(height * 0.25), Math.round(height * 0.5),
              Math.round(height * 0.75), height - 2, height - 1]) {
              const [r, g, b] = readCssPixel(pixels, x, y);
              minimumNeutralBrightness = Math.min(minimumNeutralBrightness, (r + g + b) / 3);
            }
          }
          for (const y of [0, height - 1]) {
            for (const x of [0, 1, Math.round(width * 0.25), Math.round(width * 0.5),
              Math.round(width * 0.75), width - 2, width - 1]) {
              const [r, g, b] = readCssPixel(pixels, x, y);
              minimumNeutralBrightness = Math.min(minimumNeutralBrightness, (r + g + b) / 3);
            }
          }
          assert(minimumNeutralBrightness > 80,
            `${width}×${height}: neutral cover left a black border or cavity`);
        }

        results.push({
          viewport: [width, height],
          angle,
          maxProjectionError: maximumError,
          coverScale: layout.coverScale,
          fixedPlane: [width, height],
        });
      }
      assert(gl.getError() === gl.NO_ERROR, 'WebGL error during cover aspect regression');
      } finally {
        renderer.dispose();
      }
    }
    assert(errors.length === 0, errors.join('; '));
    return results;
  } finally {
    canvas.remove();
  }
}
