import { useEffect, useSyncExternalStore } from "react";
import type { PlatformStatus } from "../api/platform";
import { useConsole } from "../context/ConsoleContext";
import { getPlatformStatus, startPlatformPoll, subscribePlatform } from "../lib/platformStore";
import { routeHref, type RoleId } from "../lib/route";
import { sponsorChips, type ChipState, type SponsorChip } from "../lib/sponsors";
import "../styles/sponsors.css";

const STATE_WORD: Record<ChipState, string> = { on: "on", off: "off", unavailable: "unavailable", unknown: "status unknown" };

/** Pure view: one chip per sponsor, a status dot, a link to the Stack page. The citizen strip has plain names only. */
export function SponsorChips({ platform, role = "citizen" }: { platform: PlatformStatus | null; role?: RoleId }) {
  const href = routeHref(role, "stack");
  return (
    <ul className="sponsor-strip" aria-label="Sponsor technologies in use">
      {sponsorChips(platform, role === "citizen").map((c: SponsorChip) => (
        <li key={c.id}>
          <a className={`sponsor-chip sponsor-chip--${c.state}`} href={href} title={c.title} aria-label={`${c.label}${c.detail ? ` ${c.detail}` : ""}, ${STATE_WORD[c.state]}`} data-sponsor={c.id}>
            <span className="sponsor-dot" aria-hidden="true" />
            <span className="sponsor-name">{c.label}</span>
            {c.detail && <span className="sponsor-detail">{c.detail}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Global strip under the header. Status comes from the shared platform snapshot; a failed poll shows "unavailable", never stale green. */
export function SponsorStrip() {
  const { route } = useConsole();
  const platform = useSyncExternalStore(subscribePlatform, getPlatformStatus, getPlatformStatus);
  useEffect(() => startPlatformPoll(), []);
  return <SponsorChips platform={platform} role={route} />;
}
