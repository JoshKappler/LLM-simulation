"use client";

import { useRef } from "react";

export function W95Slider({ min, max, step, value, onChange, disabled }: {
  min: number; max: number; step: number; value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  function valueFromClientX(clientX: number) {
    const rect = trackRef.current!.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + pct * (max - min);
    return parseFloat((Math.round(raw / step) * step).toFixed(2));
  }

  function onMouseDown(e: React.MouseEvent) {
    if (disabled) return;
    e.preventDefault();
    onChange(valueFromClientX(e.clientX));
    const onMove = (ev: MouseEvent) => onChange(valueFromClientX(ev.clientX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position: "relative", height: 24, flex: 1,
        display: "flex", alignItems: "center",
        cursor: disabled ? "not-allowed" : "pointer", userSelect: "none",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        position: "absolute", left: 0, right: 0, height: 4,
        background: "#808080",
        borderTop: "1px solid #404040", borderLeft: "1px solid #404040",
        borderBottom: "1px solid #ffffff", borderRight: "1px solid #ffffff",
      }} />
      <div style={{
        position: "absolute",
        left: `${pct}%`,
        transform: "translateX(-50%)",
        width: 11, height: 20,
        background: "#c0c0c0",
        borderStyle: "solid", borderWidth: 2,
        borderColor: "#ffffff #808080 #808080 #ffffff",
      }} />
    </div>
  );
}
