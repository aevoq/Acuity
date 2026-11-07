#!/usr/bin/env node
// Download a SUBSET of the Material Symbols Rounded icon font containing only
// the icons the UI uses, and save it into src/assets/fonts/. The full font is
// about 13 MB; the subset is a few KB. Committed, so the icons work offline
// (the design loaded them from Google Fonts, which fails with Wi-Fi off).
//
//   node scripts/fonts/fetch-icons.mjs
//
// Added an icon to the UI? Add its name to ICONS and run this again.
// Icon names: https://fonts.google.com/icons

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICONS = [
  'accessible', 'add', 'add_road', 'alt_route', 'arrow_back', 'call', 'chair', 'check_circle', 'chevron_right',
  'close', 'cloud_done', 'cloud_off', 'directions_bus', 'directions_walk', 'explore', 'flag', 'format_list_bulleted',
  'gps_not_fixed', 'local_atm', 'local_cafe', 'local_hospital', 'local_pharmacy', 'location_on', 'my_location',
  'navigation', 'notifications_active', 'pause', 'person_pin_circle', 'place', 'play_arrow', 'record_voice_over',
  'remove', 'replay', 'restaurant', 'schedule', 'search', 'settings', 'shopping_cart', 'sms', 'speed', 'stop_circle',
  'storefront', 'straight', 'straighten', 'traffic', 'train', 'turn_left', 'turn_right', 'turn_sharp_left',
  'turn_sharp_right', 'turn_slight_left', 'turn_slight_right', 'u_turn_left', 'warning', 'wc', 'wrong_location',
  'subway', 'tram', 'commute', 'local_taxi', 'content_copy', 'open_in_new', 'arrow_forward', 'check',
  'photo_camera', 'mic', 'videocam_off', 'visibility', 'question_answer',
  'volume_off', 'mic_off', 'graphic_eq', 'keyboard',
];

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/assets/fonts/material-symbols-rounded-subset.woff2');
// A current Chrome user agent, so Google serves woff2.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function main() {
  const names = [...new Set(ICONS)].sort(); // Google requires alphabetical order
  const css = await (
    await fetch(
      `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,500,0..1,0&icon_names=${names.join(',')}&display=block`,
      { headers: { 'user-agent': UA } },
    )
  ).text();
  const url = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
  if (!url) throw new Error(`No font URL in Google's CSS:\n${css.slice(0, 400)}`);
  const font = Buffer.from(await (await fetch(url)).arrayBuffer());
  await writeFile(OUT, font);
  console.log(`Saved ${names.length} icons, ${(font.length / 1024).toFixed(1)} KB → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
