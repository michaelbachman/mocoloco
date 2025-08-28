import React, { useMemo } from 'react';

export default function Sparkline({ data = [], width = 200, height = 44, stroke = 'currentColor' }) {
  const points = useMemo(() => {
    const vals = Array.isArray(data) ? data.filter(Number.isFinite) : [];
    if (vals.length === 0) return '';
    if (vals.length === 1) {
      const y = Math.round(height / 2);
      return `1,${y} ${width - 1},${y}`;
    }
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = (max - min) || 1;
    const stepX = (width - 2) / (vals.length - 1);

    return vals.map((v, i) => {
      const x = 1 + i * stepX;
      const y = 1 + (height - 2) * (1 - (v - min) / range);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [data, width, height]);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {points && <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" />}
    </svg>
  );
}
