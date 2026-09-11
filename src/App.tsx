import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, ChevronDown, Crosshair, Expand, Maximize2, MoveUpRight, Pause, Play, RotateCcw, Settings2, Smartphone, X } from 'lucide-react';
import { axisRotation, horizontalCorrectionDegrees, interpolateRotation, matrixToCss3d, signedYawDegrees } from './orientation';
import { createRenderer } from './renderer';
import type { PhoneModelRenderer } from './phoneModelRenderer';
import { DEFAULT_EFFECT_SETTINGS, effectAtAngle, MAX_BLUR, type EffectSettings } from './effect';
import { useOrientation } from './useOrientation';
import { useImmersiveViewport } from './useImmersiveViewport';
import { LANGUAGE_STORAGE_KEY, readLanguage, translate } from './i18n';
import { compensatedViewerRotation, DEFAULT_COMPENSATION } from './compensation';
import { CALIBRATION_STORAGE_KEY, DEFAULT_CALIBRATION, parseViewingCalibration, perspectiveDistancePx, referenceShortEdge, serializeViewingCalibration } from './viewingCalibration';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const BASE_URL = import.meta.env.BASE_URL;
const WALLPAPER_URL = `${BASE_URL}wallpaper.png`;
const MAX_YAW = 80;
const MAX_MODEL_PITCH = 10;
const wrapDegrees = (angle: number) => {
  const turn = angle % 360;
  return turn > 180 ? turn - 360 : turn < -180 ? turn + 360 : turn;
};
const DEFAULT_PERSPECTIVE_STRENGTH = 0.5;
const DEFAULT_DIMMING_STRENGTH = 1;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const transpose = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const statusNames = { idle: '手动模拟', requesting: '等待授权', waiting: '等待体感', active: '体感已连接', denied: '未获授权', unavailable: '手动模拟', insecure: '需要 HTTPS', error: '连接未完成' };
const MOBILE_PREVIEW_QUERY = '(max-width: 759px), (max-height: 759px) and (hover: none) and (pointer: coarse)';

function isMobilePreview() {
  // A phone in landscape can exceed the desktop width breakpoint. Also
  // recognize touch viewports and phone browsers, including wider viewports.
  return window.matchMedia(MOBILE_PREVIEW_QUERY).matches
    || /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent);
}

function startsImmersive() {
  return new URLSearchParams(location.search).has('immersive') || isMobilePreview();
}

function initialCalibration() {
  try { return { ...parseViewingCalibration(window.localStorage.getItem(CALIBRATION_STORAGE_KEY)), screenShortCm: DEFAULT_CALIBRATION.screenShortCm }; }
  catch { return { ...DEFAULT_CALIBRATION }; }
}

function Range({ id, label, value, min, max, step = 1, unit, onChange, hint, disabled = false }: {
  id: string; label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (value: number) => void; hint?: string; disabled?: boolean;
}) {
  return <div className="range-field">
    <div className="range-label"><label htmlFor={id}>{label}</label><output htmlFor={id}>{step < 1 ? value.toFixed(2) : Math.round(value)}<span>{unit}</span></output></div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))} style={{ '--range-fill': `${(value - min) / (max - min) * 100}%` } as CSSProperties} />
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}

export default function App() {
  const [language, setLanguage] = useState(readLanguage);
  const mobilePreview = isMobilePreview();
  const uiLanguage = mobilePreview ? 'zh' : language;
  const t = (text: string) => translate(text, uiLanguage);
  const [immersive, setImmersive] = useState(startsImmersive);
  const [controlsVisible, setControlsVisible] = useState(() => !isMobilePreview());
  const [panelOpen, setPanelOpen] = useState(() => !startsImmersive());
  const [intro, setIntro] = useState(true);
  const [settings, setSettings] = useState<EffectSettings>({ ...DEFAULT_EFFECT_SETTINGS });
  const [calibration, setCalibration] = useState(initialCalibration);
  const [compensation, setCompensation] = useState(DEFAULT_COMPENSATION);
  const [perspectiveStrength, setPerspectiveStrength] = useState(DEFAULT_PERSPECTIVE_STRENGTH);
  const [desktopDimming, setDesktopDimming] = useState(DEFAULT_DIMMING_STRENGTH);
  const [yaw, setYaw] = useState(0);
  const [modelPitch, setModelPitch] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [rendererError, setRendererError] = useState('');
  const [modelAspect, setModelAspect] = useState<number | null>(null);
  const [modelError, setModelError] = useState('');
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [metrics, setMetrics] = useState({ angle: 0, depth: 0, blur: 0, progress: 0, hinge: 'left' as 'left' | 'right' });
  const sensor = useOrientation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const modelCanvas = useRef<HTMLCanvasElement>(null);
  const phoneModel = useRef<PhoneModelRenderer | null>(null);
  const modelRevision = useRef(0);
  const device = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLImageElement>(null);
  const engine = useRef<ReturnType<typeof createRenderer> | null>(null);
  const pose = useRef([...IDENTITY]);
  const modelPose = useRef([...IDENTITY]);
  const drag = useRef<{ id: number; x: number; y: number; yaw: number; pitch: number } | null>(null);
  const tap = useRef<{ id: number; x: number; y: number; time: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; time: number; pointerType: string } | null>(null);
  const hideAfterConnection = useRef(false);
  const lastHinge = useRef<'left' | 'right'>('left');
  const previewPerspective = mobilePreview ? perspectiveStrength : DEFAULT_PERSPECTIVE_STRENGTH;
  const dimmingStrength = mobilePreview ? DEFAULT_DIMMING_STRENGTH : desktopDimming;
  const frameState = useRef({ settings, calibration, compensation, perspectiveStrength: previewPerspective, dimmingStrength, yaw, modelPitch, playing, enabled, immersive, sensorActive: false, reducedMotion });
  frameState.current = { settings, calibration, compensation, perspectiveStrength: previewPerspective, dimmingStrength, yaw, modelPitch, playing, enabled, immersive, sensorActive: sensor.status === 'active' || sensor.status === 'waiting', reducedMotion };
  useImmersiveViewport(immersive);

  useEffect(() => {
    document.documentElement.lang = uiLanguage === 'en' ? 'en' : 'zh-CN';
    document.title = translate('INSIDE — 屏幕之内', uiLanguage);
    document.querySelector('meta[name="description"]')?.setAttribute('content',
      translate('倾斜手机，看画面停留在视线里，再退入屏幕深处。一个可以亲手体验的空间视觉实验。', uiLanguage));
  }, [uiLanguage]);

  useEffect(() => {
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); }
    catch { /* Language switching still works when storage is unavailable. */ }
  }, [language]);

  useEffect(() => {
    if (immersive) {
      setYaw(value => clamp(wrapDegrees(value), -MAX_YAW, MAX_YAW));
      setModelPitch(0);
    }
  }, [immersive]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CALIBRATION_STORAGE_KEY, serializeViewingCalibration(calibration));
    } catch { /* Continue with in-memory settings when storage is unavailable. */ }
  }, [calibration]);

  useEffect(() => {
    const mobilePreview = window.matchMedia(MOBILE_PREVIEW_QUERY);
    const enterMobilePreview = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setImmersive(true);
        setPanelOpen(false);
        setControlsVisible(false);
      }
    };
    // Support switching an already-open desktop page into a phone preview.
    // Explicit exit remains available; ordinary rerenders never force entry.
    mobilePreview.addEventListener('change', enterMobilePreview);
    return () => mobilePreview.removeEventListener('change', enterMobilePreview);
  }, []);

  useEffect(() => {
    if (sensor.status === 'active' && hideAfterConnection.current) {
      hideAfterConnection.current = false;
      setControlsVisible(false);
      setPanelOpen(false);
    } else if (!['requesting', 'waiting', 'active'].includes(sensor.status)) {
      hideAfterConnection.current = false;
    }
  }, [sensor.status]);

  useEffect(() => {
    if (!canvas.current) return;
    try {
      engine.current = createRenderer(canvas.current, WALLPAPER_URL, setRendererError, () => phoneModel.current?.updateScreen());
    } catch {
      setRendererError('当前设备不支持 WebGL，已切换基础模糊。');
    }
    const observer = new ResizeObserver(() => engine.current?.resize());
    observer.observe(canvas.current);
    return () => { observer.disconnect(); engine.current?.dispose(); engine.current = null; };
  }, []);

  useEffect(() => {
    setModelAspect(null);
    setModelError('');
    if (immersive || !canvas.current || !modelCanvas.current || rendererError) return;
    let cancelled = false;
    let model: PhoneModelRenderer | null = null;
    const output = modelCanvas.current;
    const source = canvas.current;
    // The actual phone uses its own chassis: only framed previews load Three
    // and the original glTF assets.
    void import('./phoneModelRenderer').then(({ createPhoneModelRenderer }) => {
      if (cancelled) return;
      model = createPhoneModelRenderer(output, source, `${BASE_URL}models/iphone-17-pro-max/scene.gltf`, {
        onReady: ({ screenAspect }) => {
          if (cancelled) return;
          setModelAspect(screenAspect);
          modelRevision.current++;
        },
        onError: () => {
          if (cancelled) return;
          setModelAspect(null);
          setModelError('3D 模型暂时不可用，已显示基础外框。');
        },
      });
      phoneModel.current = model;
      modelRevision.current++;
    }).catch(() => {
      if (!cancelled) setModelError('3D 模型暂时不可用，已显示基础外框。');
    });
    return () => {
      cancelled = true;
      if (phoneModel.current === model) phoneModel.current = null;
      model?.dispose();
    };
  }, [immersive, rendererError]);

  useEffect(() => {
    let frame = 0;
    let lastTime = performance.now();
    let lastUi = 0;
    let demoTime = 0;
    let previousDraw: number[] = [];
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const phoneBrowser = /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent);
    const render = (now: number) => {
      const dt = Math.min(0.25, (now - lastTime) / 1000);
      lastTime = now;
      if (document.hidden) { frame = requestAnimationFrame(render); return; }
      const s = frameState.current;
      if (s.playing) demoTime += dt;
      const demoYaw = s.playing ? Math.sin(demoTime * 0.75) * 42 : s.yaw;
      // Use only horizontal phone heading for both the plane and its observer.
      // Pitch must not shift the camera or contaminate yaw during a side turn.
      const horizontalYaw = s.sensorActive ? horizontalCorrectionDegrees(sensor.correction.current) : -(s.immersive ? demoYaw : wrapDegrees(demoYaw));
      const targetYaw = clamp(horizontalYaw, -MAX_YAW, MAX_YAW);
      const target = axisRotation(0, targetYaw);
      // Follow the sensor directly so the hinged plane does not lag the hand.
      pose.current = s.sensorActive ? target : interpolateRotation(pose.current, target, s.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.065));
      const angle = signedYawDegrees(pose.current);
      const effect = effectAtAngle(angle, s.settings);
      const amount = s.enabled ? { ...effect, dim: clamp(effect.dim * s.dimmingStrength, 0, 1) }
        : { progress: 0, blur: 0, dim: 0 };
      // All previews use the same 1:1 counterrotation.
      const rotation = s.enabled ? pose.current : IDENTITY;
      const depth = 390 * Math.abs(Math.sin(signedYawDegrees(rotation) * Math.PI / 180));
      // Choose the hinge that sends every other point behind the glass. The pivot itself stays at z=0.
      if (Math.abs(angle) > 0.001) lastHinge.current = angle >= 0 ? 'left' : 'right';
      const hinge = lastHinge.current;
      const scale = (canvas.current?.clientWidth ?? 390) / 390;
      // Physical screen pixels keep calibration stable when browser bars or
      // orientation change. Desktop frames use their own simulated size.
      const shortEdge = referenceShortEdge(
        canvas.current?.clientWidth ?? 390, canvas.current?.clientHeight ?? 844,
        window.screen.width, window.screen.height,
        s.immersive && (phoneBrowser || coarsePointer.matches),
      );
      const perspective = perspectiveDistancePx(shortEdge, s.calibration);
      // The chassis can complete horizontal laps, with a small pitch range.
      // The screen illusion retains its separate single-axis range.
      const physicalTarget = s.immersive || s.sensorActive
        ? transpose(pose.current) : axisRotation(s.modelPitch, demoYaw);
      modelPose.current = s.immersive || s.sensorActive ? physicalTarget
        : interpolateRotation(modelPose.current, physicalTarget, s.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.065));
      const physicalRotation = modelPose.current;
      // At 100%, the observer follows the exact horizontal angle, including
      // turns above 45 degrees; pitch stays excluded from the whole scene.
      const viewerRotation = compensatedViewerRotation(angle, 0, s.compensation);
      const stageElement = device.current?.parentElement;
      const signature = [...rotation, ...viewerRotation, ...physicalRotation, amount.blur, amount.dim, scale, perspective, s.perspectiveStrength, Number(s.immersive), Number(hinge === 'right'), modelRevision.current,
        stageElement?.clientWidth ?? 0, stageElement?.clientHeight ?? 0, canvas.current?.clientHeight ?? 0,
        device.current?.offsetLeft ?? 0, device.current?.offsetTop ?? 0];
      if (signature.some((value, i) => Math.abs(value - (previousDraw[i] ?? Infinity)) > 0.00001)) {
        if (!s.immersive && phoneModel.current && canvas.current && stageElement) {
          // Layout offsets exclude the CSS fallback's rotation, so the real
          // model receives neutral display bounds and rotates exactly once.
          let left = 0;
          let top = 0;
          let element: HTMLElement | null = canvas.current;
          while (element && element !== stageElement) {
            left += element.offsetLeft;
            top += element.offsetTop;
            const parent = element.offsetParent as HTMLElement | null;
            if (parent) { left += parent.clientLeft; top += parent.clientTop; }
            element = parent;
          }
          phoneModel.current.setView({
            rotation: physicalRotation, perspective,
            screenRect: { left, top, width: canvas.current.clientWidth, height: canvas.current.clientHeight },
          });
        }
        engine.current?.render({ rotation, viewerRotation, hinge, blur: amount.blur * scale, dim: amount.dim, perspective, perspectiveStrength: s.perspectiveStrength });
        previousDraw = signature;
        if (device.current) {
          // The desktop phone frame turns around its center. Its inner scene
          // uses the same compensation model displayed on the physical phone.
          const stage = device.current.parentElement!;
          stage.style.perspective = s.immersive ? 'none' : `${perspective}px`;
          stage.style.perspectiveOrigin = `${device.current.offsetLeft + device.current.offsetWidth / 2}px ${device.current.offsetTop + device.current.offsetHeight / 2}px`;
          device.current.style.transformOrigin = '50% 50%';
          device.current.style.transform = s.immersive ? 'none' : matrixToCss3d(physicalRotation);
        }
        if (fallback.current) {
          fallback.current.style.transformOrigin = `${hinge} center`;
          const fallbackPerspective = s.perspectiveStrength > 0 ? `perspective(${perspective / s.perspectiveStrength}px)` : '';
          fallback.current.style.transform = `${fallbackPerspective} ${matrixToCss3d(rotation)}`;
          fallback.current.style.filter = `blur(${amount.blur * scale}px) brightness(${1 - amount.dim})`;
        }
      }
      if (now - lastUi > 120) {
        setMetrics(previous => Math.abs(previous.angle - angle) < 0.01 && Math.abs(previous.depth - depth) < 0.01 && Math.abs(previous.blur - amount.blur) < 0.01 && previous.hinge === hinge ? previous : { angle, depth, blur: amount.blur, progress: amount.progress, hinge });
        if (s.playing) setYaw(demoYaw);
        lastUi = now;
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [sensor.correction]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPanelOpen(false); setImmersive(false); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const reset = useCallback(() => {
    setPlaying(false); setYaw(0); setModelPitch(0);
    if (sensor.status === 'active' || sensor.status === 'waiting') sensor.recalibrate();
  }, [sensor.status, sensor.recalibrate]);
  const manual = () => { sensor.disable(); setPlaying(false); setIntro(false); };
  const enableSensor = () => {
    setPlaying(false); setIntro(false);
    hideAfterConnection.current = immersive;
    void sensor.enable();
  };
  const update = (key: keyof EffectSettings, value: number) => setSettings(s => ({ ...s, [key]: value }));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) {
      tap.current = null; lastTap.current = null; drag.current = null;
      return;
    }
    if ((event.target as Element).closest('button, a, input') || event.button !== 0) return;
    tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, moved: false };
    if (!immersive && frameState.current.sensorActive) sensor.disable();
    drag.current = immersive && frameState.current.sensorActive ? null
      : { id: event.pointerId, x: event.clientX, y: event.clientY,
          yaw: frameState.current.sensorActive ? -metrics.angle : yaw, pitch: modelPitch };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = tap.current;
    if (!gesture || event.pointerId !== gesture.id) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
      gesture.moved = true;
      lastTap.current = null;
    }
    if (!gesture.moved) return;
    if (!drag.current || event.pointerId !== drag.current.id) return;
    setPlaying(false); setIntro(false);
    const nextYaw = drag.current.yaw + (event.clientX - drag.current.x) * (immersive ? 0.18 : 0.4);
    setYaw(immersive ? clamp(nextYaw, -MAX_YAW, MAX_YAW) : nextYaw);
    if (!immersive) {
      const nextPitch = clamp(drag.current.pitch + (event.clientY - drag.current.y) * 0.4, -MAX_MODEL_PITCH, MAX_MODEL_PITCH);
      setModelPitch(nextPitch);
      // Keep reversal responsive after the pointer moves beyond a pitch limit.
      drag.current.pitch = nextPitch;
      drag.current.y = event.clientY;
    }
  };
  const cancelGesture = () => { drag.current = null; tap.current = null; lastTap.current = null; };
  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = tap.current;
    drag.current = null; tap.current = null;
    if (!immersive || !gesture || event.pointerId !== gesture.id || gesture.moved
      || event.timeStamp - gesture.time > 300
      || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
      lastTap.current = null;
      return;
    }
    const previous = lastTap.current;
    if (previous && previous.pointerType === event.pointerType
      && event.timeStamp - previous.time < 350
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 28) {
      setControlsVisible(visible => !visible);
      setPanelOpen(false);
      lastTap.current = null;
      event.preventDefault();
    } else {
      lastTap.current = { x: event.clientX, y: event.clientY, time: event.timeStamp, pointerType: event.pointerType };
    }
  };
  const activateDemo = () => { sensor.disable(); setIntro(false); setPlaying(v => !v); };
  const isConnected = sensor.status === 'active';
  const isBusy = sensor.status === 'requesting' || sensor.status === 'waiting';
  const showImmersiveUi = immersive && controlsVisible;
  const languageButton = !mobilePreview && <button className={`language-switch ${immersive ? 'glass-button' : ''}`}
    onClick={() => setLanguage(value => value === 'zh' ? 'en' : 'zh')}
    aria-label={t(language === 'zh' ? '切换为英语' : '切换为中文')} lang={language === 'zh' ? 'en' : 'zh-CN'}>
    {language === 'zh' ? 'EN' : '中文'}
  </button>;

  return <div data-language={uiLanguage} className={`app ${immersive ? 'is-immersive' : ''}`}>
    <header className="topbar">
      <a className="wordmark" href={BASE_URL} aria-label={t('INSIDE 首页')}><span>INSIDE.</span></a>
      {!immersive && languageButton}
    </header>

    <main className="workspace">
      <section className="preview-panel" aria-label={t('空间效果预览')}>
        <div className={`stage ${!immersive && modelAspect ? 'model-ready' : ''}`} style={modelAspect ? { '--model-screen-aspect': modelAspect } as CSSProperties : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishGesture} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (tap.current) cancelGesture(); }}>
          <div className="device-shadow" aria-hidden="true" />
          <div className="device" ref={device}>
            <div className="device-button button-one" aria-hidden="true" /><div className="device-button button-two" aria-hidden="true" /><div className="device-button button-three" aria-hidden="true" />
            <div className="screen">
              <img ref={fallback} className={`fallback-image ${rendererError ? 'visible' : ''}`} src={WALLPAPER_URL} alt={t('雪山日落锁屏演示，包含原图的时间与天气信息')} draggable="false" />
              <canvas ref={canvas} className={rendererError ? 'canvas-hidden' : ''} aria-label={t('随手机倾斜反向旋转、下沉并逐渐失焦的雪山画面')} role="img" />
              <div className="screen-glass" aria-hidden="true" />
            </div>
          </div>
          {!immersive && <canvas ref={modelCanvas} className="phone-model-canvas" role="img" aria-label={t('可旋转的 iPhone 17 Pro Max 三维模型，屏幕实时呈现倾斜效果')} aria-hidden={!modelAspect} />}
        </div>
        <div className="preview-footer"><span><span className={`tiny-dot ${isConnected ? 'live' : ''}`} />{t(statusNames[sensor.status])}</span><button onClick={() => { setImmersive(true); setPanelOpen(false); setControlsVisible(!isMobilePreview()); }}><Expand size={16} />{t('iPhone 预览')}</button><button className="dashboard-settings" onClick={() => setPanelOpen(value => !value)} aria-label={t('打开效果调节')} aria-expanded={panelOpen} aria-controls="controls"><Settings2 size={18} /><span>{t('调节')}</span></button></div>

        {!immersive && modelError && <p className="model-load-notice" role="status">{t(modelError)}</p>}
      </section>

      {showImmersiveUi && <div className="immersive-toolbar">
        <button className="glass-button" onClick={() => { setImmersive(false); setIntro(false); }} aria-label={t('退出沉浸体验')}><Maximize2 size={18} /></button>
        {languageButton}
      </div>}
      {showImmersiveUi && panelOpen && <button className="panel-backdrop" aria-label={t('关闭效果调节')} onClick={() => setPanelOpen(false)} />}

      <aside id="controls" className={`controls ${panelOpen && (!immersive || controlsVisible) ? 'panel-open' : ''}`} aria-label={t('效果调节')}>

        <div className="connection-card">
          <button className="primary-button" onClick={isConnected ? reset : enableSensor} disabled={sensor.status === 'requesting'}>{isConnected ? <Crosshair size={17} /> : <MoveUpRight size={17} />}{isConnected ? t('重新校准正面') : isBusy ? t('重新连接体感') : t('启用手机体感')}</button>
          {sensor.status !== 'idle' && <p className={`sensor-message ${['denied', 'insecure', 'error'].includes(sensor.status) ? 'attention' : ''}`} role="status">{t(sensor.message)}</p>}
          {(isConnected || isBusy) && <button className="text-button" onClick={manual}>{t('切换到手动模拟')}</button>}
        </div>

        <div className="section-label tuning-label"><h3>{t('微调空间')}</h3><button className="subtle-reset" onClick={() => { setSettings({ ...DEFAULT_EFFECT_SETTINGS }); setCompensation(DEFAULT_COMPENSATION); setPerspectiveStrength(DEFAULT_PERSPECTIVE_STRENGTH); setDesktopDimming(DEFAULT_DIMMING_STRENGTH); setCalibration({ ...DEFAULT_CALIBRATION }); }} aria-label={t('重置效果参数')}><RotateCcw size={13} />{t('还原')}</button><button className="panel-close tuning-close" onClick={() => setPanelOpen(false)} aria-label={t('关闭参数面板')}><X size={18} /></button></div>
        <Range id="range-拉伸补偿" label={t('拉伸补偿')} value={compensation * 100} min={0} max={100} unit="%" onChange={v => setCompensation(v / 100)} />
        {mobilePreview
          ? <Range id="range-远侧收缩" label={t('远侧收缩')} value={perspectiveStrength * 100} min={0} max={200} unit="%" onChange={v => setPerspectiveStrength(v / 100)} />
          : <Range id="range-远端压暗" label={t('远端压暗')} value={desktopDimming * 100} min={0} max={200} unit="%" onChange={v => setDesktopDimming(v / 100)} />}
        <Range id="range-开始失焦" label={t('开始失焦')} value={settings.threshold} min={0} max={28} unit="°" onChange={v => update('threshold', v)} />
        <Range id="range-透视距离" label={t('透视距离')} value={calibration.distanceCm} min={20} max={100} unit="cm" onChange={v => setCalibration(c => ({ ...c, distanceCm: v }))} />
        <Range id="range-失焦程度" label={t('失焦程度')} value={settings.blur} min={0} max={MAX_BLUR} unit="px" onChange={v => update('blur', v)} />

        <div className="effect-switch-row"><div><span>{t('空间效果')}</span></div><button role="switch" aria-checked={enabled} aria-label={t('空间效果开关')} className={`switch ${enabled ? 'on' : ''}`} onClick={() => setEnabled(v => !v)}><span /></button></div>
        <details className="instructions"><summary>{t('使用说明')}<ChevronDown size={14} /></summary><p>{t('拖动模型可左右自由旋转，上下俯仰限 ±10°，点击「回到正面」复位。')}</p><p>{t('在 iPhone Safari 中启用体感并允许访问。正对屏幕校准后，保持头部不动，缓慢左右转动手机。双击画面显示或隐藏控件。')}</p><p>{t(mobilePreview ? '拉伸补偿调节横向展开，远侧收缩调节近大远小。透视距离填写眼睛到屏幕的距离；失焦程度越高，模糊区域越暗。' : '拉伸补偿调节横向展开，透视距离填写眼睛到屏幕的距离。远端压暗控制模糊区域的明暗：0% 不压暗，100% 为原有强度，200% 加强压暗。它不改变图片透视或模糊程度；固定边缘保持明亮。')}</p><p><strong>{t('iPhone 全屏体验')}</strong><br />{t('用 Safari 打开本页，点击「分享」→「添加到主屏幕」→「添加」。如出现「作为 Web App 打开」，请保持开启。随后回到手机桌面，点击新添加的 INSIDE 图标，即可在没有 Safari 地址栏和工具栏的界面中体验。进入后双击画面显示控件，再启用体感。')}</p>{!immersive && <div className="model-attribution"><a href="https://sketchfab.com/3d-models/iphone-17-pro-max-87fc1df741384124a8ce0226d2b2058d" target="_blank" rel="noreferrer">iPhone 17 Pro Max</a><span>·</span><a href="https://sketchfab.com/MG990" target="_blank" rel="noreferrer">MajdyModels</a><span>·</span><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a><span>{t('· 实时屏幕改编')}</span></div>}</details>
        {!immersive && <a className="iphone-preview-qr" href="https://amasun.github.io/iphoneduo/" target="_blank" rel="noreferrer" aria-label={t('打开 iPhone 预览，或使用相机扫描二维码')}>
          <img src={`${BASE_URL}iphone-preview.svg`} width={128} height={128} alt={t('iPhone 预览二维码')} />
          <div><strong>{t('iPhone 预览')}</strong><span>{t('相机扫码')}<br />{t('在 Safari 中打开')}</span></div>
        </a>}
      </aside>

      <section className="simulation-panel" aria-label={t('手动模拟与实时读数')}>
        <div className="simulation-heading"><h2>{t('旋转')}</h2><button className="demo-button" onClick={activateDemo} aria-label={playing ? t('暂停演示') : t('播放演示')} title={playing ? t('暂停演示') : t('播放演示')}>{playing ? <Pause size={18} /> : <Play size={18} />}<span>{playing ? t('暂停演示') : t('播放演示')}</span></button></div>
        <div className="simulation-grid"><div className="manual-controls">
          <Range id="range-左右倾斜" label={t('左右倾斜')} value={immersive ? yaw : wrapDegrees(yaw)} min={immersive ? -MAX_YAW : -180} max={immersive ? MAX_YAW : 180} unit="°" onChange={v => { manual(); setYaw(v); }} />
        </div></div>
        <div className="simulation-bottom"><span>{t('拖动查看机身')}</span><button onClick={reset} aria-label={t('回到正面')} title={t('回到正面')}><RotateCcw size={18} /><span>{t('回到正面')}</span></button></div>
      </section>
    </main>

    {!immersive && <footer className="dashboard-footer">
      <a className="design-credit" href="https://www.xiaohongshu.com/user/profile/5c094b50f7e8b948da476607" target="_blank" rel="noreferrer" aria-label={t('Design by Artgineer，打开小红书主页')}>
        <span>Design by <strong>Artgineer</strong></span><span className="social-label">{t('小红书')}<ArrowUpRight size={12} /></span>
      </a>
    </footer>}

    {showImmersiveUi && <div className={`immersive-bottom ${intro && !panelOpen ? 'with-intro' : ''}`}>
      {!panelOpen && intro && <div className="intro-card"><p>{t('正对屏幕后启用体感')}</p><button className="primary-button" onClick={enableSensor}><Smartphone size={18} />{t('启用手机体感')}<ArrowUpRight size={17} /></button><button className="intro-manual" onClick={manual}>{t('手动体验')}</button></div>}
      {!panelOpen && !intro && !isConnected && sensor.status !== 'idle' && <p className="immersive-message" role="status">{t(sensor.message)}</p>}
      <div className={`immersive-actions ${intro || panelOpen ? 'settings-only' : ''}`}>
        {!panelOpen && !intro && <><button className="glass-button status-button" onClick={isConnected ? reset : enableSensor}>{isConnected ? <Crosshair size={15} /> : <Smartphone size={15} />}{isConnected ? t('校准正面') : t('启用体感')}</button><span className="angle-pill">{Math.abs(metrics.angle).toFixed(0)}° <span>{metrics.hinge === 'left' ? t('左侧固定') : t('右侧固定')}</span></span><button className="glass-button" aria-label={playing ? t('暂停演示') : t('播放演示')} onClick={activateDemo}>{playing ? <Pause size={17} /> : <Play size={17} />}</button></>}
        <button className="glass-button immersive-settings" onClick={() => setPanelOpen(v => !v)} aria-expanded={panelOpen} aria-controls="controls" aria-label={t('打开效果调节')}><Settings2 size={19} /></button>
      </div>
    </div>}
    {rendererError && (!immersive || controlsVisible) && <div className="render-notice" role="status">{t(rendererError)} {t('当前使用基础模糊预览。')}</div>}
  </div>;
}
