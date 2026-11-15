import { useEffect } from 'react';

/**
 * Keeps `--keyboard-inset` on :root at the height the on-screen keyboard
 * covers, from the visual viewport, so the docked formatting bar sits above it.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
