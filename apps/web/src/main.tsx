import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import { App } from "./App.js";
import { AppearanceProvider } from "./appearance/AppearanceProvider.js";
import { AppearanceDock } from "./components/AppearanceDock.js";
import "./styles/theme.css";

const rootElement = document.getElementById("root");

if (rootElement !== null) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppearanceProvider>
        <App />
        <AppearanceDock />
      </AppearanceProvider>
    </React.StrictMode>
  );
}
