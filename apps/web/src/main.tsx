import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/app.css";
import { App } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new Error("index.html has no #app element");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
