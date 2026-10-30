import { useEffect, useState } from "react";
import { NAV_COLLAPSE_QUERY, NAV_DRAWER_QUERY } from "../lib/route";

function matches(query: string): boolean {
  return window.matchMedia(query).matches;
}

/**
 * Collapsed by default under 980px. A manual toggle holds until the breakpoint changes.
 * Under 760px the open nav is an overlay drawer: picking a page or pressing Escape closes it.
 */
export function useCollapsedNav(): {
  collapsed: boolean;
  drawer: boolean;
  toggle: () => void;
  close: () => void;
  closeIfDrawer: () => void;
} {
  const [collapsed, setCollapsed] = useState(() => matches(NAV_COLLAPSE_QUERY));
  const [drawer, setDrawer] = useState(() => matches(NAV_DRAWER_QUERY));

  useEffect(() => {
    const narrow = window.matchMedia(NAV_COLLAPSE_QUERY);
    const phone = window.matchMedia(NAV_DRAWER_QUERY);
    const onNarrow = () => setCollapsed(narrow.matches);
    const onPhone = () => setDrawer(phone.matches);
    narrow.addEventListener("change", onNarrow);
    phone.addEventListener("change", onPhone);
    return () => {
      narrow.removeEventListener("change", onNarrow);
      phone.removeEventListener("change", onPhone);
    };
  }, []);

  useEffect(() => {
    if (!drawer || collapsed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCollapsed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, collapsed]);

  return {
    collapsed,
    drawer,
    toggle: () => setCollapsed((current) => !current),
    close: () => setCollapsed(true),
    closeIfDrawer: () => {
      if (matches(NAV_DRAWER_QUERY)) setCollapsed(true);
    },
  };
}
