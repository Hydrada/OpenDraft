export type PixelPoint = [number, number];

/**
 * Dynamic fill on a rendered page: flood-fills light pixels from the seed (stopping at dark lines),
 * then traces the region's outer boundary and simplifies it to a polygon in pixel coordinates.
 * Text and symbols inside the region do not reduce it (only the outer boundary is traced). Small
 * openings such as door gaps can be bridged by `gapPixels`, which thickens dark lines before filling.
 */
export function fillRegion(rgba: Uint8ClampedArray, width: number, height: number, seed: PixelPoint, options: { threshold?: number; gapPixels?: number; maxPixels?: number; tolerance?: number } = {}): PixelPoint[] {
  const threshold = options.threshold ?? 160, gap = Math.max(0, Math.min(20, Math.round(options.gapPixels ?? 0))), maxPixels = options.maxPixels ?? 40_000_000;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || rgba.length !== width * height * 4) throw new Error('Invalid page image.');
  const [sx, sy] = seed.map(Math.round);
  if (sx < 1 || sy < 1 || sx >= width - 1 || sy >= height - 1) throw new Error('Click inside the drawing area.');
  // Wall mask: dark pixels (luminance below threshold), optionally dilated to close small gaps.
  let wall: Uint8Array = new Uint8Array(width * height);
  for (let i = 0; i < wall.length; i++) wall[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2] < threshold ? 1 : 0;
  if (gap) wall = dilate(wall, width, height, gap);
  if (wall[sy * width + sx]) throw new Error('That point is on a line. Click inside the area to fill.');
  const region = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0, count = 0; queue[tail++] = sy * width + sx; region[sy * width + sx] = 1;
  while (head < tail) {
    const index = queue[head++], x = index % width, y = (index - x) / width;
    if (++count > maxPixels) throw new Error('The area is too large to fill.');
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) throw new Error('The area is not closed: the fill reached the edge of the page. Close gaps with a larger gap tolerance or measure manually.');
    for (const next of [index - 1, index + 1, index - width, index + width]) if (!region[next] && !wall[next]) { region[next] = 1; queue[tail++] = next; }
  }
  if (count < 16) throw new Error('The enclosed area is too small to measure.');
  // When lines were thickened, grow the region back by the same amount so it meets the original lines.
  const filled = gap ? growWithin(region, width, height, gap) : region;
  return simplify(trace(filled, width, height), options.tolerance ?? 1.25);
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  // Separable square dilation: horizontal then vertical running windows.
  const horizontal = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let on = 0; for (let d = -radius; d <= radius && !on; d++) { const xx = x + d; if (xx >= 0 && xx < width && mask[y * width + xx]) on = 1; }
    horizontal[y * width + x] = on;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let on = 0; for (let d = -radius; d <= radius && !on; d++) { const yy = y + d; if (yy >= 0 && yy < height && horizontal[yy * width + x]) on = 1; }
    out[y * width + x] = on;
  }
  return out;
}
function growWithin(region: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return dilate(region, width, height, radius);
}

/** Moore-neighbour tracing of the outer boundary, returning pixel-corner coordinates. */
function trace(mask: Uint8Array, width: number, height: number): PixelPoint[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  let start = -1;
  for (let i = 0; i < mask.length && start < 0; i++) if (mask[i]) start = i;
  const sx = start % width, sy = (start - sx) / width;
  // Square tracing over pixel edges: walk the boundary keeping the region on the right.
  const dirs: PixelPoint[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let x = sx, y = sy, dir = 0; const points: PixelPoint[] = [[x, y]];
  for (let steps = 0; steps < mask.length * 4; steps++) {
    // Pixels to the right-front and left-front of the current edge direction.
    const [dx, dy] = dirs[dir];
    const left = dir === 0 ? at(x, y - 1) : dir === 1 ? at(x, y) : dir === 2 ? at(x - 1, y) : at(x - 1, y - 1);
    const right = dir === 0 ? at(x, y) : dir === 1 ? at(x - 1, y) : dir === 2 ? at(x - 1, y - 1) : at(x, y - 1);
    if (left) dir = (dir + 3) % 4;
    else if (!right) dir = (dir + 1) % 4;
    else { x += dx; y += dy; if (x === sx && y === sy) break; points.push([x, y]); }
  }
  return points;
}

/** Ramer–Douglas–Peucker on a closed ring; collinear staircase steps collapse to straight edges. */
function simplify(ring: PixelPoint[], tolerance: number): PixelPoint[] {
  if (ring.length < 4) return ring;
  const far = ring.reduce((best, p, i) => Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best, 0);
  const run = (points: PixelPoint[]): PixelPoint[] => {
    if (points.length < 3) return points;
    const [a, b] = [points[0], points[points.length - 1]], length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let index = 0, distance = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - points[i][1]) - (a[0] - points[i][0]) * (b[1] - a[1])) / length;
      if (d > distance) { distance = d; index = i; }
    }
    return distance > tolerance ? [...run(points.slice(0, index + 1)).slice(0, -1), ...run(points.slice(index))] : [a, b];
  };
  const first = run(ring.slice(0, far + 1)), second = run([...ring.slice(far), ring[0]]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}
