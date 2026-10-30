import { ROLES, role, setRole } from "./roles.js";
import { h, WAVE } from "./ui.js";
import { ask } from "./views/ask.js";
import { decide } from "./views/decide.js";
import { overview } from "./views/overview.js";
import { watch } from "./views/watch.js";

const VIEWS = { "": overview, watch, ask, decide, live: ask, jury: ask };
const main = document.getElementById("view");
let leave = null; // a view may return a cleanup for its timers and streams

document.getElementById("brand").insertAdjacentHTML("afterbegin", WAVE);

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

function roles() {
  document.getElementById("roles").replaceChildren(...Object.entries(ROLES).map(([id, r]) =>
    h("button", { type: "button", "aria-pressed": String(id === role()), onclick: () => { setRole(id); roles(); render(); } }, r.label)));
  // The menu follows the role: its own name for Watch, and Decide only for those who decide.
  const r = ROLES[role()];
  document.querySelector('.nav a[href="#/watch"]').textContent = r.watchNav;
  document.querySelector('.nav a[href="#/decide"]').hidden = !r.decide;
}

function render() {
  const [name = "", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const view = VIEWS[name] || overview;
  for (const a of document.querySelectorAll(".nav a")) {
    const own = a.getAttribute("href").replace(/^#\/?/, "");
    if (own === (VIEWS[name] ? name : "")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  leave?.();
  main.replaceChildren();
  leave = view(main, go, arg ? decodeURIComponent(arg) : undefined) || null;
  window.scrollTo(0, 0);
}

// Light or dark, remembered. index.html sets the first one before paint.
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const themeButton = document.getElementById("theme");
function theme(next) {
  if (next) {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("fs.theme", next);
  }
  const dark = document.documentElement.dataset.theme !== "light";
  themeButton.innerHTML = dark ? SUN : MOON;
  themeButton.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  themeButton.title = themeButton.getAttribute("aria-label");
}
themeButton.addEventListener("click", () => {
  theme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  render(); // maps pick their basemap for the theme when drawn
});
theme();

window.addEventListener("hashchange", () => { render(); main.focus({ preventScroll: true }); });
roles();
render();
