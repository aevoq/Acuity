// Shared contract for the whole app. Every folder talks to every other folder
// through these types and nothing else.
//
// RULE: do not change this file without telling the other two people first.
// Adding an optional field is usually safe; renaming or removing one is not.
//
// Units, everywhere: metres, seconds, degrees. Bearings are degrees clockwise
// from north (0 = north, 90 = east). Coordinates are WGS84 lat/lng.

// ---------------------------------------------------------------------------
// Geometry and position
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

/** One position reading, from real GPS or the simulated walk. */
export interface Position extends LatLng {
  /** Horizontal accuracy in metres (GPS's 1-sigma radius). Worse than 30 m = "poor GPS". */
  accuracy: number;
  /** Direction of travel or compass heading, degrees from north. null when unknown (standing still, no compass). */
  heading: number | null;
  /** Metres per second, or null when unknown. */
  speed: number | null;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Where this reading came from. The UI must label 'simulated' clearly. */
  source: 'gps' | 'simulated';
}

/**
 * Navigation never reads GPS directly. It subscribes to a PositionSource,
 * which is either the simulated walk (src/sim) or real GPS (navigator.geolocation).
 * Swapping one for the other must need no change in navigation code.
 */
export interface PositionSource {
  readonly kind: 'gps' | 'simulated';
  start(): void;
  stop(): void;
  /** Subscribe to readings. Returns an unsubscribe function. */
  subscribe(listener: (p: Position) => void): () => void;
  /** Last reading, or null before the first one. */
  current(): Position | null;
}

// ---------------------------------------------------------------------------
// Area pack: everything downloaded once, then used offline (F1, ADR-002)
// ---------------------------------------------------------------------------

/** A node in the walking graph. Ids are OSM node ids as strings. */
export interface GraphNode extends LatLng {
  id: string;
  /** Set when this node is itself a crossing point (highway=crossing). */
  crossing?: CrossingInfo;
}

export interface CrossingInfo {
  /** 'traffic_signals' = signal-controlled; 'zebra' / 'marked' / 'uncontrolled' / 'unknown' otherwise. */
  type: 'traffic_signals' | 'zebra' | 'marked' | 'uncontrolled' | 'unknown';
  tactilePaving: boolean | null;
  /** Kerb at the crossing: 'lowered' | 'flush' | 'raised', or null if unknown. */
  kerb: 'lowered' | 'flush' | 'raised' | null;
}

/** An undirected walkable edge between two nodes. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** Length in metres, along the geometry. */
  length: number;
  /** Intermediate points between `from` and `to`, for drawing and turn detection. May be empty. */
  geometry: LatLng[];
  /** Street name if known ("Carpenters Road"), for "where am I" and instructions. */
  name: string | null;
  /** OSM highway value: footway, residential, primary, service, steps, ... */
  roadClass: string;
  steps: boolean;
  lit: boolean | null;
  surface: string | null;
  /** True when this edge is itself a crossing way (footway=crossing). */
  crossing?: CrossingInfo;
}

export type PlaceCategory =
  | 'shop' | 'supermarket' | 'pharmacy' | 'cafe' | 'restaurant' | 'toilets'
  | 'station' | 'bus_stop' | 'bench' | 'atm' | 'hospital' | 'park' | 'other';

export interface Place extends LatLng {
  id: string;
  name: string;
  /** e.g. "Tesco", "Boots". Lets "nearest Tesco" match "Tesco Express". */
  brand: string | null;
  category: PlaceCategory;
  /** The raw OSM tag that set the category, e.g. "shop=supermarket". */
  osmTag: string;
}

export interface BusStop extends LatLng {
  id: string;
  name: string;
  /** TfL NaPTAN id when known, for live arrivals online (F9). */
  naptanId: string | null;
  /** Stop letter as on the flag, e.g. "Stop N". */
  indicator?: string | null;
  /** Direction as TfL words it, e.g. "towards Shadwell". */
  towards?: string | null;
  /** Route numbers that stop here ("25", "339"). */
  lines?: string[];
}

export interface BusRoute {
  id: string;
  /** Route number as spoken: "25", "D8". */
  name: string;
  direction: string;
  /** Ordered stop ids (BusStop.id). */
  stops: string[];
  /** Usual gap between buses, for "usually every 8 to 10 minutes" offline. */
  frequencyMinutes: { min: number; max: number } | null;
  /** Where the bus is going, as on its front ("Shadwell Station"). */
  destination?: string;
  /** How frequencyMinutes was found, so the app can say it honestly. */
  frequencySource?: 'tfl-timetable' | 'estimated-from-arrivals';
}

export interface AreaPack {
  /** Bump when the pack format changes. */
  version: number;
  /** ISO date the data was downloaded. The app says how old it is. */
  createdAt: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
  bounds: { south: number; west: number; north: number; east: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  places: Place[];
  benches: LatLng[];
  busStops: BusStop[];
  busRoutes: BusRoute[];
  /** "© OpenStreetMap contributors" etc. Shown in the UI. */
  attribution: string;
}

// ---------------------------------------------------------------------------
// Profile (stored through the toolkit's Librarian, ADR-009)
// ---------------------------------------------------------------------------

export type RouteProfileId = 'shortest' | 'fewestCrossings' | 'mainRoads' | 'stepFree' | 'restStops';

export interface Profile {
  routeProfile: RouteProfileId;
  /** speechSynthesis rate, 0.5 to 2.0. */
  speechRate: number;
  verbosity: 'concise' | 'normal' | 'detailed';
  /** How directions are described. */
  directionStyle: 'clock' | 'landmarks' | 'metres';
  /** Speak "still on route" every N metres. 0 = off. */
  reassuranceEveryMeters: number;
  earcons: boolean;
  /** On a laptop this drives the on-screen haptic indicator only. */
  haptics: boolean;
  /** True when the person uses a screen reader: never speak over it, use the live region. */
  usesScreenReader: boolean;
  /** Max words for a model's answer (ADR-012: 25 by default). */
  maxAnswerWords: number;
  trustedContact: { name: string; phone: string } | null;
}

// ---------------------------------------------------------------------------
// Routing and guidance (F2, F3, ADR-003)
// ---------------------------------------------------------------------------

export type WaypointKind = 'start' | 'turn' | 'crossing' | 'landmark' | 'bench' | 'busStop' | 'arrive';

export interface Waypoint extends LatLng {
  id: string;
  kind: WaypointKind;
  /** Speak when the user comes within this many metres. */
  triggerRadius: number;
  /** The words to speak, already built from data. "In 30 metres, after the pharmacy, turn left." */
  instruction: string;
  /** Metres from the route start. */
  distanceAlong: number;
  milestone: Milestone | null;
  /** For the screen: a Material Symbols icon name ("turn_left", "traffic", "flag"). */
  icon?: string;
  /** For the screen: short title ("Turn left", "Crossing with signals"). */
  title?: string;
  /** For the screen: the line under the title ("onto Thornton Street", "Tactile paving"). */
  detail?: string;
}

export interface Route {
  profile: RouteProfileId;
  from: LatLng;
  to: LatLng;
  destinationName: string;
  /** The route as a line, start to end. Off-route checks measure against this. */
  path: LatLng[];
  edgeIds: string[];
  lengthMeters: number;
  /** At 1.4 m/s unless the profile says otherwise. */
  durationSeconds: number;
  crossings: number;
  signalledCrossings: number;
  waypoints: Waypoint[];
  /** One-sentence trade-off vs the shortest route. "4 minutes longer, 2 fewer crossings." Null for 'shortest'. */
  tradeOff: string | null;
}

// ---------------------------------------------------------------------------
// Asking the app (F4, ADR-004): the model picks the tool, the data answers
// ---------------------------------------------------------------------------

export type IntentName =
  | 'nearest' | 'aroundMe' | 'leftRight' | 'whereAmI' | 'nextStep' | 'repeat' | 'help' | 'navigateTo'
  | 'nearestBusStop' | 'busArrivals'
  | 'unknown';

export interface Intent {
  name: IntentName;
  /** The words the user said or typed. */
  utterance: string;
  /** nearest / navigateTo: the place or category asked for ("Tesco", "pharmacy"). */
  query?: string;
  /** leftRight: which side was asked about. */
  side?: 'left' | 'right' | 'ahead' | 'behind';
  /** busArrivals: a bus number, if one was named ("25"). */
  line?: string;
  /** 0..1. Below about 0.5 the app asks the user to rephrase. */
  confidence: number;
  /** Who picked the intent. */
  via: 'keywords' | 'local-llm' | 'gemini';
}

/** What a tool returns. `say` is built from data, never written freely by a model. */
export interface ToolResult {
  ok: boolean;
  intent: IntentName;
  /** The sentence to speak and show. */
  say: string;
  /** The places, waypoint or position the answer came from. */
  data?: unknown;
  milestone?: Milestone;
  /** True when the answer is degraded because we are offline ("not live", "online only"). */
  offlineFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Output: speech, earcons, haptics (F5)
// ---------------------------------------------------------------------------

export type Milestone =
  | 'turnAhead' | 'crossingAhead' | 'crossingAccessible' | 'benchNearby'
  | 'busStopPassed' | 'yourStopNext' | 'offRoute' | 'arrived';

export interface SpeakRequest {
  text: string;
  /** Plays the earcon (and haptic indicator) before the words. */
  milestone?: Milestone;
  /** 'interrupt' cuts off what is speaking now (safety prompts, off-route). Default 'queue'. */
  priority?: 'queue' | 'interrupt';
}

// ---------------------------------------------------------------------------
// Camera (F11, ADR-006, ADR-014): advisory only, never a "go" signal
// ---------------------------------------------------------------------------

export interface SceneDescription {
  /** Already passed through the safety validator (ADR-013). */
  text: string;
  /** Only for crossing questions. Never "safe". */
  signalState?: 'red' | 'green' | 'not_visible' | 'unsure';
  confidence: 'low' | 'medium' | 'high';
  model: 'smolvlm' | 'gemini';
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Connectivity (offline is the default, online is a bonus)
// ---------------------------------------------------------------------------

export type NetworkMode = 'online' | 'offline';

export interface Connectivity {
  /** What the app should behave as. Offline when the browser is offline OR the demo switch forces it. */
  mode(): NetworkMode;
  /** The browser's own navigator.onLine, before the demo switch. */
  browserOnline(): boolean;
  /** The on-screen "Wi-Fi off" demo switch. */
  forceOffline(on: boolean): void;
  subscribe(listener: (mode: NetworkMode) => void): () => void;
}
