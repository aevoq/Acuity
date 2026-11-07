// The safety check every camera or model answer passes before it is spoken
// (ADR-013, principle 1: never say "safe to cross"). A model can be told not
// to judge safety; this makes sure, in code, that it never reaches the person.

/** What we say instead of any safety judgement. */
export const ADVISORY =
  "I can't tell you when it is safe to cross. Use your cane or dog, listen to the traffic, and feel for the rotating cone under the push-button box.";

const UNSAFE = [
  /\b(it'?s|it is|that'?s|looks|seems|now)\s+(safe|clear|okay|ok|fine)\s+(to\s+)?(cross|go|walk)/i,
  /\bsafe\s+to\s+(cross|go|walk|proceed)/i,
  /\byou\s+(can|may|should|could)\s+(now\s+)?(cross|go|walk|proceed)\b/i,
  /\b(go|cross)\s+(now|ahead)\b/i,
  /\bno\s+(cars?|traffic|vehicles?)\s+(are\s+)?(coming|approaching)\b/i,
  /\b(the\s+)?road\s+is\s+(clear|empty)\b/i,
];

/**
 * The camera saying the way is clear, or telling the person to walk on. A camera misses
 * kerbs, poles and glass, so a vision model never gets to say this as a fact (Abdullah's
 * assistant softens one form of it; these catch the others).
 */
export const PATH_ADVISORY = 'The camera can miss things, so check the way with your cane or dog.';
const CLEAR_CLAIMS = [
  /\b(path|way|route|floor|ground|pavement|area|road)\b[^.!?]*\b(is|looks|appears|seems)\s+(completely\s+|totally\s+|fully\s+)?(clear|empty|free|unobstructed|safe)\b/i,
  /\bno\s+(visible\s+|other\s+)?(objects?|obstacles?|obstructions?|hazards?|dangers?)\b/i,
  /\b(clear|unobstructed)\s+(path|way|route)\b/i,
  /\bnothing\s+(is\s+)?(in|blocking)\s+(your|the)\s+(way|path)\b/i,
  /\b(continue|keep|carry on)\s+((walking|going|moving)\s+)?(straight\s+)?(ahead|forward|on|walking|going)\b/i,
  /\b(walk|move|step|head)\s+(straight\s+)?(forward|ahead|on)\b/i,
];
/** A hedged sentence is honest ("I can't see anything in your way, but the camera can miss things"). */
const HEDGED = /\b(miss|cane|guide dog|can'?t be sure|cannot be sure|not sure|might not|may not)\b/i;
export function isClearClaim(sentence: string): boolean {
  return !HEDGED.test(sentence) && CLEAR_CLAIMS.some((re) => re.test(sentence));
}

/** "can't tell you", "not safe", "never say"…: a refusal or a warning, not a judgement. */
const NEGATED = new RegExp(
  [
    // "I can't tell you when it is …", "I cannot say whether it is …", "unable to judge if it's …"
    String.raw`\b(can'?t|cannot|can not|unable to|won'?t|never|don'?t)\s+(tell|say|know|judge|confirm|promise|guarantee|be sure)\b[^.!?]{0,30}$`,
    // "… is not / isn't / never …" right before "safe"
    String.raw`\b(not|isn'?t|never|n'?t)\s+(be\s+)?$`,
  ].join('|'),
  'i',
);

export function isUnsafe(text: string): boolean {
  return UNSAFE.some((re) => {
    const m = re.exec(text);
    if (!m) return false;
    // Only a statement about "safe" can be negated ("I can't tell you when it is safe to cross").
    // "It's not dangerous, you can cross" is still a go signal.
    const safeAt = m[0].toLowerCase().indexOf('safe');
    if (safeAt < 0) return true;
    return !NEGATED.test(text.slice(0, m.index + safeAt));
  });
}

/**
 * Make a model's answer safe to speak: any sentence that judges crossing safety is replaced
 * by the advisory (once); a claim that the way is clear, or a "keep walking", by the path
 * advisory (once, unless the answer already says the camera can miss things). Then cut to `maxWords`.
 */
export function makeSafe(text: string, maxWords = 60): string {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  let crossing = false;
  let path = /camera can miss things/i.test(text);
  const out: string[] = [];
  for (const raw of sentences) {
    // A piece cut at a comma upstream can start "and the ground…": start it properly.
    const s = raw.replace(/^(and|but|so)\s+([a-z])/i, (_m, _w, c: string) => c.toUpperCase());
    if (isUnsafe(s)) {
      if (!crossing) out.push(ADVISORY);
      crossing = true;
    } else if (isClearClaim(s)) {
      if (!path) out.push(PATH_ADVISORY);
      path = true;
    } else out.push(s);
  }
  const words = out.join(' ').split(' ');
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '')}…` : words.join(' ');
}
