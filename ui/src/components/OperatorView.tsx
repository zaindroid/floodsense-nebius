import { Approvals } from "./Approvals";
import { HowItWorks } from "./HowItWorks";
import { OperatorSituation } from "./OperatorSituation";
import type { OperatorPage } from "../lib/route";

/** One Civil protection page per hash. */
export function OperatorView({ page }: { page: OperatorPage }) {
  switch (page) {
    case "situation":
      return <OperatorSituation />;
    case "approvals":
      return (
        <div className="page-stack">
          <Approvals operator />
        </div>
      );
    case "how":
      return <HowItWorks />;
  }
}
