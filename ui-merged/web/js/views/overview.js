import { role } from "../roles.js";
import { homeCitizen } from "./home-citizen.js";
import { homeCivil } from "./home-civil.js";
import { homeInsurer } from "./home-insurer.js";

// Each role has its own home: a plain answer for one place, an exposure desk, or an operations board.
const HOMES = { citizen: homeCitizen, insurer: homeInsurer, civil: homeCivil };

export function overview(root, go) {
  return HOMES[role()](root, go);
}
