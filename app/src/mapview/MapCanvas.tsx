// Full-screen map, drawn from the area pack as SVG: no tiles, works offline.
// A port of the Claude Design renderer ("Offline Navigation Map") onto our
// PackIndex: road casings by class, street labels, POI dots and crossings by
// zoom, the route with the walked part greyed, numbered result pins, the
// destination pin, and "me" as a heading arrow while walking.
//
// Camera: {x, y, mpp}: world metres east/SOUTH of the pack centre, and
// metres per screen pixel. Floating cards cover part of the screen, so every
// "centre on" call aims at the middle of the free area (pad()).
//
// It is one labelled image for screen readers; everything it shows is also in
// the cards and the live region. Keyboard: arrows pan, + and - zoom.

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type Ref } from 'react';
import type { LatLng, PlaceCategory, Route } from '../contracts';
import { distance, makeProjection, pointAlong } from '../geo/geo';
import type { PackIndex } from '../pack/pack';

type RoadClass = 'trunk' | 'major' | 'minor' | 'service' | 'foot' | 'steps';
const CLASS_OF: Record<string, RoadClass> = {
  trunk: 'trunk', trunk_link: 'trunk', primary: 'trunk', primary_link: 'trunk',
  secondary: 'major', secondary_link: 'major', tertiary: 'major', tertiary_link: 'major',
  residential: 'minor', unclassified: 'minor', living_street: 'minor',
  service: 'service', track: 'service',
  footway: 'foot', path: 'foot', pedestrian: 'foot', cycleway: 'foot', corridor: 'foot', crossing: 'foot',
  steps: 'steps',
};

export const CATEGORY_COLOR: Record<string, string> = {
  cafe: 'oklch(0.58 0.15 55)', restaurant: 'oklch(0.58 0.15 55)', shop: 'oklch(0.5 0.15 265)', supermarket: 'oklch(0.5 0.15 265)',
  pharmacy: 'oklch(0.52 0.17 15)', hospital: 'oklch(0.52 0.17 15)', toilets: 'oklch(0.5 0.15 310)', atm: 'oklch(0.5 0.12 200)',
  station: 'oklch(0.45 0.12 240)', bus_stop: 'oklch(0.5 0.17 25)', other: '#555555', bench: '#555555',
};
export const categoryColor = (c: PlaceCategory | string) => CATEGORY_COLOR[c] ?? '#555555';

const PALETTES = {
  standard: {
    bg: '#f3f0ea', foot: '#a59f93', service: '#ffffff', serviceCase: '#dcd6ca', minor: '#ffffff', minorCase: '#d3ccbf',
    major: '#ffe7a3', majorCase: '#e3bd5f', trunk: '#fdd27a', trunkCase: '#d19c35', steps: '#6b3fa0', label: '#3a362f',
    labelHalo: '#ffffff', route: '#0050c8', routeCase: '#00327d', walked: '#9aaac4', dotRing: '#ffffff', sig: '#1b7f3a',
    cross: '#555555', bus: '#c62828',
  },
  highContrast: {
    bg: '#000000', foot: '#bdbdbd', service: '#cfcfcf', serviceCase: '#000000', minor: '#ffffff', minorCase: '#000000',
    major: '#ffd400', majorCase: '#000000', trunk: '#ffb000', trunkCase: '#000000', steps: '#ff7bff', label: '#ffffff',
    labelHalo: '#000000', route: '#00e5ff', routeCase: '#000000', walked: '#5f6b73', dotRing: '#000000', sig: '#6fdc8c',
    cross: '#ffffff', bus: '#ff8a80',
  },
} as const;
export type MapPalette = keyof typeof PALETTES;
export const mapBackground = (p: MapPalette) => PALETTES[p].bg;

export interface MapPin {
  at: LatLng;
  n: number;
  label: string;
  onClick: () => void;
}

export interface MapCanvasHandle {
  /** Animate to a point (and optionally a zoom, metres per pixel). */
  flyTo(p: LatLng, mpp?: number, ms?: number): void;
  /** Fit these points into the free area. */
  fitPoints(points: LatLng[], marginMeters?: number): void;
  zoomBy(factor: number): void;
}

export interface MapCanvasProps {
  ref?: Ref<MapCanvasHandle>;
  index: PackIndex;
  palette: MapPalette;
  me: LatLng & { heading: number | null; accuracy: number };
  meStyle: 'arrow' | 'dot';
  route: Route | null;
  /** Metres walked along the route, to grey out (null = not walking). */
  progress: number | null;
  pins: MapPin[];
  dest: LatLng | null;
  /** Extra line, e.g. a bus ride stop to stop. */
  line: LatLng[] | null;
  /** Keep the camera on "me" as it moves. */
  follow: boolean;
  onUserMove: () => void;
  /** Text-size zoom of the cards, so the free area is computed right. */
  uiZoom: number;
  /** Walking mode has a taller banner on top on narrow screens. */
  navMode: boolean;
  label: string;
}

/** World coordinates: metres east (x) and south (y) of the pack centre. */
function useWorld(index: PackIndex) {
  return useMemo(() => {
    const proj = makeProjection(index.pack.center);
    return {
      toW: (p: LatLng): [number, number] => {
        const { x, y } = proj.toXY(p);
        return [x, -y];
      },
    };
  }, [index]);
}

/** Everything that depends only on the pack: built once. */
function useLayers(index: PackIndex, toW: (p: LatLng) => [number, number]) {
  return useMemo(() => {
    const groups: Record<RoadClass, string[]> = { trunk: [], major: [], minor: [], service: [], foot: [], steps: [] };
    const best = new Map<string, { name: string; x: number; y: number; r: number; L: number }>();
    for (const e of index.pack.edges) {
      const pts = index.edgeLine(e, e.from).map(toW);
      const cls = e.steps ? 'steps' : (CLASS_OF[e.roadClass] ?? 'minor');
      groups[cls].push('M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L'));
      // Street labels on the longest straight piece, one per name per 350 m cell.
      if (e.name && (cls === 'trunk' || cls === 'major' || cls === 'minor')) {
        let seg: { L: number; x: number; y: number; dx: number; dy: number } | null = null;
        for (let k = 1; k < pts.length; k++) {
          const dx = pts[k][0] - pts[k - 1][0];
          const dy = pts[k][1] - pts[k - 1][1];
          const L = Math.hypot(dx, dy);
          if (!seg || L > seg.L) seg = { L, x: (pts[k][0] + pts[k - 1][0]) / 2, y: (pts[k][1] + pts[k - 1][1]) / 2, dx, dy };
        }
        if (seg) {
          const key = `${e.name}|${Math.floor(seg.x / 350)},${Math.floor(seg.y / 350)}`;
          const cur = best.get(key);
          if (!cur || cur.L < seg.L) {
            let r = (Math.atan2(seg.dy, seg.dx) * 180) / Math.PI;
            if (r > 90) r -= 180;
            if (r < -90) r += 180;
            best.set(key, { name: e.name, x: seg.x, y: seg.y, r, L: seg.L });
          }
        }
      }
    }
    const roads = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.join('')])) as Record<RoadClass, string>;
    const labels = [...best.values()].sort((a, b) => b.L - a.L);
    const crossings = index.pack.nodes.filter((n) => n.crossing).map((n) => ({ w: toW(n), signals: n.crossing!.type === 'traffic_signals' }));
    const dots = [
      ...index.pack.places.map((p) => ({ w: toW(p), color: categoryColor(p.category), name: p.name })),
      ...index.pack.busStops.map((s) => ({ w: toW(s), color: categoryColor('bus_stop'), name: s.name })),
    ];
    return { roads, labels, crossings, dots };
  }, [index, toW]);
}

interface Cam {
  x: number;
  y: number;
  mpp: number;
}

export function MapCanvas(props: MapCanvasProps) {
  const { ref, index, palette, me, meStyle, route, progress, pins, dest, line, follow, onUserMove, uiZoom, navMode, label } = props;
  const { toW } = useWorld(index);
  const layers = useLayers(index, toW);
  const c = PALETTES[palette];
  const hc = palette === 'highContrast';

  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, mpp: 1.1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const anim = useRef<{ from: Cam; to: Cam; t0: number; ms: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The free area not covered by cards (from the design's pad()).
  const pad = () => {
    const { w, h } = sizeRef.current;
    if (w >= 880) return { l: 460 * uiZoom, r: 100, t: 60, b: 60 };
    return { l: 24, r: 90, t: (navMode ? 200 : 160) * uiZoom, b: Math.min(h * 0.55, 420 * uiZoom) };
  };

  const animate = () => {
    cancelAnimationFrame(raf.current);
    const step = (t: number) => {
      const a = anim.current;
      if (!a) return;
      const k = Math.min(1, (t - a.t0) / a.ms);
      const e = 1 - Math.pow(1 - k, 3);
      const lm = Math.log(a.from.mpp) + (Math.log(a.to.mpp) - Math.log(a.from.mpp)) * e;
      setCam({ x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e, mpp: Math.exp(lm) });
      if (k < 1) raf.current = requestAnimationFrame(step);
      else anim.current = null;
    };
    raf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /** Camera that puts world point (x, y) in the middle of the free area. */
  const camFor = (x: number, y: number, mpp: number): Cam => {
    const p = pad();
    const { w, h } = sizeRef.current;
    const fx = p.l + (w - p.l - p.r) / 2;
    const fy = p.t + (h - p.t - p.b) / 2;
    return { x: x - (fx - w / 2) * mpp, y: y - (fy - h / 2) * mpp, mpp };
  };

  const flyToW = (x: number, y: number, mpp?: number, ms = 700) => {
    const m = mpp ?? camRef.current.mpp;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ms = 1;
    anim.current = { from: { ...camRef.current }, to: camFor(x, y, m), t0: performance.now(), ms };
    animate();
  };

  const zoomBy = (f: number, sx?: number, sy?: number) => {
    const { w, h } = sizeRef.current;
    const c0 = camRef.current;
    const m = Math.min(5, Math.max(0.12, c0.mpp * f));
    const ox = (sx ?? w / 2) - w / 2;
    const oy = (sy ?? h / 2) - h / 2;
    const wx = c0.x + ox * c0.mpp;
    const wy = c0.y + oy * c0.mpp;
    anim.current = null;
    setCam({ x: wx - ox * m, y: wy - oy * m, mpp: m });
  };

  useImperativeHandle(ref, () => ({
    flyTo: (p, mpp, ms) => {
      const [x, y] = toW(p);
      flyToW(x, y, mpp, ms);
    },
    fitPoints: (points, margin = 40) => {
      if (!points.length) return;
      const ws = points.map(toW);
      const xs = ws.map((p) => p[0]);
      const ys = ws.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin];
      const p = pad();
      const { w, h } = sizeRef.current;
      const W = Math.max(100, w - p.l - p.r);
      const H = Math.max(100, h - p.t - p.b);
      const mpp = Math.min(4, Math.max(0.25, Math.max((x1 - x0) / W, (y1 - y0) / H) * 1.2));
      flyToW((x0 + x1) / 2, (y0 + y1) / 2, mpp);
    },
    zoomBy: (f) => zoomBy(f),
  }));

  // Follow "me" while walking or riding.
  const meW = toW(me);
  useEffect(() => {
    if (!follow || anim.current) return;
    setCam(camFor(meW[0], meW[1], camRef.current.mpp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, meW[0], meW[1], size.w, size.h, uiZoom, navMode]);

  // ---- input: drag, pinch, wheel, keys
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ cam: Cam; pts: Map<number, { x: number; y: number }> } | null>(null);
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { cam: { ...camRef.current }, pts: new Map(pointers.current) };
    anim.current = null;
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !drag.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = [...drag.current.pts.values()];
    const b = [...pointers.current.values()];
    const c0 = drag.current.cam;
    if (a.length >= 2 && b.length >= 2) {
      const d0 = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      const d1 = Math.hypot(b[0].x - b[1].x, b[0].y - b[1].y);
      setCam({ x: c0.x, y: c0.y, mpp: Math.min(5, Math.max(0.12, (c0.mpp * d0) / Math.max(1, d1))) });
    } else {
      const p0 = a[0];
      const p1 = pointers.current.get(e.pointerId)!;
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 3) return;
      setCam({ x: c0.x - (p1.x - p0.x) * c0.mpp, y: c0.y - (p1.y - p0.y) * c0.mpp, mpp: c0.mpp });
    }
    onUserMove();
  };
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    drag.current = pointers.current.size ? { cam: { ...camRef.current }, pts: new Map(pointers.current) } : null;
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const rc = e.currentTarget.getBoundingClientRect();
    zoomBy(Math.pow(1.0018, e.deltaY), e.clientX - rc.left, e.clientY - rc.top);
    if (!navMode) onUserMove();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const st = 90 * cam.mpp;
    const mv = ({ ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] } as Record<string, number[]>)[e.key];
    if (mv) {
      e.preventDefault();
      anim.current = null;
      setCam({ ...cam, x: cam.x + mv[0], y: cam.y + mv[1] });
      onUserMove();
    } else if (e.key === '+' || e.key === '=') zoomBy(1 / 1.4);
    else if (e.key === '-') zoomBy(1.4);
  };

  // ---- what to draw at this camera
  const { w, h } = size;
  const m = cam.mpp;
  const zf = Math.min(2.4, Math.max(0.55, Math.pow(0.6 / m, 0.6)));
  const px = (v: number) => v * m;
  const k = hc ? 1.35 : 1;
  const sw = {
    foot: px(1.6 * zf * k), service: px(3 * zf * k), serviceCase: px(3 * zf * k + 2), minor: px(5.5 * zf * k), minorCase: px(5.5 * zf * k + 2),
    major: px(7.5 * zf * k), majorCase: px(7.5 * zf * k + 2.5), trunk: px(9 * zf * k), trunkCase: px(9 * zf * k + 2.5), steps: px(3 * zf),
    route: px(7 * Math.max(1, zf * 0.8)), routeCase: px(7 * Math.max(1, zf * 0.8) + 3), label: px(hc ? 15 : 13), labelHalo: px(4), poi: px(13),
    dotR: px(5.5), dotRing: px(1.8), crossR: px(3), tickR: px(4.5), tickRing: px(2),
  };
  const vw = w * m;
  const vh = h * m;
  const x0 = cam.x - vw / 2;
  const y0 = cam.y - vh / 2;
  const inView = (x: number, y: number) => x > x0 && x < x0 + vw && y > y0 && y < y0 + vh;
  const toS = (wx: number, wy: number) => ({ sx: (wx - cam.x) / m + w / 2, sy: (wy - cam.y) / m + h / 2 });

  const labels: typeof layers.labels = [];
  if (m < 1.6) {
    const charW = hc ? 8.6 : 7.4;
    for (const l of layers.labels) {
      if (labels.length > 70) break;
      if (inView(l.x, l.y) && l.L / m > l.name.length * charW + 16) labels.push(l);
    }
  }
  const dots: typeof layers.dots = [];
  if (m < 0.9) for (const d of layers.dots) {
    if (dots.length > 260) break;
    if (inView(d.w[0], d.w[1])) dots.push(d);
  }
  const dotLabels = m < 0.3 ? dots.slice(0, 50) : [];
  const crossings: typeof layers.crossings = [];
  if (m < 0.55) for (const cr of layers.crossings) {
    if (crossings.length > 400) break;
    if (inView(cr.w[0], cr.w[1])) crossings.push(cr);
  }

  const dStr = (pts: LatLng[]) => (pts.length > 1 ? 'M' + pts.map((p) => toW(p).map((v) => v.toFixed(1)).join(' ')).join('L') : '');
  const routeD = route ? dStr(route.path) : '';
  let walkedD = '';
  if (route && progress != null && progress > 0) {
    // The part already walked: every vertex before `progress`, then the exact point.
    const pts: LatLng[] = [route.path[0]];
    let acc = 0;
    for (let i = 1; i < route.path.length; i++) {
      const seg = distance(route.path[i - 1], route.path[i]);
      if (acc + seg > progress) break;
      acc += seg;
      pts.push(route.path[i]);
    }
    pts.push(pointAlong(route.path, progress).point);
    walkedD = dStr(pts);
  }
  const ticks = route && m < 1.2 ? route.waypoints.filter((wp) => wp.kind === 'turn' || wp.kind === 'crossing').map((wp) => toW(wp)) : [];
  const lineD = line ? dStr(line) : '';

  const meS = toS(meW[0], meW[1]);
  const halo = Math.max(16, Math.min(80, Math.max(6, me.accuracy) / m));
  const destS = dest ? toS(...toW(dest)) : null;

  return (
    <div
      ref={boxRef}
      className="map"
      tabIndex={0}
      role="region"
      aria-label="Map. Use arrow keys to pan, plus and minus to zoom."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKey}
      style={{ background: c.bg }}
    >
      <svg role="img" aria-label={label} width="100%" height="100%" viewBox={`${x0} ${y0} ${vw} ${vh}`}>
        <path d={layers.roads.foot} fill="none" stroke={c.foot} strokeWidth={sw.foot} strokeDasharray={`${px(3)} ${px(3)}`} strokeLinecap="round" />
        <path d={layers.roads.service} fill="none" stroke={c.serviceCase} strokeWidth={sw.serviceCase} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.minor} fill="none" stroke={c.minorCase} strokeWidth={sw.minorCase} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.major} fill="none" stroke={c.majorCase} strokeWidth={sw.majorCase} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.trunk} fill="none" stroke={c.trunkCase} strokeWidth={sw.trunkCase} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.service} fill="none" stroke={c.service} strokeWidth={sw.service} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.minor} fill="none" stroke={c.minor} strokeWidth={sw.minor} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.major} fill="none" stroke={c.major} strokeWidth={sw.major} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.trunk} fill="none" stroke={c.trunk} strokeWidth={sw.trunk} strokeLinecap="round" strokeLinejoin="round" />
        <path d={layers.roads.steps} fill="none" stroke={c.steps} strokeWidth={sw.steps} strokeDasharray={`${px(1.5)} ${px(2.5)}`} />
        {crossings.map((cr, i) => (
          <circle key={i} cx={cr.w[0]} cy={cr.w[1]} r={sw.crossR} fill={cr.signals ? c.sig : c.cross} />
        ))}
        {labels.map((l, i) => (
          <text key={i} transform={`translate(${l.x} ${l.y}) rotate(${l.r})`} textAnchor="middle" dominantBaseline="central" fontSize={sw.label}
            fontWeight={700} fill={c.label} stroke={c.labelHalo} strokeWidth={sw.labelHalo} paintOrder="stroke" strokeLinejoin="round" pointerEvents="none">
            {l.name}
          </text>
        ))}
        {dots.map((d, i) => (
          <circle key={i} cx={d.w[0]} cy={d.w[1]} r={sw.dotR} fill={d.color} stroke={c.dotRing} strokeWidth={sw.dotRing} />
        ))}
        {dotLabels.map((d, i) => (
          <text key={i} x={d.w[0] + 9 * m} y={d.w[1]} dominantBaseline="central" fontSize={sw.poi} fill={d.color} stroke={c.labelHalo}
            strokeWidth={sw.labelHalo} paintOrder="stroke" fontWeight={700} pointerEvents="none">
            {d.name}
          </text>
        ))}
        {lineD && (
          <>
            <path d={lineD} fill="none" stroke={c.routeCase} strokeWidth={sw.routeCase} strokeLinecap="round" strokeLinejoin="round" />
            <path d={lineD} fill="none" stroke={c.bus} strokeWidth={sw.route} strokeDasharray={`${px(10)} ${px(6)}`} strokeLinecap="round" strokeLinejoin="round" />
            {line!.map((p, i) => {
              const [x, y] = toW(p);
              return <circle key={i} cx={x} cy={y} r={sw.tickR} fill="#ffffff" stroke={c.bus} strokeWidth={sw.tickRing} />;
            })}
          </>
        )}
        {routeD && (
          <>
            <path d={routeD} fill="none" stroke={c.routeCase} strokeWidth={sw.routeCase} strokeLinecap="round" strokeLinejoin="round" />
            <path d={routeD} fill="none" stroke={c.route} strokeWidth={sw.route} strokeLinecap="round" strokeLinejoin="round" />
            {walkedD && <path d={walkedD} fill="none" stroke={c.walked} strokeWidth={sw.route} strokeLinecap="round" strokeLinejoin="round" />}
            {ticks.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={sw.tickR} fill="#ffffff" stroke={c.routeCase} strokeWidth={sw.tickRing} />
            ))}
          </>
        )}
      </svg>

      {pins.map((pin) => {
        const s = toS(...toW(pin.at));
        if (s.sx < -40 || s.sx > w + 40 || s.sy < -40 || s.sy > h + 40) return null;
        return (
          <button key={pin.n} type="button" className="map-pin" aria-label={pin.label} onClick={pin.onClick} style={{ left: s.sx, top: s.sy }}>
            {pin.n}
          </button>
        );
      })}
      {destS && (
        <div className="map-dest" aria-hidden="true" style={{ left: destS.sx, top: destS.sy }}>
          <span className="icon icon-fill">location_on</span>
        </div>
      )}
      <div className="map-me" aria-hidden="true" style={{ left: meS.sx, top: meS.sy }}>
        <div className="map-me-halo" style={{ left: -halo, top: -halo, width: halo * 2, height: halo * 2 }} />
        {meStyle === 'arrow' ? (
          <div className="map-me-arrow" style={{ transform: `rotate(${Math.round(me.heading ?? 0)}deg)` }}>
            <span className="icon icon-fill">navigation</span>
          </div>
        ) : (
          <div className="map-me-dot" />
        )}
      </div>
    </div>
  );
}
