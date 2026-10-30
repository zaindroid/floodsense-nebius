export function Sparkline({
  values,
  activeIndex,
  label,
  splitIndex,
}: {
  values: number[];
  activeIndex: number;
  label: string;
  /** Optional: values after this index are a forecast, drawn dashed behind a "now" divider. */
  splitIndex?: number;
}) {
  const width = 320;
  const height = 84;
  const pad = 8;
  if (values.length === 0) return null;
  const max = Math.max(...values, 0);
  const span = Math.max(max, 1e-6);
  const coords = values.map((value, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(values.length - 1, 1);
    const y = height - pad - (value / span) * (height - pad * 2);
    return { x, y };
  });
  const toPath = (points: { x: number; y: number }[]) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const active = coords[activeIndex];
  const split = splitIndex !== undefined && splitIndex >= 0 && splitIndex < coords.length - 1 ? splitIndex : null;
  const solid = split === null ? coords : coords.slice(0, split + 1);
  const dashed = split === null ? [] : coords.slice(split);
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={toPath(solid)} className="spark-line" />
      {dashed.length > 1 && <path d={toPath(dashed)} className="spark-line spark-forecast" />}
      {split !== null && (
        <>
          <line x1={coords[split].x} x2={coords[split].x} y1={2} y2={height - 2} className="spark-now" />
          <text x={coords[split].x + 3} y={11} className="spark-now-label">
            now
          </text>
        </>
      )}
      {active && <circle cx={active.x} cy={active.y} r="3.5" className="spark-dot" />}
    </svg>
  );
}
