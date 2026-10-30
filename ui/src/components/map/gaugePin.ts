import type { ShellPoint } from "./shellLogic";

/** Zoom at which a pin opens into the animated dial. */
export const DIAL_ZOOM = 10;

let pinSeq = 0;

/**
 * DOM for one gauge on the 3D map: a pulsing teardrop pin from far away, an animated water dial up close.
 * `fill` is the band order (0..1), never a measured value. The element is 0 x 0 so the point is its centre.
 */
export function gaugePinEl(p: ShellPoint, fill: number, selected: boolean): HTMLElement {
  const el = document.createElement("div");
  const known = p.rank >= 0;
  const clip = `gc-${++pinSeq}`;
  el.className = `gpin${known ? "" : " gpin--unknown"}${selected ? " gpin--sel" : ""}${p.alert ? " gpin--over" : ""}`;
  el.style.setProperty("--c", p.color);
  el.style.setProperty("--fill", String(known ? Math.max(0.12, fill) : 0));
  el.setAttribute("role", "button");
  el.setAttribute("aria-pressed", "false");
  el.setAttribute("aria-label", known ? p.label : `${p.label} · no reading`);
  el.tabIndex = 0;
  el.innerHTML = `
    ${p.alert ? '<span class="gpin__bang" aria-hidden="true">!</span>' : ""}<span class="gpin__pulse"></span><span class="gpin__pulse gpin__pulse--b"></span>
    <svg class="gpin__pin" viewBox="0 0 24 34" aria-hidden="true">
      <path d="M12 33C12 33 2 20 2 12a10 10 0 0 1 20 0c0 8-10 21-10 21z" fill="var(--c)" stroke="#fff" stroke-width="1.6"/>
      <circle cx="12" cy="12" r="4" fill="#fff"/>
    </svg>
    <svg class="gpin__dial" viewBox="0 0 64 64" aria-hidden="true">
      <defs><clipPath id="${clip}"><circle cx="32" cy="32" r="26"/></clipPath></defs>
      <circle cx="32" cy="32" r="29" fill="#0e1b2a" stroke="var(--c)" stroke-width="3"/>
      <g clip-path="url(#${clip})"><g class="gpin__level">
        <path class="gpin__wave" d="M-64 0 q8 -6 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 V70 H-64z" fill="var(--c)" opacity=".9"/>
        <path class="gpin__wave gpin__wave--b" d="M-64 0 q8 -5 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 V70 H-64z" fill="#9fd4ff" opacity=".35"/>
      </g></g>
    </svg>`;
  return el;
}
