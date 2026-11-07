// The map: a real, Google-Maps-style base map (MapLibre GL + OpenFreeMap
// "Liberty": roads, buildings, parks, water, landmarks and names, anywhere in
// the world when online; a downloaded copy of a 10 km box around the venue
// when offline; see ofmProtocol.ts). Our own layers go on top: the route (with
// the walked part greyed), turn/crossing ticks, a bus ride's stop line, the
// accuracy halo; and HTML markers for "me", the destination and the numbered
// result pins (real buttons).
//
// The map is one labelled region for screen readers; everything it shows is
// also in the cards and the live region. Keyboard (MapLibre's own): arrow keys
// pan, + and - zoom, when the map has focus.
//
// Floating cards cover part of the screen, so every camera move is padded to
// aim at the free area (pad()).

import { LngLatBounds, Map as MlMap, Marker, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { LatLng, PlaceCategory, Route } from '../contracts';
import { distance, pointAlong } from '../geo/geo';
import type { PackIndex } from '../pack/pack';
import { registerOfmProtocol, STYLE_URL } from './ofmProtocol';

export const CATEGORY_COLOR: Record<string, string> = {
  cafe: 'oklch(0.58 0.15 55)', restaurant: 'oklch(0.58 0.15 55)', shop: 'oklch(0.5 0.15 265)', supermarket: 'oklch(0.5 0.15 265)',
  pharmacy: 'oklch(0.52 0.17 15)', hospital: 'oklch(0.52 0.17 15)', toilets: 'oklch(0.5 0.15 310)', atm: 'oklch(0.5 0.12 200)',
  station: 'oklch(0.45 0.12 240)', bus_stop: 'oklch(0.5 0.17 25)', other: '#555555', bench: '#555555',
};
export const categoryColor = (c: PlaceCategory | string) => CATEGORY_COLOR[c] ?? '#555555';

export type MapPalette = 'standard' | 'highContrast';
export const mapBackground = (p: MapPalette) => (p === 'highContrast' ? '#000000' : '#f3f0ea');

const OURS = {
  standard: { route: '#0050c8', routeCase: '#00327d', walked: '#9aaac4', bus: '#c62828', tick: '#ffffff' },
  highContrast: { route: '#00e5ff', routeCase: '#000000', walked: '#5f6b73', bus: '#ff8a80', tick: '#ffffff' },
};

export interface MapPin {
  at: LatLng;
  n: number;
  label: string;
  onClick: () => void;
}

export interface MapCanvasHandle {
  /** Animate to a point; `mpp` is the zoom as metres per screen pixel (0.8 ≈ a few streets). */
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
  /** Extra line, e.g. a bus ride stop to stop, or a public transport journey. */
  line: LatLng[] | null;
  /** Stops to mark on that line (default: every point of the line). */
  lineStops?: LatLng[] | null;
  /** Keep the camera on "me" as it moves. */
  follow: boolean;
  onUserMove: () => void;
  /** Text-size zoom of the cards, so the free area is computed right. */
  uiZoom: number;
  /** Walking mode has a taller banner on top on narrow screens. */
  navMode: boolean;
  label: string;
}

// ---------------------------------------------------------------- zoom ⇄ metres per pixel
const EARTH = 40075016.686;
const zoomFor = (mpp: number, lat: number) => Math.log2((EARTH * Math.cos((lat * Math.PI) / 180)) / (512 * mpp));

// ---------------------------------------------------------------- high-contrast version of the base style
/** Recolour the Liberty style for high contrast: black land, white/yellow roads, white labels with black halos. */
function highContrast(style: StyleSpecification): StyleSpecification {
  const layers = style.layers
    .filter((l) => l.type !== 'raster' && l.type !== 'fill-extrusion' && l.type !== 'hillshade')
    .map((l) => {
      const id = l.id;
      const sl = 'source-layer' in l ? String(l['source-layer'] ?? '') : '';
      const paint: Record<string, unknown> = { ...(l.paint ?? {}) };
      if (l.type === 'background') paint['background-color'] = '#000000';
      if (l.type === 'fill') {
        paint['fill-color'] = /water/.test(id + sl) ? '#062b52' : /building/.test(id + sl) ? '#2a2a2a' : /park|wood|grass|landcover|landuse/.test(id + sl) ? '#0b1f0b' : '#000000';
        paint['fill-opacity'] = 1;
        delete paint['fill-pattern'];
        delete paint['fill-outline-color'];
      }
      if (l.type === 'line') {
        const casing = /casing|outline/.test(id);
        const major = /motorway|trunk|primary|secondary|major/.test(id);
        const foot = /path|foot|pedestrian|track|cycle|steps/.test(id);
        paint['line-color'] = /water|river|canal/.test(id + sl)
          ? '#3a6ea5'
          : sl === 'transportation'
            ? casing ? '#000000' : major ? '#ffd400' : foot ? '#bdbdbd' : '#ffffff'
            : '#777777';
        delete paint['line-pattern'];
      }
      if (l.type === 'symbol') {
        paint['text-color'] = '#ffffff';
        paint['text-halo-color'] = '#000000';
        paint['text-halo-width'] = 2;
      }
      return { ...l, paint } as typeof l;
    });
  return { ...style, layers };
}

// ---------------------------------------------------------------- our layers on top
const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };
const lineFeature = (pts: LatLng[]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: pts.map((p) => [p.lng, p.lat]) } });
const pointsFeature = (pts: LatLng[]) => ({
  type: 'FeatureCollection' as const,
  features: pts.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] } })),
});

function addOurLayers(map: MlMap, palette: MapPalette) {
  const c = OURS[palette];
  // Draw above roads and areas, below the base map's labels.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  for (const id of ['route', 'walked', 'ticks', 'bus', 'busStops', 'halo']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY_FC });
  const add = (layer: Parameters<MlMap['addLayer']>[0], top = false) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer, top ? undefined : firstSymbol);
  };
  add({ id: 'halo', type: 'circle', source: 'halo', paint: { 'circle-color': 'rgba(0,80,200,0.14)', 'circle-stroke-color': 'rgba(0,80,200,0.35)', 'circle-stroke-width': 1, 'circle-radius': 16 } });
  add({ id: 'bus-case', type: 'line', source: 'bus', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.routeCase, 'line-width': 9 } });
  add({ id: 'bus-line', type: 'line', source: 'bus', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.bus, 'line-width': 6, 'line-dasharray': [1.6, 1] } });
  add({ id: 'bus-stops', type: 'circle', source: 'busStops', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': c.bus, 'circle-stroke-width': 2.5 } });
  add({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.routeCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 13] } });
  add({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 9] } });
  add({ id: 'walked-line', type: 'line', source: 'walked', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.walked, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 9] } });
  add({ id: 'route-ticks', type: 'circle', source: 'ticks', minzoom: 14, paint: { 'circle-radius': 4.5, 'circle-color': c.tick, 'circle-stroke-color': c.routeCase, 'circle-stroke-width': 2 } });
}

// ---------------------------------------------------------------- markers
function meElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ml-me';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="map-me-dot"></div><div class="map-me-arrow"><span class="icon icon-fill">navigation</span></div>';
  return el;
}
function destElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ml-dest';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="icon icon-fill">location_on</span>';
  return el;
}

export function MapCanvas(props: MapCanvasProps) {
  const { ref, palette, me, meStyle, route, progress, pins, dest, line, follow, uiZoom, navMode, label } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const meMarker = useRef<Marker | null>(null);
  const destMarker = useRef<Marker | null>(null);
  const pinMarkers = useRef<Marker[]>([]);
  const latest = useRef(props);
  latest.current = props;

  // The free area not covered by cards (the design's pad()).
  const pad = () => {
    const el = boxRef.current;
    const w = el?.clientWidth ?? 1200;
    const h = el?.clientHeight ?? 800;
    const z = latest.current.uiZoom;
    if (w >= 880) return { left: 460 * z, right: 100, top: 60, bottom: 60 };
    return { left: 24, right: 90, top: (latest.current.navMode ? 200 : 160) * z, bottom: Math.min(h * 0.55, 420 * z) };
  };
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // ---- create the map once
  useEffect(() => {
    registerOfmProtocol();
    const map = new MlMap({
      container: boxRef.current!,
      style: STYLE_URL,
      center: [me.lng, me.lat],
      zoom: zoomFor(0.8, me.lat),
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      attributionControl: { compact: true, customAttribution: 'Bus data: TfL Open Data' },
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    const onStyle = () => {
      addOurLayers(map, latest.current.palette);
      readyRef.current = true;
      syncData();
    };
    map.on('style.load', onStyle);
    // A move the person made (drag, wheel, pinch, keys), not one we animated.
    map.on('movestart', (e) => {
      if ((e as { originalEvent?: Event }).originalEvent) latest.current.onUserMove();
    });
    map.on('zoom', syncHalo);
    meMarker.current = new Marker({ element: meElement(), rotationAlignment: 'map' }).setLngLat([me.lng, me.lat]).addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- palette: reload the style (recoloured for high contrast), then re-add our layers
  const firstPalette = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstPalette.current) {
      firstPalette.current = false;
      if (palette === 'standard') return;
    }
    readyRef.current = false;
    map.setStyle(STYLE_URL, { transformStyle: (_prev, next) => (palette === 'highContrast' ? highContrast(next) : next) });
  }, [palette]);

  // ---- our data on the map
  function syncHalo() {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { me: m } = latest.current;
    const mpp = (EARTH * Math.cos((m.lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    map.setPaintProperty('halo', 'circle-radius', Math.max(16, Math.min(80, Math.max(6, m.accuracy) / mpp)));
  }
  function syncData() {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const p = latest.current;
    const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
    src('route')?.setData(p.route ? lineFeature(p.route.path) : EMPTY_FC);
    let walked: LatLng[] = [];
    if (p.route && p.progress != null && p.progress > 0) {
      walked = [p.route.path[0]];
      let acc = 0;
      for (let i = 1; i < p.route.path.length; i++) {
        const seg = distance(p.route.path[i - 1], p.route.path[i]);
        if (acc + seg > p.progress) break;
        acc += seg;
        walked.push(p.route.path[i]);
      }
      walked.push(pointAlong(p.route.path, p.progress).point);
    }
    src('walked')?.setData(walked.length > 1 ? lineFeature(walked) : EMPTY_FC);
    src('ticks')?.setData(p.route ? pointsFeature(p.route.waypoints.filter((w) => w.kind === 'turn' || w.kind === 'crossing')) : EMPTY_FC);
    src('bus')?.setData(p.line && p.line.length > 1 ? lineFeature(p.line) : EMPTY_FC);
    src('busStops')?.setData(p.lineStops ? pointsFeature(p.lineStops) : p.line ? pointsFeature(p.line) : EMPTY_FC);
    src('halo')?.setData(pointsFeature([p.me]));
    syncHalo();
  }
  useEffect(syncData, [route, progress, line, props.lineStops, me.lat, me.lng, me.accuracy]);

  // ---- markers
  useEffect(() => {
    const el = meMarker.current?.getElement();
    meMarker.current?.setLngLat([me.lng, me.lat]).setRotation(meStyle === 'arrow' ? (me.heading ?? 0) : 0);
    el?.classList.toggle('arrow', meStyle === 'arrow');
  }, [me.lat, me.lng, me.heading, meStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    destMarker.current?.remove();
    destMarker.current = dest ? new Marker({ element: destElement(), anchor: 'bottom', offset: [0, 4] }).setLngLat([dest.lng, dest.lat]).addTo(map) : null;
  }, [dest?.lat, dest?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of pinMarkers.current) m.remove();
    pinMarkers.current = pins.map((pin) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-pin';
      b.textContent = String(pin.n);
      b.setAttribute('aria-label', pin.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pin.onClick();
      });
      return new Marker({ element: b }).setLngLat([pin.at.lng, pin.at.lat]).addTo(map);
    });
  }, [pins]);

  // ---- accessible name of the map
  useEffect(() => {
    mapRef.current?.getCanvas().setAttribute('aria-label', `${label}. Use arrow keys to pan, plus and minus to zoom.`);
  }, [label]);

  // ---- follow "me" while walking or riding
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow) return;
    map.easeTo({ center: [me.lng, me.lat], padding: pad(), duration: reduced() ? 0 : 900, easing: (t) => t });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, me.lat, me.lng, uiZoom, navMode]);

  // ---- camera commands from the shell
  useImperativeHandle(ref, () => ({
    flyTo: (p, mpp, ms = 700) => {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({ center: [p.lng, p.lat], zoom: mpp ? zoomFor(mpp, p.lat) : map.getZoom(), padding: pad(), duration: reduced() ? 0 : ms, essential: true });
    },
    fitPoints: (points, margin = 40) => {
      const map = mapRef.current;
      if (!map || !points.length) return;
      const b = new LngLatBounds();
      for (const p of points) b.extend([p.lng, p.lat]);
      const pd = pad();
      const extra = 24 + Math.min(80, margin);
      map.fitBounds(b, {
        padding: { left: pd.left + extra, right: pd.right + extra, top: pd.top + extra, bottom: pd.bottom + extra },
        maxZoom: 17.5,
        duration: reduced() ? 0 : 700,
      });
    },
    zoomBy: (f) => {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ zoom: map.getZoom() - Math.log2(f), duration: reduced() ? 0 : 250 });
    },
  }));

  return <div ref={boxRef} className="map" style={{ background: mapBackground(palette) }} />;
}
