import test from 'node:test';
import assert from 'node:assert/strict';
import { fillRegion } from '../apps/opendraft/src/dynamic-fill.ts';

// White canvas with black rectangles drawn as 2 px lines.
function canvas(width, height, draw) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const dark = (x, y) => { if (x >= 0 && y >= 0 && x < width && y < height) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3); };
  draw({ rect(x1, y1, x2, y2, gapFrom, gapTo) { for (let x = x1; x <= x2; x++) for (const y of [y1, y1 + 1, y2 - 1, y2]) if (!(y >= y2 - 1 && gapFrom !== undefined && x >= gapFrom && x <= gapTo)) dark(x, y); for (let y = y1; y <= y2; y++) for (const x of [x1, x1 + 1, x2 - 1, x2]) dark(x, y); }, dot(x, y) { dark(x, y); } });
  return rgba;
}
const area = poly => Math.abs(poly.reduce((s, [x, y], i) => { const [nx, ny] = poly[(i + 1) % poly.length]; return s + x * ny - nx * y; }, 0)) / 2;

test('a closed room fills to its inner wall faces; text inside does not reduce it', () => {
  const rgba = canvas(200, 150, c => { c.rect(20, 20, 120, 100); for (let x = 50; x < 80; x += 3) c.dot(x, 60); });
  const poly = fillRegion(rgba, 200, 150, [70, 50]);
  // Inner faces at x 22..118 (97 px wide incl.) and y 22..98: area 97 x 77 pixel squares.
  assert.equal(area(poly), 97 * 77);
  assert.ok(poly.length <= 6, `simplified to a rectangle, got ${poly.length} vertices`);
});

test('an L-shaped region keeps its six corners', () => {
  const rgba = canvas(200, 200, c => { c.rect(10, 10, 150, 150); for (let x = 80; x <= 150; x++) for (const y of [80, 81]) c.dot(x, y); for (let y = 10; y <= 81; y++) for (const x of [80, 81]) c.dot(x, y); });
  const poly = fillRegion(rgba, 200, 200, [40, 120]);
  assert.equal(poly.length, 6);
  // Interior 12..148 (137 px square) minus the walled-off notch x 80..148, y 12..81 (69 x 70 px).
  assert.equal(area(poly), 137 * 137 - 69 * 70);
});

test('open regions are refused, small door gaps can be bridged, and lines are not fillable', () => {
  const leaky = canvas(220, 160, c => c.rect(20, 20, 120, 100, 60, 64));
  assert.throws(() => fillRegion(leaky, 220, 160, [70, 50]), /not closed/);
  const bridged = fillRegion(leaky, 220, 160, [70, 50], { gapPixels: 3 });
  assert.ok(Math.abs(area(bridged) - 97 * 77) / (97 * 77) < 0.03, `bridged area ${area(bridged)}`);
  assert.throws(() => fillRegion(leaky, 220, 160, [20, 50]), /on a line/);
});
