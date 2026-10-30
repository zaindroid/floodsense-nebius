import { CitizenActions, CitizenArea, CitizenEvidence, CitizenOverview } from "./CitizenView";
import { InsurerView } from "./InsurerView";
import { OperatorView } from "./OperatorView";
import { NowPage } from "./NowPage";
import { DisasterReplay } from "./DisasterReplay";
import { ControlTower } from "./ControlTower";
import { HowItWorks } from "./HowItWorks";
import { pageLabel, type CitizenPage } from "../lib/route";
import { useConsole } from "../context/ConsoleContext";

/** One page body per hash. The Evidence drawer and the replay strip stay on the shell. */
export function PageOutlet() {
  const { deskRoute } = useConsole();
  const desk = deskRoute.role === "citizen" ? "Citizen" : deskRoute.role === "operator" ? "Civil protection" : "Insurer";
  const label = pageLabel(deskRoute);

  return (
    <>
      <h1 className="sr-only">
        {desk} {label}
      </h1>
      <div className="workspace" data-page={`${deskRoute.role}-${deskRoute.page}`}>
        {deskRoute.role === "citizen" ? (
          <CitizenBody page={deskRoute.page} />
        ) : deskRoute.role === "operator" ? (
          <OperatorView page={deskRoute.page} />
        ) : (
          <InsurerView page={deskRoute.page} />
        )}
      </div>
    </>
  );
}

function CitizenBody({ page }: { page: CitizenPage }) {
  switch (page) {
    case "now":
      return <NowPage />;
    case "replay":
      return <DisasterReplay />;
    case "overview":
      return <CitizenOverview />;
    case "area":
      return <CitizenArea />;
    case "actions":
      return <CitizenActions />;
    case "evidence":
      return <CitizenEvidence />;
    case "tower":
      return <ControlTower />;
    case "how":
      return <HowItWorks />;
  }
}
