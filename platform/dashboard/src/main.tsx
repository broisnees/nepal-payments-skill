import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./routes.tsx";

async function start() {
  // Dead code in a normal build: Vite replaces the env check with a constant and drops the import.
  if (import.meta.env.VITE_MOCK === "1") {
    const { installMock } = await import("./mock/index.ts");
    installMock();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
