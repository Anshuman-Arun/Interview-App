import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/theme.css";
import { App } from "./App.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";

const rootElement = document.getElementById("root");

if (rootElement !== null) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>
  );
}
