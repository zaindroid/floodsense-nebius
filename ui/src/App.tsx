import { ConsoleProvider } from "./context/ConsoleContext";
import { AskFloodSense } from "./components/AskFloodSense";
import { Colophon } from "./components/Banners";
import { DemoOffer } from "./components/ModeSwitch";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { Header } from "./components/Header";
import { PageOutlet } from "./components/PageOutlet";
import { ReplayBar } from "./components/ReplayBar";
import { SideNav } from "./components/SideNav";
import { useCollapsedNav } from "./hooks/useCollapsedNav";

export function App() {
  return (
    <ConsoleProvider>
      <Shell />
    </ConsoleProvider>
  );
}

function Shell() {
  const nav = useCollapsedNav();
  return (
    <div className="app-shell" data-nav={nav.collapsed ? "collapsed" : "open"}>
      <div className="shell-stage">
        <Header />
        <SideNav collapsed={nav.collapsed} onToggle={nav.toggle} onNavigate={nav.closeIfDrawer} drawer={nav.drawer} />
        {nav.drawer && !nav.collapsed && (
          <button type="button" className="nav-backdrop" aria-label="Close pages" onClick={nav.close} />
        )}
        <ReplayBar />
        <DemoOffer />
        <main id="content">
          <PageOutlet />
        </main>
        <Colophon />
      </div>
      <AskFloodSense />
      <EvidenceDrawer />
    </div>
  );
}
