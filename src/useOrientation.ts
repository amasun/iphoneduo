import { useCallback, useEffect, useRef, useState } from 'react';
import { orientationMatrix, relativeInverse, type OrientationReading } from './orientation';

export type SensorStatus = 'idle' | 'requesting' | 'waiting' | 'active' | 'denied' | 'unavailable' | 'insecure' | 'error';
const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
type PermissionConstructor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
const screenAngle = () => window.screen.orientation?.angle ?? Number((window as Window & { orientation?: number }).orientation ?? 0);

export function useOrientation() {
  const [status, setStatus] = useState<SensorStatus>('idle');
  const [message, setMessage] = useState('正对手机，启用后缓慢转动手腕。');
  const correction = useRef(identity());
  const reference = useRef<number[] | null>(null);
  const current = useRef<number[] | null>(null);
  const listening = useRef(false);
  const generation = useRef(0);
  const lastSample = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const active = useRef(false);

  const receive = useCallback((event: DeviceOrientationEvent) => {
    if (!listening.current || event.beta === null || event.gamma === null) return;
    const reading: OrientationReading = { alpha: event.alpha ?? 0, beta: event.beta, gamma: event.gamma };
    if (!Object.values(reading).every(Number.isFinite)) return;
    current.current = orientationMatrix(reading, screenAngle());
    if (!reference.current) reference.current = [...current.current];
    correction.current = relativeInverse(current.current, reference.current);
    lastSample.current = performance.now();
    if (!active.current) {
      active.current = true;
      setStatus('active');
      setMessage('体感已连接 · 当前姿态已校准');
    }
  }, []);

  const recalibrate = useCallback(() => {
    reference.current = current.current ? [...current.current] : null;
    correction.current = identity();
    setMessage(current.current ? '已将当前握持姿态设为正面。' : '请保持手机正对自己，等待方向数据。');
  }, []);

  const onScreenChange = useCallback(() => {
    reference.current = null;
    current.current = null;
    correction.current = identity();
    active.current = false;
    setMessage('屏幕方向已改变，正在重新校准。');
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    listening.current = false;
    active.current = false;
    window.removeEventListener('deviceorientation', receive);
    window.removeEventListener('orientationchange', onScreenChange);
    window.screen.orientation?.removeEventListener('change', onScreenChange);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    correction.current = identity();
    reference.current = null;
    current.current = null;
  }, [receive, onScreenChange]);

  const disable = useCallback(() => {
    stop();
    setStatus('idle');
    setMessage('拖动画面或调整角度，模拟转动手机。');
  }, [stop]);

  const enable = useCallback(async () => {
    stop();
    const requestGeneration = generation.current;
    if (!window.isSecureContext) {
      setStatus('insecure');
      setMessage('体感需要受信任的 HTTPS 地址。当前可继续手动体验；连接方法见下方说明。');
      return;
    }
    const orientationEvent = window.DeviceOrientationEvent as PermissionConstructor | undefined;
    if (!orientationEvent) {
      setStatus('unavailable');
      setMessage('这个浏览器不支持方向传感器，可拖动画面手动体验。');
      return;
    }
    setStatus('requesting');
    setMessage('请在浏览器弹窗中允许访问方向传感器。');
    try {
      // iOS requires this call directly inside the button's user activation.
      const permission = orientationEvent.requestPermission ? await orientationEvent.requestPermission() : 'granted';
      if (generation.current !== requestGeneration) return;
      if (permission !== 'granted') {
        setStatus('denied');
        setMessage('方向访问未获允许。可继续手动体验，或在 Safari 网站设置中允许后重试。');
        return;
      }
      listening.current = true;
      active.current = false;
      lastSample.current = performance.now();
      window.addEventListener('deviceorientation', receive, { passive: true });
      window.addEventListener('orientationchange', onScreenChange, { passive: true });
      window.screen.orientation?.addEventListener('change', onScreenChange);
      setStatus('waiting');
      setMessage('保持手机正对自己，正在等待方向数据…');
      timer.current = setInterval(() => {
        if (!document.hidden && performance.now() - lastSample.current > 4500) {
          active.current = false;
          setStatus('waiting');
          setMessage('尚未收到方向数据。请用 iPhone Safari 检查权限，或切换手动体验。');
        }
      }, 1500);
    } catch {
      if (generation.current !== requestGeneration) return;
      setStatus('error');
      setMessage('无法访问方向传感器，请检查 Safari 权限与 HTTPS 证书后重试。');
    }
  }, [stop, receive, onScreenChange]);

  useEffect(() => stop, [stop]);
  return { status, message, correction, enable, disable, recalibrate };
}
