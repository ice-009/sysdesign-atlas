#!/usr/bin/env node
/* One-off generator for the iPad edition's home-screen icon and launch images.
   The PNGs are committed under ipad/icons/, so the regular build never needs
   this (or sharp). Re-run only when the artwork changes:

     node scripts/ipad/make-icons.mjs
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'ipad', 'icons');

// Full-bleed square — iOS applies its own corner mask, so no rounding here.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101c33"/><stop offset="1" stop-color="#05070d"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.55">
      <stop offset="0" stop-color="#38bdf8" stop-opacity="0.32"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g stroke="#38bdf8" stroke-opacity="0.07" stroke-width="3">
    ${[128, 256, 384, 512, 640, 768, 896].map((v) => `<path d="M${v} 0V1024M0 ${v}H1024"/>`).join('')}
  </g>
  <rect width="1024" height="1024" fill="url(#glow)"/>
  <path d="M300 676 L512 330 L724 676" fill="none" stroke="url(#ink)" stroke-width="62" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M398 556 H626" stroke="#9db4fb" stroke-width="40" stroke-linecap="round" stroke-opacity="0.6"/>
  <circle cx="512" cy="330" r="58" fill="#0b1324" stroke="#7dd3fc" stroke-width="24"/>
  <circle cx="300" cy="676" r="58" fill="#0b1324" stroke="#93c5fd" stroke-width="24"/>
  <circle cx="724" cy="676" r="58" fill="#0b1324" stroke="#a78bfa" stroke-width="24"/>
</svg>`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.svg'), ICON);

for (const size of [180, 192, 512]) {
  await sharp(Buffer.from(ICON)).resize(size, size).png().toFile(path.join(OUT, `icon-${size}.png`));
}

// Launch images for iPad Air 11" (820×1180 pt @2x). iOS shows these while the
// home-screen app boots instead of a blank white frame.
const rounded = await sharp(Buffer.from(ICON))
  .resize(240, 240)
  .composite([{
    input: Buffer.from('<svg width="240" height="240"><rect width="240" height="240" rx="54" ry="54"/></svg>'),
    blend: 'dest-in',
  }])
  .png()
  .toBuffer();

for (const [w, h] of [[1640, 2360], [2360, 1640]]) {
  await sharp({ create: { width: w, height: h, channels: 4, background: '#07090e' } })
    .composite([{ input: rounded, gravity: 'centre' }])
    .png()
    .toFile(path.join(OUT, `splash-${w}x${h}.png`));
}

console.log('icons written to', path.relative(ROOT, OUT));
