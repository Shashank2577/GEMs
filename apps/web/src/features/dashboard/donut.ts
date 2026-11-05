/**
 * Donut segment math for the Go / No-Go ring (FR-093). Pure so it can be unit-tested (donut.test.ts).
 *
 * Each segment is drawn as an SVG <circle> stroke: `stroke-dasharray = "<length> <circumference>"` and
 * `stroke-dashoffset = -<start>`, on a circle rotated -90° so the ring starts at 12 o'clock and runs clockwise.
 */
export interface DonutSegment<K extends string = string> {
  key: K;
  value: number;
  /** Arc length along the circle (same unit as the circumference). */
  length: number;
  /** Distance from 12 o'clock to the start of the arc. */
  start: number;
}

/** Split `circumference` into arcs proportional to the values, with `gap` between adjacent non-zero arcs. */
export function donutSegments<K extends string>(rows: { key: K; value: number }[], circumference: number, gap = 0): DonutSegment<K>[] {
  const total = rows.reduce((a, r) => a + Math.max(0, r.value), 0);
  if (total <= 0) return [];
  const nonZero = rows.filter((r) => r.value > 0).length;
  const gaps = nonZero > 1 ? gap * nonZero : 0;
  const available = Math.max(0, circumference - gaps);
  let cursor = nonZero > 1 ? gap / 2 : 0;
  const out: DonutSegment<K>[] = [];
  for (const r of rows) {
    if (r.value <= 0) continue;
    const length = (r.value / total) * available;
    out.push({ key: r.key, value: r.value, length, start: cursor });
    cursor += length + (nonZero > 1 ? gap : 0);
  }
  return out;
}
