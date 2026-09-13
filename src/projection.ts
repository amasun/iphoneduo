type Vector3 = [number, number, number];

function transform(rotation: readonly number[], point: Vector3): Vector3 {
  return [
    rotation[0] * point[0] + rotation[1] * point[1] + rotation[2] * point[2],
    rotation[3] * point[0] + rotation[4] * point[1] + rotation[5] * point[2],
    rotation[6] * point[0] + rotation[7] * point[1] + rotation[8] * point[2],
  ];
}

/** Map the texture uniformly onto a screen-sized, rigid plane. */
export function layoutScene(
  width: number, height: number, imageWidth: number, imageHeight: number,
  viewerRotation: readonly number[], perspective: number,
) {
  // Cover affects texture framing only. The plane stays exactly screen-sized
  // at every angle, so its entire hinge edge stays on the physical edge.
  // Pixels beyond the aperture are clipped instead of shrinking the plane.
  const fit = Math.max(width / imageWidth, height / imageHeight);
  // App supplies a partially compensated observer, independent of the plane.
  // Zero compensation leaves a fixed eye for natural foreshortening.
  // Never move the eye to force either projected edge back onto the aperture.
  // Keep the observer direction and distance coherent. The perspective
  // distance scales the complete camera vector, so the viewing angle remains
  // unchanged while the eye moves closer to or farther from the plane.
  const camera = transform(viewerRotation, [0, 0, perspective]);
  return {
    camera,
    imageSize: [imageWidth * fit, imageHeight * fit] as [number, number],
  };
}
