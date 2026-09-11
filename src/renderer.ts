/**
 * Dependency-free WebGL2 renderer for the screen-space "UI sinks behind the
 * glass" prototype.
 *
 * The public rotation is a row-major, plane-to-screen matrix. WebGL's matrix
 * upload API consumes column-major values, so the matrix is transposed once
 * on the CPU before upload. The scene pass uses the transpose of that
 * orthonormal matrix as its inverse when intersecting a camera ray with the
 * finite plane.
 */

import { MAX_BLUR } from './effect';
import { layoutScene } from './projection';

export interface RenderState {
  /** Row-major 3x3 plane-to-screen rotation. */
  rotation: number[];
  /** Screen edge used as the physical hinge; omission selects from yaw. */
  hinge?: "left" | "right";
  /** Row-major inverse physical phone rotation; eye stays fixed about screen center. */
  viewerRotation?: number[];
  /** Gaussian radius in CSS pixels; cap scales with screen width (120 at 390). */
  blur: number;
  /** 0..1, darkens defocused regions of the composed scene; sharp hinge stays bright. */
  dim: number;
  /** CSS pixels from the camera to the neutral plane. */
  perspective: number;
}

export interface Renderer {
  render(state: RenderState): void;
  resize(): void;
  dispose(): void;
}

const IDENTITY_ROTATION = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const SCENE_VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const POST_VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SCENE_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_canvasSize;
uniform vec2 u_imageSize;
uniform vec3 u_cameraPosition;
uniform float u_devicePixelRatio;
uniform float u_hingeSide;
uniform mat3 u_rotation;

out vec4 outColor;

// The scene texture is full resolution and already contains the neutral dark
// space around the finite plane. The later blur pass samples this texture, so
// the wallpaper edge is not a filtering boundary.
vec2 planeToUv(vec2 localPosition, vec2 displayedImageSize) {
  // The plane's +y axis points up. UNPACK_FLIP_Y_WEBGL makes v=0 the bottom
  // of the uploaded image, preserving the source wallpaper orientation.
  // Keep the source's top visible when cover makes it taller than the screen.
  // Crop the excess below the aperture, without scaling either axis alone.
  vec2 imageCenter = vec2(0.0, (u_canvasSize.y - displayedImageSize.y) * 0.5);
  return (localPosition - imageCenter + displayedImageSize * 0.5) / displayedImageSize;
}

vec3 cavityColor(vec2 screenPosition, float validIntersection,
                 float rectangleDistance, vec3 planeNormal) {
  // A restrained neutral cavity provides edge light without a colored flare.
  float edgeWidth = clamp(min(u_canvasSize.x, u_canvasSize.y) * 0.018, 5.0, 18.0);
  float edgeLight = exp(-max(rectangleDistance, 0.0) / edgeWidth);
  vec3 lightDirection = normalize(vec3(-0.28, 0.32, 1.0));
  float grazing = 0.5 + 0.5 * dot(normalize(planeNormal), lightDirection);
  float cavityVignette = 1.0 - smoothstep(min(u_canvasSize.x, u_canvasSize.y) * 0.35,
                                          max(u_canvasSize.x, u_canvasSize.y) * 0.72,
                                          length(screenPosition));
  float brightness = 0.009 + 0.035 * edgeLight * (0.55 + 0.45 * grazing);
  brightness *= 0.72 + 0.28 * cavityVignette;
  brightness *= 0.85 + 0.15 * validIntersection;
  return vec3(brightness * 0.92, brightness * 0.96, brightness);
}

void main() {
  // gl_FragCoord is in physical pixels; all geometry and blur controls are
  // expressed in CSS pixels, so DPR is applied exactly once here and in the
  // post-process texel conversion.
  vec2 cssPixel = gl_FragCoord.xy / max(u_devicePixelRatio, 1.0);
  vec2 screenPosition = cssPixel - u_canvasSize * 0.5;
  float halfWidth = u_canvasSize.x * 0.5;

  // The content pivots about a screen edge; the physical phone and eye model
  // use the screen center. The rigid plane never shrinks to fit the aperture.
  vec3 hingePivot = vec3(u_hingeSide * halfWidth, 0.0, 0.0);
  vec3 cameraPosition = u_cameraPosition;
  vec3 rayDirection = vec3(screenPosition, 0.0) - cameraPosition;
  vec3 planeTranslation = hingePivot - u_rotation * hingePivot;

  // Intersect the screen ray with the rotated finite plane. For an
  // orthonormal rotation, transpose(u_rotation) is its inverse.
  vec3 planeNormal = u_rotation * vec3(0.0, 0.0, 1.0);
  float denominator = dot(planeNormal, rayDirection);
  float validDenominator = step(0.00001, abs(denominator));
  float rayDistance = dot(planeNormal, planeTranslation - cameraPosition)
                    / max(abs(denominator), 0.00001);
  rayDistance *= sign(denominator);
  vec3 worldPoint = cameraPosition + rayDistance * rayDirection;
  vec3 localPoint = transpose(u_rotation) * (worldPoint - planeTranslation);

  vec2 contentPoint = localPoint.xy;
  vec2 edgeDistance = abs(contentPoint) - u_canvasSize * 0.5;
  float rectangleDistance = max(edgeDistance.x, edgeDistance.y);
  float validRay = validDenominator * step(0.0, rayDistance);
  // Derivative-sized coverage avoids jagged projected plane edges while
  // keeping the physical edge sharp. The scene pass remains fully opaque.
  // Compute coverage per axis. Differentiating max(x,y) doubles the filter
  // width at neutral corners, leaving a dark rim on an otherwise full canvas.
  vec2 edgeAa = max(fwidth(contentPoint), vec2(0.0001));
  vec2 edgeCoverage = clamp(vec2(0.5) - edgeDistance / edgeAa, 0.0, 1.0);
  float insidePlane = validRay * min(edgeCoverage.x, edgeCoverage.y);

  vec2 uv = planeToUv(contentPoint, u_imageSize);
  // The source texture is mipmapped/aniso-filtered for clean minification.
  // Only the finite plane uses texture coordinates; the full scene canvas is
  // what the later Gaussian pass filters.
  vec3 wallpaper = texture(u_texture, clamp(uv, vec2(0.0), vec2(1.0))).rgb;

  vec3 cavity = cavityColor(screenPosition, validRay, rectangleDistance, planeNormal);
  outColor = vec4(mix(cavity, wallpaper, insidePlane), 1.0);
}
`;

const BLUR_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform sampler2D u_source;
uniform vec2 u_canvasSize;
uniform float u_devicePixelRatio;
uniform float u_blur;
uniform float u_dim;
uniform float u_hingeSide;
uniform int u_axis;

out vec4 outColor;

// 33 taps over +/- radius. Each sample prefilters an area as wide as its
// spacing using the scene's mip chain. Large radii therefore integrate fine
// text/edges continuously without spreading sparse sharp copies into stripes.
const int HALF_TAPS = 16;
const float INV_HALF_TAPS = 0.0625;

void main() {
  // Radius depends only on output screen x, so both separable passes use the
  // same field: horizontal samples move in x and vertical samples move in y.
  float distanceFromHinge = u_hingeSide < 0.0
                          ? v_uv.x * u_canvasSize.x
                          : (1.0 - v_uv.x) * u_canvasSize.x;
  float gradient = clamp(distanceFromHinge / max(u_canvasSize.x, 1.0), 0.0, 1.0);
  // Keep a narrow 1.5% focus strip at the physical hinge so small text right
  // on the fixed edge remains crisp while the rest of the plane rolls off.
  float focusGradient = smoothstep(0.015, 1.0, gradient);
  float radius = max(u_blur, 0.0) * focusGradient;

  // Zero blur is a true copy and avoids any quality change at neutral.
  if (radius <= 0.001) {
    outColor = textureLod(u_source, v_uv, 0.0);
    return;
  }

  float sigma = max(radius * 0.42, 0.35);
  // UV spans the full image regardless of its backing resolution. The radius
  // is in CSS pixels, so dividing by physical pixels would halve it at DPR 2.
  vec2 uvPerCssPixel = 1.0 / u_canvasSize;
  float sampleSpacing = radius * INV_HALF_TAPS * u_devicePixelRatio;
  float lod = max(0.0, log2(max(sampleSpacing, 1.0)));
  vec3 accumulated = vec3(0.0);
  float weightTotal = 0.0;

  for (int tap = -HALF_TAPS; tap <= HALF_TAPS; tap += 1) {
    float cssOffset = float(tap) * radius * INV_HALF_TAPS;
    float normalizedOffset = cssOffset / sigma;
    float weight = exp(-0.5 * normalizedOffset * normalizedOffset);
    vec2 uvOffset = u_axis == 0
                  ? vec2(cssOffset * uvPerCssPixel.x, 0.0)
                  : vec2(0.0, cssOffset * uvPerCssPixel.y);
    // Do not clamp to wallpaper UVs here. This samples the already-composed
    // scene (wallpaper + black cavity), allowing the image to diffuse into
    // that space. The scene texture's clamp-to-edge is only the final canvas
    // boundary condition.
    accumulated += textureLod(u_source, v_uv + uvOffset, lod).rgb * weight;
    weightTotal += weight;
  }

  vec3 color = accumulated / max(weightTotal, 0.0001);
  // Apply attenuation once, after both blur passes, to image AND cavity.
  // It follows the same focus field as blur and mirrors with the hinge.
  float darkness = u_axis == 1 ? clamp(u_dim, 0.0, 1.0) * focusGradient : 0.0;
  color *= exp(-2.3 * darkness);
  outColor = vec4(color, 1.0);
}
`;

type GL = WebGL2RenderingContext;

interface SceneUniforms {
  texture: WebGLUniformLocation | null;
  canvasSize: WebGLUniformLocation | null;
  imageSize: WebGLUniformLocation | null;
  cameraPosition: WebGLUniformLocation | null;
  devicePixelRatio: WebGLUniformLocation | null;
  hingeSide: WebGLUniformLocation | null;
  rotation: WebGLUniformLocation | null;
}

interface BlurUniforms {
  source: WebGLUniformLocation | null;
  canvasSize: WebGLUniformLocation | null;
  devicePixelRatio: WebGLUniformLocation | null;
  blur: WebGLUniformLocation | null;
  dim: WebGLUniformLocation | null;
  hingeSide: WebGLUniformLocation | null;
  axis: WebGLUniformLocation | null;
}

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

function identityState(): RenderState {
  return {
    rotation: IDENTITY_ROTATION.slice(),
    hinge: "left",
    viewerRotation: IDENTITY_ROTATION.slice(),
    blur: 0,
    dim: 0,
    perspective: 720,
  };
}

function noopRenderer(): Renderer {
  return {
    render: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

function report(onError: (message: string) => void, message: string): void {
  try {
    onError(message);
  } catch {
    // An error callback must not make renderer cleanup fail.
  }
}

function compileShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl: GL, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to create WebGL program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "unknown program link error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function transposeRotation(rotation: number[]): Float32Array {
  const source = rotation.length >= 9 ? rotation : IDENTITY_ROTATION;
  const values = source.slice(0, 9).map((value) => Number.isFinite(value) ? value : 0);
  return new Float32Array([
    values[0], values[3], values[6],
    values[1], values[4], values[7],
    values[2], values[5], values[8],
  ]);
}

function resolveHingeSide(hinge: RenderState["hinge"], rotation: number[]): number {
  if (hinge === "right") return 1;
  if (hinge === "left") return -1;

  // For the Y-only correction used by the parent, row-major r02 is sin(yaw).
  // Positive correction uses the left edge; negative correction uses right.
  const yawSign = rotation.length >= 3 && Number.isFinite(rotation[2])
    ? rotation[2]
    : 0;
  return yawSign >= 0 ? -1 : 1;
}

function deleteRenderTarget(gl: GL, target: RenderTarget | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

function createRenderTarget(gl: GL, width: number, height: number): RenderTarget {
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  try {
    texture = gl.createTexture();
    framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Unable to allocate post-process framebuffer");

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Post-process framebuffer is incomplete");
    }

    return { framebuffer, texture, width, height };
  } catch (error) {
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    if (texture) gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}

/**
 * Create the renderer. No frame loop is installed: callers own sensor
 * cadence and call render() when a new state is available.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  imageUrl: string,
  onError: (message: string) => void,
): Renderer {
  let gl: GL | null = null;
  let sceneProgram: WebGLProgram | null = null;
  let blurProgram: WebGLProgram | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  let sceneUniforms: SceneUniforms | null = null;
  let blurUniforms: BlurUniforms | null = null;
  let sceneTarget: RenderTarget | null = null;
  let pingTarget: RenderTarget | null = null;
  let image: HTMLImageElement | null = null;
  let disposed = false;
  let contextLost = false;
  let cssWidth = 1;
  let cssHeight = 1;
  let devicePixelRatio = 1;
  let imageWidth = 1;
  let imageHeight = 1;
  let lastState = identityState();

  const contextLostListener = (event: Event): void => {
    event.preventDefault();
    contextLost = true;
    // Context-owned resources become invalid during loss. Drop their handles
    // so the restore path necessarily rebuilds every program, texture and FBO.
    texture = null;
    sceneTarget = null;
    pingTarget = null;
    sceneProgram = null;
    blurProgram = null;
    vertexBuffer = null;
    sceneUniforms = null;
    blurUniforms = null;
    report(onError, "WebGL context lost; renderer paused");
  };

  const contextRestoredListener = (): void => {
    if (disposed) return;
    contextLost = false;
    try {
      initializeGL();
      uploadImageIfReady();
      resizeInternal();
      draw(lastState);
      report(onError, "");
    } catch (error) {
      report(onError, `WebGL context restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  canvas.addEventListener("webglcontextlost", contextLostListener, false);
  canvas.addEventListener("webglcontextrestored", contextRestoredListener, false);

  function initializeGL(): void {
    if (disposed) return;
    gl = gl ?? canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is unavailable in this browser");

    const nextSceneProgram = createProgram(gl, SCENE_VERTEX_SHADER_SOURCE,
                                           SCENE_FRAGMENT_SHADER_SOURCE);
    let nextBlurProgram: WebGLProgram | null = null;
    let nextVertexBuffer: WebGLBuffer | null = null;
    try {
      nextBlurProgram = createProgram(gl, POST_VERTEX_SHADER_SOURCE,
                                      BLUR_FRAGMENT_SHADER_SOURCE);
      nextVertexBuffer = gl.createBuffer();
      if (!nextVertexBuffer) throw new Error("Unable to create WebGL vertex buffer");
      gl.bindBuffer(gl.ARRAY_BUFFER, nextVertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    } catch (error) {
      gl.deleteProgram(nextSceneProgram);
      if (nextBlurProgram) gl.deleteProgram(nextBlurProgram);
      if (nextVertexBuffer) gl.deleteBuffer(nextVertexBuffer);
      throw error;
    }

    if (sceneProgram) gl.deleteProgram(sceneProgram);
    if (blurProgram) gl.deleteProgram(blurProgram);
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    sceneProgram = nextSceneProgram;
    blurProgram = nextBlurProgram;
    vertexBuffer = nextVertexBuffer;

    sceneUniforms = {
      texture: gl.getUniformLocation(sceneProgram, "u_texture"),
      canvasSize: gl.getUniformLocation(sceneProgram, "u_canvasSize"),
      imageSize: gl.getUniformLocation(sceneProgram, "u_imageSize"),
      cameraPosition: gl.getUniformLocation(sceneProgram, "u_cameraPosition"),
      devicePixelRatio: gl.getUniformLocation(sceneProgram, "u_devicePixelRatio"),
      hingeSide: gl.getUniformLocation(sceneProgram, "u_hingeSide"),
      rotation: gl.getUniformLocation(sceneProgram, "u_rotation"),
    };
    blurUniforms = {
      source: gl.getUniformLocation(blurProgram, "u_source"),
      canvasSize: gl.getUniformLocation(blurProgram, "u_canvasSize"),
      devicePixelRatio: gl.getUniformLocation(blurProgram, "u_devicePixelRatio"),
      blur: gl.getUniformLocation(blurProgram, "u_blur"),
      dim: gl.getUniformLocation(blurProgram, "u_dim"),
      hingeSide: gl.getUniformLocation(blurProgram, "u_hingeSide"),
      axis: gl.getUniformLocation(blurProgram, "u_axis"),
    };
  }

  function uploadImageIfReady(): void {
    if (!gl || !image || !image.complete || image.naturalWidth <= 0) return;
    if (texture) gl.deleteTexture(texture);
    texture = gl.createTexture();
    if (!texture) throw new Error("Unable to create wallpaper texture");
    imageWidth = image.naturalWidth;
    imageHeight = image.naturalHeight;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic")
      || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    if (anisotropic) {
      const maxAnisotropy = gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
                       Math.min(4, maxAnisotropy || 1));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function resizeInternal(): void {
    if (!gl || disposed || contextLost) return;
    const nextWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const nextHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const windowDpr = typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
    const nextDpr = Math.min(2, Math.max(1, windowDpr));
    cssWidth = nextWidth;
    cssHeight = nextHeight;
    devicePixelRatio = nextDpr;
    const pixelWidth = Math.max(1, Math.round(cssWidth * devicePixelRatio));
    const pixelHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    gl.viewport(0, 0, pixelWidth, pixelHeight);

    if (sceneTarget?.width === pixelWidth && sceneTarget.height === pixelHeight
        && pingTarget?.width === pixelWidth && pingTarget.height === pixelHeight) {
      return;
    }

    let nextScene: RenderTarget | null = null;
    let nextPing: RenderTarget | null = null;
    try {
      nextScene = createRenderTarget(gl, pixelWidth, pixelHeight);
      nextPing = createRenderTarget(gl, pixelWidth, pixelHeight);
    } catch (error) {
      deleteRenderTarget(gl, nextScene);
      deleteRenderTarget(gl, nextPing);
      throw error;
    }
    deleteRenderTarget(gl, sceneTarget);
    deleteRenderTarget(gl, pingTarget);
    sceneTarget = nextScene;
    pingTarget = nextPing;
  }

  function bindFullscreen(program: WebGLProgram): void {
    if (!gl || !vertexBuffer) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  function drawScene(state: RenderState): void {
    if (!gl || !sceneProgram || !vertexBuffer || !texture || !sceneTarget || !sceneUniforms) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.framebuffer);
    gl.viewport(0, 0, sceneTarget.width, sceneTarget.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    bindFullscreen(sceneProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(sceneUniforms.texture, 0);
    gl.uniform2f(sceneUniforms.canvasSize, cssWidth, cssHeight);
    const hingeSide = resolveHingeSide(state.hinge, state.rotation);
    const layout = layoutScene(cssWidth, cssHeight, imageWidth, imageHeight,
      state.viewerRotation ?? IDENTITY_ROTATION,
      Math.max(1, Number.isFinite(state.perspective) ? state.perspective : 1950));
    gl.uniform2f(sceneUniforms.imageSize, ...layout.imageSize);
    gl.uniform3f(sceneUniforms.cameraPosition, ...layout.camera);
    gl.uniform1f(sceneUniforms.devicePixelRatio, devicePixelRatio);
    gl.uniform1f(sceneUniforms.hingeSide, hingeSide);
    gl.uniformMatrix3fv(sceneUniforms.rotation, false, transposeRotation(state.rotation));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function drawPost(source: WebGLTexture, target: WebGLFramebuffer | null,
                    axis: 0 | 1, blur: number): void {
    if (!gl || !blurProgram || !vertexBuffer || !blurUniforms) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, Math.max(1, Math.round(cssWidth * devicePixelRatio)),
                Math.max(1, Math.round(cssHeight * devicePixelRatio)));
    bindFullscreen(blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(blurUniforms.source, 0);
    gl.uniform2f(blurUniforms.canvasSize, cssWidth, cssHeight);
    gl.uniform1f(blurUniforms.devicePixelRatio, devicePixelRatio);
    gl.uniform1f(blurUniforms.blur, blur);
    gl.uniform1f(blurUniforms.dim, Math.min(1, Math.max(0,
      Number.isFinite(lastState.dim) ? lastState.dim : 0)));
    gl.uniform1f(blurUniforms.hingeSide, resolveHingeSide(lastState.hinge, lastState.rotation));
    gl.uniform1i(blurUniforms.axis, axis);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function presentWithoutBlur(source: RenderTarget): void {
    // A fullscreen copy avoids blitting into a multisampled default
    // framebuffer, which is invalid on Safari/WebGL when the scene FBO is
    // single-sampled. The blur shader's zero-radius branch performs no
    // convolution and preserves neutral pixels.
    drawPost(source.texture, null, 0, 0);
    if (gl) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function draw(state: RenderState): void {
    if (!gl || !sceneProgram || !blurProgram || !sceneTarget || !pingTarget
        || !texture || contextLost || disposed) return;
    drawScene(state);
    const blur = Math.min(MAX_BLUR * cssWidth / 390, Math.max(0,
      Number.isFinite(state.blur) ? state.blur : 0));
    if (blur <= 0.001) {
      presentWithoutBlur(sceneTarget);
    } else {
      // Refresh prefiltered levels after each pass. Explicit LOD keeps the
      // focus strip at full resolution while large radii read smooth samples.
      // Unbind the source FBO before mip generation to avoid feedback hazards.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      drawPost(sceneTarget.texture, pingTarget.framebuffer, 0, blur);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, pingTarget.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      drawPost(pingTarget.texture, null, 1, blur);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  try {
    initializeGL();
    resizeInternal();
  } catch (error) {
    canvas.removeEventListener("webglcontextlost", contextLostListener, false);
    canvas.removeEventListener("webglcontextrestored", contextRestoredListener, false);
    const failedGl = gl as GL | null;
    if (failedGl) {
      deleteRenderTarget(failedGl, sceneTarget);
      deleteRenderTarget(failedGl, pingTarget);
      if (texture) failedGl.deleteTexture(texture);
      if (vertexBuffer) failedGl.deleteBuffer(vertexBuffer);
      if (sceneProgram) failedGl.deleteProgram(sceneProgram);
      if (blurProgram) failedGl.deleteProgram(blurProgram);
    }
    sceneTarget = null;
    pingTarget = null;
    texture = null;
    vertexBuffer = null;
    sceneProgram = null;
    blurProgram = null;
    sceneUniforms = null;
    blurUniforms = null;
    gl = null;
    report(onError, `Unable to initialize WebGL renderer: ${error instanceof Error ? error.message : String(error)}`);
    return noopRenderer();
  }

  image = new Image();
  image.decoding = "async";
  image.crossOrigin = "anonymous";
  image.onload = (): void => {
    if (disposed) return;
    try {
      uploadImageIfReady();
      draw(lastState);
    } catch (error) {
      report(onError, `Unable to load wallpaper texture: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  image.onerror = (): void => {
    if (!disposed) report(onError, `Unable to load wallpaper image: ${imageUrl}`);
  };
  image.src = imageUrl;

  return {
    render(state: RenderState): void {
      if (disposed) return;
      lastState = {
        rotation: Array.isArray(state.rotation) ? state.rotation.slice() : IDENTITY_ROTATION.slice(),
        hinge: state.hinge,
        viewerRotation: Array.isArray(state.viewerRotation)
          ? state.viewerRotation.slice()
          : IDENTITY_ROTATION.slice(),
        blur: state.blur,
        dim: state.dim,
        perspective: state.perspective,
      };
      const measuredWidth = canvas.clientWidth || canvas.width || 1;
      const measuredHeight = canvas.clientHeight || canvas.height || 1;
      if (Math.abs(measuredWidth - cssWidth) > 0.01
          || Math.abs(measuredHeight - cssHeight) > 0.01) {
        try {
          resizeInternal();
        } catch (error) {
          report(onError, `Unable to resize WebGL renderer: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      draw(lastState);
    },
    resize(): void {
      if (disposed || contextLost) return;
      try {
        resizeInternal();
        draw(lastState);
      } catch (error) {
        report(onError, `Unable to resize WebGL renderer: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", contextLostListener, false);
      canvas.removeEventListener("webglcontextrestored", contextRestoredListener, false);
      if (image) {
        image.onload = null;
        image.onerror = null;
        image.src = "";
      }
      if (gl) {
        deleteRenderTarget(gl, sceneTarget);
        deleteRenderTarget(gl, pingTarget);
        if (texture) gl.deleteTexture(texture);
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
        if (sceneProgram) gl.deleteProgram(sceneProgram);
        if (blurProgram) gl.deleteProgram(blurProgram);
      }
      image = null;
      sceneTarget = null;
      pingTarget = null;
      texture = null;
      vertexBuffer = null;
      sceneProgram = null;
      blurProgram = null;
      sceneUniforms = null;
      blurUniforms = null;
      gl = null;
    },
  };
}
