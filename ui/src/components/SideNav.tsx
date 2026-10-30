import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DESK_NAV, routeHref } from "../lib/route";
import { useConsole } from "../context/ConsoleContext";

export function SideNav({
  collapsed,
  onToggle,
  onNavigate,
  drawer = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  /** Phone drawer: focus moves in on open, Tab stays inside, focus returns to the toggle on close. */
  drawer?: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const open = drawer && !collapsed;
  useEffect(() => {
    if (open) {
      navRef.current?.querySelector<HTMLAnchorElement>("#desk-pages a")?.focus();
    } else if (wasOpen.current && navRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus();
    } else if (wasOpen.current && document.activeElement === document.body) {
      toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  const trap = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== "Tab" || !navRef.current) return;
    const items = [...navRef.current.querySelectorAll<HTMLElement>("button, a[href]")];
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const { route, page } = useConsole();
  const desk = route === "citizen" ? "Citizen" : route === "operator" ? "Civil protection" : "Insurer";
  const items = DESK_NAV[route];

  return (
    <nav className="side-nav" aria-label={`${desk} pages`} ref={navRef} onKeyDown={trap}>
      <button
        ref={toggleRef}
        type="button"
        className="icon-button nav-toggle"
        aria-expanded={!collapsed}
        aria-controls="desk-pages"
        onClick={onToggle}
      >
        <span className="sr-only">{collapsed ? "Show pages" : "Hide pages"}</span>
        <NavIcon />
      </button>
      <div id="desk-pages" hidden={collapsed}>
        <p className="section-label">{desk}</p>
        <ul>
          {items.map((item) => {
            const href = routeHref(route, item.page);
            return (
              <li key={item.page}>
                <a href={href} aria-current={page === item.page ? "page" : undefined} onClick={onNavigate}>
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

function NavIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
