import { useLayoutEffect } from 'react';

const ACTIVE_CLASS = 'immersive-viewport-active';
const VIEWPORT_VARIABLES = [
  '--immersive-viewport-width',
  '--immersive-viewport-height',
  '--immersive-viewport-left',
  '--immersive-viewport-top',
  '--immersive-viewport-right',
  '--immersive-viewport-bottom',
  '--immersive-layout-width',
  '--immersive-layout-height',
] as const;

function cssSize(value: number, fallback: number): string {
  return `${Math.max(1, Number.isFinite(value) ? value : fallback)}px`;
}

function cssOffset(value: number, fallback = 0): string {
  return `${Number.isFinite(value) ? value : fallback}px`;
}

/** Covers the full viewport while keeping controls inside its visible area. */
export function useImmersiveViewport(immersive: boolean): void {
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    const documentElement = document.documentElement;
    const body = document.body;
    if (!root) return;

    if (!immersive) {
      documentElement.classList.remove(ACTIVE_CLASS);
      body.classList.remove(ACTIVE_CLASS);
      root.classList.remove(ACTIVE_CLASS);
      return;
    }

    const viewport = window.visualViewport;
    const previousScroll = { x: window.scrollX, y: window.scrollY };
    const previous = new Map<string, { value: string; priority: string }>();
    for (const name of VIEWPORT_VARIABLES) {
      previous.set(name, {
        value: documentElement.style.getPropertyValue(name),
        priority: documentElement.style.getPropertyPriority(name),
      });
    }

    documentElement.classList.add(ACTIVE_CLASS);
    body.classList.add(ACTIVE_CLASS);
    root.classList.add(ACTIVE_CLASS);

    const update = () => {
      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right = left + width;
      const bottom = top + height;
      // Keep the raster surface at least as large as the layout viewport and
      // the visible viewport's far edge. The visible viewport only positions
      // controls; it must not shrink the canvas while browser chrome animates.
      const layoutWidth = Math.max(innerWidth, right);
      const layoutHeight = Math.max(innerHeight, bottom);
      documentElement.style.setProperty('--immersive-viewport-width', cssSize(width, innerWidth));
      documentElement.style.setProperty('--immersive-viewport-height', cssSize(height, innerHeight));
      documentElement.style.setProperty('--immersive-viewport-left', cssOffset(left));
      documentElement.style.setProperty('--immersive-viewport-top', cssOffset(top));
      documentElement.style.setProperty('--immersive-viewport-right', cssOffset(right));
      documentElement.style.setProperty('--immersive-viewport-bottom', cssOffset(bottom));
      documentElement.style.setProperty('--immersive-layout-width', cssSize(layoutWidth, innerWidth));
      documentElement.style.setProperty('--immersive-layout-height', cssSize(layoutHeight, innerHeight));
    };

    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };

    // Home Screen launches and bfcache restores can keep an old scroll/viewport
    // offset without firing resize. Restore the full surface before painting.
    const resume = () => {
      window.scrollTo(0, 0);
      update();
      schedule();
    };
    const onVisibility = () => { if (!document.hidden) resume(); };

    resume();
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('orientationchange', schedule, { passive: true });
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', onVisibility);
    viewport?.addEventListener('resize', schedule, { passive: true });
    viewport?.addEventListener('scroll', schedule, { passive: true });

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', onVisibility);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      documentElement.classList.remove(ACTIVE_CLASS);
      body.classList.remove(ACTIVE_CLASS);
      root.classList.remove(ACTIVE_CLASS);
      for (const name of VIEWPORT_VARIABLES) {
        const value = previous.get(name);
        if (value?.value) documentElement.style.setProperty(name, value.value, value.priority);
        else documentElement.style.removeProperty(name);
      }
      window.scrollTo(previousScroll.x, previousScroll.y);
    };
  }, [immersive]);
}
