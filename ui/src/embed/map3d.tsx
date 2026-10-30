import "./preset";
import L from "leaflet";
import { createRoot } from "react-dom/client";
import "./embed.css";
import { MapShell } from "../components/map/MapShell";
import { bandPoint, statusPoint, type ShellPoint } from "../components/map/shellLogic";
import type { GaugeStatus } from "../lib/gauges";
import type { DischargeBand } from "../types/ui";
import { boundsOf } from "../lib/events";

export interface Map3dOptions {
  points: ShellPoint[];
  ariaLabel?: string;
  selectedId?: string;
  focusIds?: string[];
  onSelect?: (id: string) => void;
  /** Column half side in degrees: about 0.0015 for a river reach, 0.08 for Europe. */
  columnDeg?: number;
  attribution?: string;
}

function view(o: Map3dOptions) {
  let b = boundsOf(o.points) ?? ([[35, -10], [60, 25]] as [[number, number], [number, number]]);
  // A lone point has no extent: give it a small neighbourhood so the camera has a zoom.
  if (b[1][0] - b[0][0] < 0.02 && b[1][1] - b[0][1] < 0.02) b = [[b[0][0] - 0.05, b[0][1] - 0.05], [b[1][0] + 0.05, b[1][1] + 0.05]];
  const fit = { bounds: b, padding: 24 };
  return (
    <MapShell
      ariaLabel={o.ariaLabel ?? "Map"}
      attribution={o.attribution ?? "FloodSense"}
      fit={fit}
      points3d={o.points}
      selectedId={o.selectedId}
      focusIds={o.focusIds}
      onSelect={o.onSelect}
      loadTimeoutMs={45000}
      retry3dOnFail
      columnDeg={o.columnDeg ?? 0.05}
      onMap2d={(map) => {
        // 2D fallback: plain circles, same band colours.
        if (!map) return;
        for (const p of o.points) {
          L.circleMarker([p.lat, p.lon], { radius: 6, weight: 1.5, color: p.color, fillColor: p.color, fillOpacity: 0.7 })
            .bindTooltip(Object.assign(document.createElement("span"), { textContent: p.label }))
            .on("click", () => o.onSelect?.(p.id))
            .addTo(map);
        }
      }}
    />
  );
}

type Base = { id: string; lat: number; lon: number; label: string };
/** Pin from the shared colour rules. `{status, measured}` is a gauge (red only for a live measured "over"); `{band}` is a model band (amber, never red); neither is a flat grey marker. */
function pin(base: Base, spec: { status?: GaugeStatus; measured?: boolean; band?: DischargeBand | null }): ShellPoint {
  return spec.status ? statusPoint(base, spec.status, spec.measured === true) : bandPoint(base, spec.band ?? null);
}

/** Mounts the shared MapShell (2D/3D) into `el`. Throws nothing the caller must handle except a failed render, which it should catch to fall back to Leaflet. */
function mount(el: HTMLElement, options: Map3dOptions) {
  let opts = options;
  const root = createRoot(el);
  root.render(view(opts));
  return {
    update(patch: Partial<Map3dOptions>) {
      opts = { ...opts, ...patch };
      root.render(view(opts));
    },
    destroy() {
      root.unmount();
    },
  };
}

(window as unknown as { FloodMap3D: unknown }).FloodMap3D = { mount, pin };
