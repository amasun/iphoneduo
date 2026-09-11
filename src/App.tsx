import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowUpRight, Check, ChevronDown, Crosshair, Expand, Hand, Layers3, Maximize2, MoveUpRight, Pause, Play, RotateCcw, Settings2, Smartphone, Sparkles, X } from 'lucide-react';
import { axisRotation, horizontalCorrectionDegrees, interpolateRotation, matrixToCss3d, scaleRotation, signedYawDegrees } from './orientation';
import { createRenderer } from './renderer';
import { effectAtAngle, MAX_BLUR, profiles, type EffectSettings } from './effect';
import { useOrientation } from './useOrientation';
import { useImmersiveViewport } from './useImmersiveViewport';
import { compensatedViewerRotation, DEFAULT_COMPENSATION } from './compensation';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const BASE_URL = import.meta.env.BASE_URL;
const WALLPAPER_URL = `${BASE_URL}wallpaper.png`;
const DEFAULT_PROFILE = 'deep';
const DEFAULT_VIEWING_DISTANCE = 50;
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

function Range({ label, value, min, max, step = 1, unit, onChange, hint, disabled = false }: {
  label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (value: number) => void; hint?: string; disabled?: boolean;
}) {
  const id = `range-${label}`;
  return <div className="range-field">
    <div className="range-label"><label htmlFor={id}>{label}</label><output htmlFor={id}>{step < 1 ? value.toFixed(2) : Math.round(value)}<span>{unit}</span></output></div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))} style={{ '--range-fill': `${(value - min) / (max - min) * 100}%` } as CSSProperties} />
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}

export default function App() {
  const [immersive, setImmersive] = useState(startsImmersive);
  const [controlsVisible, setControlsVisible] = useState(() => !isMobilePreview());
  const [panelOpen, setPanelOpen] = useState(false);
  const [intro, setIntro] = useState(true);
  const [settings, setSettings] = useState<EffectSettings>({ ...profiles[DEFAULT_PROFILE] });
  const [viewingDistance, setViewingDistance] = useState(DEFAULT_VIEWING_DISTANCE);
  const [compensation, setCompensation] = useState(DEFAULT_COMPENSATION);
  const [profile, setProfile] = useState<string>(DEFAULT_PROFILE);
  const [yaw, setYaw] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [rendererError, setRendererError] = useState('');
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [metrics, setMetrics] = useState({ angle: 0, depth: 0, blur: 0, progress: 0, hinge: 'left' as 'left' | 'right' });
  const sensor = useOrientation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const device = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLImageElement>(null);
  const engine = useRef<ReturnType<typeof createRenderer> | null>(null);
  const pose = useRef([...IDENTITY]);
  const drag = useRef<{ id: number; x: number; yaw: number } | null>(null);
  const tap = useRef<{ id: number; x: number; y: number; time: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; time: number; pointerType: string } | null>(null);
  const hideAfterConnection = useRef(false);
  const lastHinge = useRef<'left' | 'right'>('left');
  const frameState = useRef({ settings, viewingDistance, compensation, yaw, playing, enabled, immersive, sensorActive: false, reducedMotion });
  frameState.current = { settings, viewingDistance, compensation, yaw, playing, enabled, immersive, sensorActive: sensor.status === 'active' || sensor.status === 'waiting', reducedMotion };
  useImmersiveViewport(immersive);

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
      engine.current = createRenderer(canvas.current, WALLPAPER_URL, setRendererError);
    } catch {
      setRendererError('当前设备不支持 WebGL，已切换基础模糊。');
    }
    const observer = new ResizeObserver(() => engine.current?.resize());
    observer.observe(canvas.current);
    return () => { observer.disconnect(); engine.current?.dispose(); engine.current = null; };
  }, []);

  useEffect(() => {
    let frame = 0;
    let lastTime = performance.now();
    let lastUi = 0;
    let demoTime = 0;
    let previousDraw: number[] = [];
    const render = (now: number) => {
      const dt = Math.min(0.25, (now - lastTime) / 1000);
      lastTime = now;
      if (document.hidden) { frame = requestAnimationFrame(render); return; }
      const s = frameState.current;
      if (s.playing) demoTime += dt;
      const demoYaw = s.playing ? Math.sin(demoTime * 0.75) * 42 : s.yaw;
      // Use only horizontal phone heading for both the plane and its observer.
      // Pitch must not shift the camera or contaminate yaw during a side turn.
      const horizontalYaw = s.sensorActive ? horizontalCorrectionDegrees(sensor.correction.current) : -demoYaw;
      const targetYaw = clamp(horizontalYaw, -80, 80);
      const target = axisRotation(0, targetYaw);
      // Follow the sensor directly so the hinged plane does not lag the hand.
      pose.current = s.sensorActive ? target : interpolateRotation(pose.current, target, s.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.065));
      const angle = signedYawDegrees(pose.current);
      const effect = effectAtAngle(angle, s.settings);
      const amount = s.enabled ? effect : { progress: 0, blur: 0, dim: 0 };
      // Sensor and framed preview use the input angle directly. The flat
      // manual demo retains its optional gain and angle controls.
      const directRotation = s.sensorActive || !s.immersive;
      const rotation = s.enabled ? (directRotation ? pose.current : scaleRotation(pose.current, s.settings.gain, s.settings.maxAngle)) : IDENTITY;
      const depth = 390 * Math.abs(Math.sin(signedYawDegrees(rotation) * Math.PI / 180));
      // Choose the hinge that sends every other point behind the glass. The pivot itself stays at z=0.
      if (Math.abs(angle) > 0.001) lastHinge.current = angle >= 0 ? 'left' : 'right';
      const hinge = lastHinge.current;
      const scale = (canvas.current?.clientWidth ?? 390) / 390;
      // Convert viewing distance using an approximate 7 cm screen short edge;
      // using the short edge keeps the same distance in landscape.
      const shortEdge = Math.min(canvas.current?.clientWidth ?? 390, canvas.current?.clientHeight ?? 844);
      const perspective = s.viewingDistance / 7 * shortEdge;
      const physicalRotation = pose.current;
      // Adjustable compensation restores apparent width with a smooth limit
      // at high angles. The same camera rule applies to each preview.
      const viewerRotation = compensatedViewerRotation(angle, 0, s.compensation);
      const signature = [...rotation, ...viewerRotation, amount.blur, amount.dim, scale, perspective, Number(s.immersive), Number(hinge === 'right')];
      if (signature.some((value, i) => Math.abs(value - (previousDraw[i] ?? Infinity)) > 0.00001)) {
        engine.current?.render({ rotation, viewerRotation, hinge, blur: amount.blur * scale, dim: amount.dim, perspective });
        previousDraw = signature;
        if (device.current) {
          // The desktop phone frame turns around its center. Its inner scene
          // uses the same compensation model displayed on the physical phone.
          const stage = device.current.parentElement!;
          stage.style.perspective = s.immersive ? 'none' : `${perspective}px`;
          stage.style.perspectiveOrigin = `${device.current.offsetLeft + device.current.offsetWidth / 2}px ${device.current.offsetTop + device.current.offsetHeight / 2}px`;
          device.current.style.transformOrigin = '50% 50%';
          device.current.style.transform = s.immersive ? 'none' : matrixToCss3d(transpose(physicalRotation));
        }
        if (fallback.current) {
          fallback.current.style.transformOrigin = `${hinge} center`;
          fallback.current.style.transform = `perspective(${perspective}px) ${matrixToCss3d(rotation)}`;
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
    setPlaying(false); setYaw(0);
    if (sensor.status === 'active' || sensor.status === 'waiting') sensor.recalibrate();
  }, [sensor.status, sensor.recalibrate]);
  const manual = () => { sensor.disable(); setPlaying(false); setIntro(false); };
  const enableSensor = () => {
    setPlaying(false); setIntro(false);
    hideAfterConnection.current = immersive;
    void sensor.enable();
  };
  const update = (key: keyof EffectSettings, value: number) => { setSettings(s => ({ ...s, [key]: value })); setProfile('custom'); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) {
      tap.current = null; lastTap.current = null; drag.current = null;
      return;
    }
    if ((event.target as Element).closest('button, a, input') || event.button !== 0) return;
    tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, moved: false };
    drag.current = frameState.current.sensorActive ? null : { id: event.pointerId, x: event.clientX, yaw };
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
    setYaw(clamp(drag.current.yaw + (event.clientX - drag.current.x) * 0.18, -55, 55));
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
  const usesSensor = isConnected || isBusy;
  const usesDirectRotation = usesSensor || !immersive;
  const showImmersiveUi = immersive && controlsVisible;

  return <div className={`app ${immersive ? 'is-immersive' : ''}`}>
    <header className="topbar">
      <a className="wordmark" href={BASE_URL} aria-label="INSIDE 首页"><Layers3 size={22} strokeWidth={1.6} /><span>INSIDE<span className="wordmark-dot">.</span></span></a>
      <span className="topbar-caption">A STUDY IN PERCEPTION</span>
      <span className="edition"><span className="tiny-dot" /> EXPERIMENT 001</span>
    </header>

    <main className="workspace">
      <section className="preview-panel" aria-label="空间效果预览">
        <div className="preview-heading"><span className="eyebrow">BEYOND THE SURFACE</span><h1>屏幕之内，<br /><span>视线之外。</span></h1><p>转动手机，让画面退入屏幕。</p></div>
        <div className="stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishGesture} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (tap.current) cancelGesture(); }}>
          <div className="stage-orbit orbit-one" aria-hidden="true" /><div className="stage-orbit orbit-two" aria-hidden="true" />
          <div className="stage-label" aria-hidden="true"><span className="cross-mark">+</span><span>LIVE<br />PERSPECTIVE</span></div>
          <div className="device-shadow" aria-hidden="true" />
          <div className="device" ref={device}>
            <div className="device-button button-one" aria-hidden="true" /><div className="device-button button-two" aria-hidden="true" /><div className="device-button button-three" aria-hidden="true" />
            <div className="screen">
              <img ref={fallback} className={`fallback-image ${rendererError ? 'visible' : ''}`} src={WALLPAPER_URL} alt="雪山日落锁屏演示，包含原图的时间与天气信息" draggable="false" />
              <canvas ref={canvas} className={rendererError ? 'canvas-hidden' : ''} aria-label="随手机倾斜反向旋转、下沉并逐渐失焦的雪山画面" role="img" />
              <div className="screen-glass" aria-hidden="true" />
            </div>
          </div>
          <div className="stage-caption"><Hand size={15} /><span>拖动手机，探索不同角度</span><span className="caption-separator" /> <span>或使用下方角度滑杆</span></div>
        </div>
        <div className="preview-footer"><span><span className={`tiny-dot ${isConnected ? 'live' : ''}`} />{statusNames[sensor.status]}</span><button onClick={() => { setImmersive(true); setPanelOpen(false); setControlsVisible(!isMobilePreview()); }}><Expand size={15} />沉浸体验<ArrowUpRight size={14} /></button></div>
      </section>

      {showImmersiveUi && <div className="immersive-toolbar">
        <button className="glass-button" onClick={() => { setImmersive(false); setIntro(false); }} aria-label="退出沉浸体验"><Maximize2 size={18} /></button>
        <span className="immersive-brand">INSIDE.</span>
        <button className="glass-button" onClick={() => setPanelOpen(v => !v)} aria-expanded={panelOpen} aria-controls="controls" aria-label="打开效果调节"><Settings2 size={19} /></button>
      </div>}
      {showImmersiveUi && panelOpen && <button className="panel-backdrop" aria-label="关闭效果调节" onClick={() => setPanelOpen(false)} />}

      <aside id="controls" className={`controls ${panelOpen && (!immersive || controlsVisible) ? 'panel-open' : ''}`} aria-label="效果调节">
        <div className="controls-heading"><div><span className="eyebrow">THE EXPERIMENT</span><h2>感受空间的另一面<span>↗</span></h2></div><button className="panel-close icon-button" onClick={() => setPanelOpen(false)} aria-label="关闭调节面板"><X size={20} /></button></div>
        <p className="lead">只响应左右倾斜，一侧边缘始终固定。<br />像翻开一扇门，让画面退入屏幕深处。</p>

        <div className="connection-card">
          <div className="connection-title"><span className="connection-icon"><Smartphone size={20} /></span><div><strong>用你的 iPhone 体验</strong><span>正对屏幕 · 允许体感 · 缓慢倾斜</span></div><span className={`connection-dot ${isConnected ? 'connected' : ''}`} /></div>
          <button className="primary-button" onClick={isConnected ? reset : enableSensor} disabled={sensor.status === 'requesting'}>{isConnected ? <Crosshair size={17} /> : <MoveUpRight size={17} />}{isConnected ? '重新校准正面' : isBusy ? '重新连接体感' : '启用手机体感'}<span>{isConnected ? '已连接' : '开始体验'}</span></button>
          <p className={`sensor-message ${['denied', 'insecure', 'error'].includes(sensor.status) ? 'attention' : ''}`} role="status">{sensor.message}</p>
          {(isConnected || isBusy) && <button className="text-button" onClick={manual}>切换到手动模拟</button>}
        </div>

        <div className="section-label"><span>01</span><h3>选择一种感觉</h3></div>
        <div className="presets" aria-label="效果预设">
          {([['gentle', '轻盈', 'SUBTLE'], ['balanced', '平衡', 'BALANCED'], ['deep', '深邃', 'IMMERSIVE']] as const).map(([key, label, english]) => <button key={key} className={profile === key ? 'selected' : ''} aria-pressed={profile === key} onClick={() => { setProfile(key); setSettings({ ...profiles[key] }); }}><span>{label}{profile === key && <Check size={12} />}</span><small>{english}</small></button>)}
        </div>

        <div className="section-label tuning-label"><span>02</span><h3>微调空间</h3><button className="subtle-reset" onClick={() => { setSettings({ ...profiles[DEFAULT_PROFILE] }); setProfile(DEFAULT_PROFILE); setCompensation(DEFAULT_COMPENSATION); setViewingDistance(DEFAULT_VIEWING_DISTANCE); }} aria-label="重置效果参数"><RotateCcw size={13} />还原</button></div>
        <Range label="拉伸补偿" value={compensation * 100} min={0} max={100} unit="%" onChange={v => setCompensation(v / 100)} hint="降低可减轻横向展开；大角度下补偿会平缓增长。" />
        <Range label="翻转倍率" value={usesDirectRotation ? 1 : settings.gain} min={0} max={1.3} step={0.05} unit="×" onChange={v => update('gain', v)} disabled={usesDirectRotation} hint={usesDirectRotation ? '图片等角度反向转动，固定侧整条边贴屏。' : undefined} />
        <Range label="开始失焦" value={settings.threshold} min={0} max={28} unit="°" onChange={v => update('threshold', v)} />
        <Range label="最大翻转" value={usesDirectRotation ? 80 : settings.maxAngle} min={10} max={80} unit="°" onChange={v => update('maxAngle', v)} disabled={usesDirectRotation} />
        <Range label="透视距离" value={viewingDistance} min={20} max={60} unit="cm" onChange={setViewingDistance} hint="调整近侧与远侧的大小差异。" />
        <Range label="失焦程度" value={settings.blur} min={0} max={MAX_BLUR} unit="px" onChange={v => update('blur', v)} hint="失焦越深，画面越暗；固定边缘保持清晰。" />

        <div className="effect-switch-row"><div><Sparkles size={15} /><span>空间效果</span></div><button role="switch" aria-checked={enabled} aria-label="空间效果开关" className={`switch ${enabled ? 'on' : ''}`} onClick={() => setEnabled(v => !v)}><span /></button></div>
        <div className="hinge-status"><span><span className="tiny-dot" />{metrics.hinge === 'left' ? '左侧' : '右侧'}边缘固定 · 单轴翻转</span><button onClick={reset}><Crosshair size={13} />回正</button></div>
        <details className="instructions"><summary>如何在 iPhone 上打开<ChevronDown size={14} /></summary><p>通过受信任的 HTTPS 地址，用 Safari 打开本页。轻点「启用手机体感」并允许访问，保持手机正对自己，然后转动手腕。</p><p>可通过 Safari 分享菜单「添加到主屏幕」获得更完整的显示区域。若用电脑的局域网地址，HTTPS 证书需要先在 iPhone 上信任。普通 HTTP 地址支持手动模拟。</p><p>这是基于初始姿态的视觉近似；头部保持基本不动时效果最佳。图中时间与按钮属于演示图片。</p></details>
      </aside>

      <section className="simulation-panel" aria-label="手动模拟与实时读数">
        <div className="simulation-heading"><div><span className="eyebrow">HANDS-ON PREVIEW</span><h2>让视角动起来</h2></div><button className="demo-button" onClick={activateDemo}>{playing ? <Pause size={15} /> : <Play size={15} />} {playing ? '暂停演示' : '播放演示'}</button></div>
        <div className="simulation-grid"><div className="manual-controls">
          <Range label="左右倾斜" value={yaw} min={-55} max={55} unit="°" onChange={v => { manual(); setYaw(v); }} />
        </div><div className="readouts"><div><span>左右倾角</span><strong>{Math.abs(metrics.angle).toFixed(1)}<small>°</small></strong></div><div><span>远侧深度</span><strong>{Math.round(metrics.depth)}<small>px</small></strong></div><div><span>最大失焦</span><strong>{metrics.blur.toFixed(1)}<small>px</small></strong></div></div></div>
        <div className="simulation-bottom"><span><span className="tiny-dot" />{reducedMotion ? '已减少缓动 · 演示需手动播放' : `${metrics.hinge === 'left' ? '左' : '右'}边缘为转轴 · 前后倾斜不影响画面`}</span><button onClick={reset}><Crosshair size={14} />回到正面</button></div>
      </section>
    </main>

    <footer className="page-footer"><span>INSIDE / MOTION STUDY</span><span>一块屏幕，也可以有纵深。<ArrowDown size={13} /></span><span>DESIGNED TO BE FELT.</span></footer>

    {showImmersiveUi && !panelOpen && <div className={`immersive-bottom ${intro ? 'with-intro' : ''}`}>
      {intro ? <div className="intro-card"><span className="eyebrow">A LITTLE SHIFT IN PERSPECTIVE</span><h2>让画面，退入屏幕。</h2><p>正对手机，只需缓慢向左或向右倾斜。</p><button className="primary-button" onClick={enableSensor}><Smartphone size={18} />启用手机体感<ArrowUpRight size={17} /></button><button className="intro-manual" onClick={manual}>先用手指拖动体验</button></div> : <div className="immersive-actions"><button className="glass-button status-button" onClick={isConnected ? reset : enableSensor}>{isConnected ? <Crosshair size={15} /> : <Smartphone size={15} />}{isConnected ? '校准正面' : '启用体感'}</button><span className="angle-pill">{Math.abs(metrics.angle).toFixed(0)}° <span>{metrics.hinge === 'left' ? '左侧' : '右侧'}固定</span></span><button className="glass-button" aria-label={playing ? '暂停演示' : '播放演示'} onClick={activateDemo}>{playing ? <Pause size={17} /> : <Play size={17} />}</button></div>}
      {!intro && !isConnected && sensor.status !== 'idle' && <p className="immersive-message" role="status">{sensor.message}</p>}
    </div>}
    {rendererError && (!immersive || controlsVisible) && <div className="render-notice" role="status">{rendererError} 当前使用基础模糊预览。</div>}
  </div>;
}
