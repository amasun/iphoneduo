import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * The pose is a row-major, active rotation in the same screen coordinate
 * system used by the existing compositor. The model is normalised so its
 * screen faces +Z and its screen centre is the origin before this rotation.
 */
export interface PhoneModelView {
  rotation: readonly number[];
  perspective: number;
  screenRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface PhoneModelRendererCallbacks {
  onReady: (layout: { screenAspect: number }) => void;
  onError: (message: string) => void;
}

export interface PhoneModelRenderer {
  /** Update the camera, pose and viewport. This method never draws. */
  setView: (view: PhoneModelView) => void;
  /** Upload the current source canvas and draw the model immediately. */
  updateScreen: () => void;
  dispose: () => void;
}

const MODEL_FRONT_ORIENTATION = new THREE.Matrix4().set(
  // Imported model axes: X is thickness, Y is long edge, Z is short edge.
  // The source model's front is -X. Map (Z, Y, -X) to (screen X, Y, +Z).
  0, 0, 1, 0,
  0, 1, 0, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1,
);

const DEFAULT_VIEW: PhoneModelView = {
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  perspective: 640,
  screenRect: { left: 0, top: 0, width: 1, height: 1 },
};

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function finiteRotation(rotation: readonly number[]): number[] {
  if (rotation.length < 9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const values = rotation.slice(0, 9).map((value) => finite(value, 0));
  // A malformed sensor matrix should not make the model disappear. The
  // normal orientation is preferred when the supplied matrix is singular.
  const determinant = values[0] * (values[4] * values[8] - values[5] * values[7])
    - values[1] * (values[3] * values[8] - values[5] * values[6])
    + values[2] * (values[3] * values[7] - values[4] * values[6]);
  if (Math.abs(determinant) < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return values;
}

function rotationMatrix(rotation: readonly number[]): THREE.Matrix4 {
  const r = finiteRotation(rotation);
  // Matrix4.set accepts values in row-major order. This preserves the public
  // row-major convention without silently transposing the pose.
  return new THREE.Matrix4().set(
    r[0], r[1], r[2], 0,
    r[3], r[4], r[5], 0,
    r[6], r[7], r[8], 0,
    0, 0, 0, 1,
  );
}

function cssSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const width = finite(rect.width, 0) || finite(canvas.clientWidth, 0) || 1;
  const height = finite(rect.height, 0) || finite(canvas.clientHeight, 0) || 1;
  return { width: Math.max(width, 1), height: Math.max(height, 1) };
}

function disposeMaterialResources(material: THREE.Material, textures: Set<THREE.Texture>): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value instanceof THREE.Texture) textures.add(value);
  }
  material.dispose();
}

function disposeObjectResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material);
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) disposeMaterialResources(material, textures);
  for (const texture of textures) texture.dispose();
}

function disposeEnvironment(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function reportError(callbacks: PhoneModelRendererCallbacks, canvas: HTMLCanvasElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || '未知模型加载错误');
  canvas.dataset.modelState = 'error';
  try { callbacks.onError(`手机模型加载失败：${message}`); } catch { /* Callback errors must not break cleanup. */ }
}

/**
 * Create the transparent Three.js model layer.
 *
 * The imported GLTF scene is retained as-is. In particular, its materials
 * are never cloned or replaced; the only new material is the separate screen
 * canvas layer, which is placed just in front of the source screen mesh.
 */
export function createPhoneModelRenderer(
  canvas: HTMLCanvasElement,
  screenCanvas: HTMLCanvasElement,
  modelUrl: string,
  callbacks: PhoneModelRendererCallbacks,
): PhoneModelRenderer {
  canvas.dataset.modelState = 'loading';

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
  } catch (error) {
    reportError(callbacks, canvas, error);
    return { setView: () => undefined, updateScreen: () => undefined, dispose: () => undefined };
  }

  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100000);
  camera.position.set(0, 0, DEFAULT_VIEW.perspective);
  camera.lookAt(0, 0, 0);

  const fillLight = new THREE.HemisphereLight(0xf7f8ff, 0x22251f, 1.1);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(-320, 420, 680);
  const rimLight = new THREE.DirectionalLight(0xb8cbff, 0.75);
  rimLight.position.set(360, 100, -300);
  scene.add(fillLight, keyLight, rimLight);

  let environmentScene: RoomEnvironment | null = null;
  let pmremGenerator: THREE.PMREMGenerator | null = null;
  let environmentTarget: THREE.WebGLRenderTarget | null = null;
  try {
    environmentScene = new RoomEnvironment();
    pmremGenerator = new THREE.PMREMGenerator(renderer);
    environmentTarget = pmremGenerator.fromScene(environmentScene);
    scene.environment = environmentTarget.texture;
    environmentScene.visible = false;
  } catch {
    // Direct lights remain sufficient on devices that cannot build PMREM.
    environmentScene = null;
    pmremGenerator?.dispose();
    pmremGenerator = null;
  }

  const modelRoot = new THREE.Group();
  modelRoot.name = 'PhoneModelPose';
  modelRoot.matrixAutoUpdate = false;
  scene.add(modelRoot);

  let contentRoot: THREE.Group | null = null;
  let modelScene: THREE.Object3D | null = null;
  let screenOverlay: THREE.Mesh | null = null;
  let screenTexture: THREE.CanvasTexture | null = null;
  let textureWidth = 0;
  let textureHeight = 0;
  let screenMaterial: THREE.MeshBasicMaterial | null = null;
  let screenWorldWidth = 1;
  let screenWorldHeight = 1;
  let screenAspect = 1;
  let ready = false;
  let disposed = false;
  let currentView: PhoneModelView = DEFAULT_VIEW;
  let contextLost = false;
  let rendererWidth = 0;
  let rendererHeight = 0;
  let rendererPixelRatio = 0;

  const createScreenTexture = (): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(screenCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    textureWidth = screenCanvas.width;
    textureHeight = screenCanvas.height;
    return texture;
  };

  const resize = (): { width: number; height: number } => {
    const size = cssSize(canvas);
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    if (size.width !== rendererWidth || size.height !== rendererHeight || pixelRatio !== rendererPixelRatio) {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(size.width, size.height, false);
      rendererWidth = size.width;
      rendererHeight = size.height;
      rendererPixelRatio = pixelRatio;
    }
    return size;
  };

  const applyView = (view: PhoneModelView): void => {
    if (disposed) return;
    currentView = view;
    const size = resize();
    const perspective = Math.max(finite(view.perspective, DEFAULT_VIEW.perspective), 1);
    const rect = view.screenRect;
    const left = finite(rect.left, 0);
    const top = finite(rect.top, 0);
    const width = Math.max(finite(rect.width, 1), 1);
    const height = Math.max(finite(rect.height, 1), 1);
    const centerX = left + width * 0.5;
    const centerY = top + height * 0.5;

    camera.aspect = size.width / size.height;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(size.height / (2 * perspective)));
    // Keep the depth range tight enough for the sub-pixel front screen layer
    // to stay stable. The phone occupies only a few hundred CSS pixels while
    // the calibrated eye distance is typically 1,000+ CSS pixels.
    camera.near = Math.max(0.1, perspective * 0.1);
    camera.far = Math.max(10000, perspective * 16);
    camera.position.set(0, 0, perspective);
    camera.setViewOffset(
      size.width,
      size.height,
      size.width * 0.5 - centerX,
      size.height * 0.5 - centerY,
      size.width,
      size.height,
    );
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    if (!modelScene || !contentRoot) return;
    const scale = Math.max(width / Math.max(screenWorldWidth, 1e-6), 1e-6);
    const transform = rotationMatrix(view.rotation)
      .multiply(MODEL_FRONT_ORIENTATION.clone());
    transform.scale(new THREE.Vector3(scale, scale, scale));
    modelRoot.matrix.copy(transform);
    modelRoot.matrixWorldNeedsUpdate = true;
    scene.updateMatrixWorld(true);
  };

  const updateScreen = (): void => {
    if (disposed || contextLost || !screenTexture || !ready) return;
    if (screenCanvas.width <= 0 || screenCanvas.height <= 0) {
      canvas.dataset.screenState = 'unavailable';
      return;
    }
    canvas.dataset.screenState = 'ready';
    // Three allocates immutable texture storage on the first upload. Canvas
    // resize needs new storage, not a sub-image upload into the old bounds.
    if (textureWidth !== screenCanvas.width || textureHeight !== screenCanvas.height) {
      screenTexture.dispose();
      screenTexture = createScreenTexture();
      if (screenMaterial) screenMaterial.map = screenTexture;
    }
    // CanvasTexture uploads synchronously as part of the immediately
    // following render call. This is intentionally kept in this stack so a
    // source WebGL canvas with preserveDrawingBuffer=false is still valid.
    screenTexture.needsUpdate = true;
    renderer.render(scene, camera);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    ready = false;
    canvas.dataset.modelState = 'disposed';
    if (modelScene) disposeObjectResources(modelScene);
    if (screenOverlay) disposeObjectResources(screenOverlay);
    screenOverlay = null;
    screenMaterial = null;
    screenTexture?.dispose();
    screenTexture = null;
    if (environmentTarget) environmentTarget.dispose();
    environmentTarget = null;
    if (pmremGenerator) pmremGenerator.dispose();
    pmremGenerator = null;
    if (environmentScene) disposeEnvironment(environmentScene);
    environmentScene = null;
    scene.environment = null;
    renderer.dispose();
    modelScene = null;
    contentRoot = null;
    modelRoot.clear();
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed) return;
    contextLost = true;
    // Release generation-specific targets while their context is lost. Doing
    // so after restore attempts to delete handles from the previous context.
    scene.environment = null;
    environmentTarget?.dispose();
    environmentTarget = null;
    pmremGenerator?.dispose();
    pmremGenerator = null;
    // Geometry/material disposal releases GPU handles and listeners, while
    // retaining CPU vertex arrays, texture images and material parameters.
    // They upload again on restore without keeping stale-generation handles.
    if (modelScene) disposeObjectResources(modelScene);
    if (screenOverlay) disposeObjectResources(screenOverlay);
    if (environmentScene) disposeEnvironment(environmentScene);
    canvas.dataset.modelState = 'context-lost';
  };
  const onContextRestored = (): void => {
    if (disposed) return;
    contextLost = false;
    if (environmentScene) {
      try {
        // PMREM render targets contain context-owned textures. Recreate the
        // environment convolution after the browser restores WebGL.
        environmentTarget?.dispose();
        environmentTarget = null;
        pmremGenerator?.dispose();
        pmremGenerator = new THREE.PMREMGenerator(renderer);
        environmentScene.visible = true;
        environmentTarget = pmremGenerator.fromScene(environmentScene);
        scene.environment = environmentTarget.texture;
        environmentScene.visible = false;
      } catch {
        scene.environment = null;
      }
    }
    canvas.dataset.modelState = ready ? 'ready' : 'loading';
    if (ready) {
      // The host will synchronously redraw its source canvas in response to
      // onReady, after Three has rebuilt its GPU resources.
      try { callbacks.onReady({ screenAspect }); } catch { /* Keep restore recovery alive. */ }
    }
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  const loader = new GLTFLoader();
  loader.load(
    modelUrl,
    (gltf) => {
      if (disposed) {
        disposeObjectResources(gltf.scene);
        return;
      }
      try {
        const importedScene = gltf.scene;
        importedScene.updateMatrixWorld(true);
        const screenMesh = findScreenMesh(importedScene);
        if (!screenMesh) throw new Error('找不到屏幕网格');

        const screenBox = new THREE.Box3().setFromObject(screenMesh);
        const screenCenter = screenBox.getCenter(new THREE.Vector3());
        const screenSize = screenBox.getSize(new THREE.Vector3());
        screenWorldWidth = Math.max(screenSize.z, 1e-6);
        screenWorldHeight = Math.max(screenSize.y, 1e-6);
        screenAspect = screenWorldWidth / screenWorldHeight;
        modelScene = importedScene;

        // Keep the pivot on the visible screen face. Rotating around the
        // bounding-box midpoint introduces a small but visible depth drift at
        // large yaw angles because the source screen mesh is slightly thick.
        const frontOffset = 0.0001;
        const frontX = screenBox.max.x - frontOffset;
        const pivotCenter = new THREE.Vector3(
          frontX,
          screenCenter.y,
          screenCenter.z,
        );

        contentRoot = new THREE.Group();
        contentRoot.name = 'PhoneModelContent';
        contentRoot.position.copy(pivotCenter).multiplyScalar(-1);
        modelRoot.add(contentRoot);
        contentRoot.add(importedScene);

        const originalMaterialNames = new Set<string>();
        importedScene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.material) return;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((material) => originalMaterialNames.add(material.name || material.type));
          if (mesh.name.toLowerCase().includes('glass') || materials.some((material) => /glass|lensinglass/i.test(material.name))) {
            // Let the original transparent glass pass render after the screen
            // layer so the model keeps its supplied reflection/tint.
            mesh.renderOrder = 3;
          }
        });
        canvas.dataset.modelMaterialCount = String(originalMaterialNames.size);
        canvas.dataset.modelMaterialNames = [...originalMaterialNames].join('|');
        canvas.dataset.modelMaterialsPreserved = 'true';

        screenTexture = createScreenTexture();

        // Reuse only the model's actual front display triangles. The source
        // screen mesh also contains shallow edge triangles and a UV seam with
        // negative U values; including either would stretch the live canvas
        // across the bezel or crop one side. The audit found the display face
        // at world max-X, with triangles whose three vertices are coplanar.
        const sourcePositions = screenMesh.geometry.getAttribute('position');
        const sourceIndex = screenMesh.geometry.getIndex();
        if (!sourcePositions) throw new Error('屏幕网格缺少顶点数据');
        const sourceTriangleIndices: number[] = [];
        if (sourceIndex) {
          for (let index = 0; index < sourceIndex.count; index++) sourceTriangleIndices.push(sourceIndex.getX(index));
        } else {
          for (let index = 0; index < sourcePositions.count; index++) sourceTriangleIndices.push(index);
        }
        const worldPositions: THREE.Vector3[] = [];
        const transformed = new THREE.Vector3();
        for (let index = 0; index < sourcePositions.count; index++) {
          transformed.fromBufferAttribute(sourcePositions, index).applyMatrix4(screenMesh.matrixWorld);
          worldPositions.push(transformed.clone());
        }
        const faceTolerance = 1e-5;
        const faceVertices: number[] = [];
        const faceUvs: number[] = [];
        const faceIndices: number[] = [];
        const ySize = Math.max(screenBox.max.y - screenBox.min.y, 1e-6);
        const zSize = Math.max(screenBox.max.z - screenBox.min.z, 1e-6);
        for (let index = 0; index + 2 < sourceTriangleIndices.length; index += 3) {
          const a = worldPositions[sourceTriangleIndices[index]];
          const b = worldPositions[sourceTriangleIndices[index + 1]];
          const c = worldPositions[sourceTriangleIndices[index + 2]];
          if (Math.abs(a.x - screenBox.max.x) > faceTolerance
            || Math.abs(b.x - screenBox.max.x) > faceTolerance
            || Math.abs(c.x - screenBox.max.x) > faceTolerance) continue;
          const triangle = [a, b, c];
          const offset = faceVertices.length / 3;
          triangle.forEach((point) => {
            faceVertices.push(frontX, point.y, point.z);
            faceUvs.push(
              THREE.MathUtils.clamp((point.z - screenBox.min.z) / zSize, 0, 1),
              THREE.MathUtils.clamp((point.y - screenBox.min.y) / ySize, 0, 1),
            );
          });
          faceIndices.push(offset, offset + 1, offset + 2);
        }
        if (!faceIndices.length) throw new Error('未找到屏幕正面显示面');
        const overlayGeometry = new THREE.BufferGeometry();
        overlayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(faceVertices, 3));
        overlayGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(faceUvs, 2));
        overlayGeometry.setIndex(faceIndices);
        overlayGeometry.computeBoundingSphere();
        screenMaterial = new THREE.MeshBasicMaterial({
          map: screenTexture,
          toneMapped: false,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          side: THREE.DoubleSide,
        });
        screenOverlay = new THREE.Mesh(overlayGeometry, screenMaterial);
        screenOverlay.name = 'DynamicScreenLayer';
        screenOverlay.renderOrder = 1;
        // The overlay geometry is already expressed in model world axes, and
        // contentRoot supplies the pivot translation.
        screenOverlay.position.set(0, 0, 0);
        contentRoot.add(screenOverlay);

        ready = true;
        canvas.dataset.modelState = 'ready';
        applyView(currentView);
        try { callbacks.onReady({ screenAspect }); } catch { /* Host callback must not break the renderer. */ }
      } catch (error) {
        disposeObjectResources(gltf.scene);
        reportError(callbacks, canvas, error);
      }
    },
    undefined,
    (error) => {
      if (!disposed) reportError(callbacks, canvas, error);
    },
  );

  const setView = (view: PhoneModelView): void => {
    if (disposed) return;
    applyView({
      rotation: finiteRotation(view.rotation),
      perspective: finite(view.perspective, DEFAULT_VIEW.perspective),
      screenRect: {
        left: finite(view.screenRect.left, 0),
        top: finite(view.screenRect.top, 0),
        width: finite(view.screenRect.width, 1),
        height: finite(view.screenRect.height, 1),
      },
    });
  };

  resize();
  return { setView, updateScreen, dispose };
}

function findScreenMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((object) => {
    if (found) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const label = `${mesh.name} ${(Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      .map((material) => material?.name || '').join(' ')}`;
    if (/screen|display/i.test(label)) found = mesh;
  });
  return found;
}
