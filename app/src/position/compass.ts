// Which way the phone points (degrees from north), from the device's compass.
// With it, "what's around me" and "what's on my left" answer in clock
// positions ("at 2 o'clock") instead of compass words. Laptops have no
// compass: nothing happens and the tools say "to the north-east".
//
//   - Android Chrome: 'deviceorientationabsolute' (alpha is from north).
//   - iPhone Safari: 'deviceorientation' with webkitCompassHeading, after
//     permission, which can only be asked from a tap (requestCompassPermission).

type OrientationEventLike = Event & { alpha: number | null; absolute?: boolean; webkitCompassHeading?: number };
type PermissionCtor = { requestPermission?: () => Promise<'granted' | 'denied'> };

let asked = false;

/** Ask for compass access (iPhone). Call from a tap; harmless elsewhere. */
export async function requestCompassPermission(): Promise<void> {
  if (asked) return;
  asked = true;
  const D = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined) as unknown as PermissionCtor | undefined;
  try {
    await D?.requestPermission?.();
  } catch {
    // denied or not supported: the app falls back to compass words
  }
}

/** Follow the compass. Reports only real changes (5° or more), at most ~3 times a second. */
export function startCompass(onHeading: (deg: number) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let last: number | null = null;
  let lastAt = 0;
  const report = (deg: number) => {
    const d = ((deg % 360) + 360) % 360;
    const now = performance.now();
    const diff = last == null ? 360 : Math.abs(((d - last + 540) % 360) - 180);
    if (diff < 5 || now - lastAt < 300) return;
    last = d;
    lastAt = now;
    onHeading(Math.round(d));
  };
  const onAbsolute = (e: Event) => {
    const o = e as OrientationEventLike;
    if (o.alpha != null) report(360 - o.alpha);
  };
  const onIos = (e: Event) => {
    const o = e as OrientationEventLike;
    if (typeof o.webkitCompassHeading === 'number') report(o.webkitCompassHeading);
    else if (o.absolute && o.alpha != null) report(360 - o.alpha);
  };
  window.addEventListener('deviceorientationabsolute', onAbsolute);
  window.addEventListener('deviceorientation', onIos);
  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbsolute);
    window.removeEventListener('deviceorientation', onIos);
  };
}
