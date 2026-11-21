// P0 placeholder entry. The Frontend Developer builds the shell in P1-B.
import { pageTitle } from "./title";

document.title = pageTitle();
const root = document.querySelector<HTMLDivElement>("#app");
if (root) {
  root.textContent = "Dialwarden";
}
