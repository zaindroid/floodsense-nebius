// Runs before MapShell reads its saved mode: the embedded map opens in 3D unless the viewer chose otherwise.
try {
  if (!localStorage.getItem("floodsense.mapMode")) localStorage.setItem("floodsense.mapMode", "3d");
} catch {
  /* storage blocked: MapShell falls back to 2D */
}
