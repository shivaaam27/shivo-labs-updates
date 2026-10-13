// The Shivo Labs mark as an svg string (same as phone/www/app.js). Classes: "play" (drops in), "loop" (light runs through).
// Tiles are listed tails first, the sage tip last.
const SHIVO_TILES = [[18, 64, 't'], [64, 18, 't'], [18, 41, 't'], [41, 18, 't'], [41, 41, 't'], [18, 18, 'lit']];
function shivoMark(cls = '') {
  return `<svg class="mk ${cls}" viewBox="0 0 100 100" aria-hidden="true"><g transform="rotate(15 50 50)">${SHIVO_TILES.map(([x, y, c], i) => `<rect class="${c}" style="--i:${i}" x="${x}" y="${y}" width="18" height="18" rx="4.5"/>`).join('')}</g></svg>`;
}
