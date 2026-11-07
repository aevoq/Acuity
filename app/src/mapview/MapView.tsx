// SVG map drawn straight from the area pack: no map tiles, so it works offline.
// It is for sighted judges and helpers; everything it shows is also spoken or
// in text elsewhere, so the SVG itself is one labelled image for screen readers.
//
// Coordinates: the SVG user space is metres east/north of the pack centre,
// with y flipped (SVG y grows downward). Strokes use non-scaling-stroke, so
// line widths stay in screen pixels at every zoom.

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LatLng, Position, Route } from '../contracts';
import { makeProjection } from '../geo/geo';
import type { PackIndex } from '../pack/pack';
import './map.css';

const MAJOR = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk']);
const FOOT = new Set(['footway', 'path', 'pedestrian', 'cycleway', 'track', 'corridor', 'crossing']);

export interface MapViewProps {
  index: PackIndex;
  route?: Route | null;
  position?: Position | null;
  /** Places to highlight (e.g. the answer to "nearest Tesco"). */
  highlights?: LatLng[];
  /** Follow the position marker. */
  follow?: boolean;
  label?: string;
}

export function MapView({ index, route, position, highlights = [], follow = true, label }: MapViewProps) {
  const { pack } = index;
  const proj = useMemo(() => makeProjection(pack.center), [pack]);
  // SVG space: x east, y SOUTH (flipped).
  const xy = (p: LatLng) => {
    const { x, y } = proj.toXY(p);
    return [x, -y] as const;
  };

  // One path string per road group, built once per pack.
  const layers = useMemo(() => {
    const groups: Record<'major' | 'minor' | 'foot' | 'steps', string[]> = { major: [], minor: [], foot: [], steps: [] };
    for (const e of pack.edges) {
      const line = index.edgeLine(e, e.from);
      const d = 'M' + line.map((p) => xy(p).map((v) => v.toFixed(1)).join(' ')).join('L');
      const g = e.steps ? 'steps' : MAJOR.has(e.roadClass) ? 'major' : FOOT.has(e.roadClass) ? 'foot' : 'minor';
      groups[g].push(d);
    }
    const crossings: Array<readonly [number, number, boolean]> = [];
    for (const n of pack.nodes) if (n.crossing) crossings.push([...xy(n), n.crossing.type === 'traffic_signals'] as const);
    return {
      major: groups.major.join(''),
      minor: groups.minor.join(''),
      foot: groups.foot.join(''),
      steps: groups.steps.join(''),
      crossings,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, index]);

  // Viewport: centre in SVG space + span (metres across the shorter side).
  const [span, setSpan] = useState(600);
  const [manualCenter, setManualCenter] = useState<readonly [number, number] | null>(null);
  const followCenter = position && follow && !manualCenter ? xy(position) : null;
  const center = manualCenter ?? followCenter ?? ([0, 0] as const);

  // Drag to pan.
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; c: readonly [number, number] } | null>(null);
  const onPointerDown = (ev: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: ev.clientX, y: ev.clientY, c: center };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = span / Math.min(rect.width, rect.height);
    setManualCenter([drag.current.c[0] - (ev.clientX - drag.current.x) * scale, drag.current.c[1] - (ev.clientY - drag.current.y) * scale]);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const zoom = (f: number) => setSpan((s) => Math.min(5000, Math.max(100, s * f)));
  const showDetail = span <= 900;

  const routeD = route && route.path.length > 1 ? 'M' + route.path.map((p) => xy(p).join(' ')).join('L') : null;
  const pos = position ? xy(position) : null;

  return (
    <figure className="mapview">
      <svg
        ref={svgRef}
        role="img"
        aria-label={label ?? `Map of ${pack.name}${route ? `, route to ${route.destinationName}` : ''}`}
        viewBox={`${center[0] - span / 2} ${center[1] - span / 2} ${span} ${span}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(ev) => zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15)}
      >
        <path className="map-minor" d={layers.minor} />
        <path className="map-foot" d={layers.foot} />
        <path className="map-major" d={layers.major} />
        <path className="map-steps" d={layers.steps} />
        {showDetail &&
          layers.crossings.map(([x, y, signals], i) => (
            <circle key={i} className={signals ? 'map-crossing-signals' : 'map-crossing'} cx={x} cy={y} r={span / 300} />
          ))}
        {routeD && <path className="map-route" d={routeD} />}
        {route?.waypoints.map((w) => {
          const [x, y] = xy(w);
          return <circle key={w.id} className={`map-wp map-wp-${w.kind}`} cx={x} cy={y} r={span / 140} />;
        })}
        {highlights.map((h, i) => {
          const [x, y] = xy(h);
          return <circle key={i} className="map-highlight" cx={x} cy={y} r={span / 90} />;
        })}
        {pos && (
          <g transform={`translate(${pos[0]} ${pos[1]})`}>
            {position!.accuracy > 0 && <circle className="map-accuracy" r={position!.accuracy} />}
            <circle className="map-me" r={span / 100} />
            {position!.heading != null && (
              <path className="map-heading" transform={`rotate(${position!.heading}) scale(${span / 400})`} d="M0 -14 L5 -4 L-5 -4 Z" />
            )}
          </g>
        )}
      </svg>
      <div className="map-controls">
        <button type="button" onClick={() => zoom(1 / 1.5)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoom(1.5)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setManualCenter(null)} aria-label="Centre on my position">◎</button>
      </div>
      <figcaption className="map-caption">
        {pack.name} · map data {pack.attribution} · downloaded {index.ageDays() === 0 ? 'today' : `${index.ageDays()} days ago`}
      </figcaption>
    </figure>
  );
}
