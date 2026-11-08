import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import { registerServiceWorker } from "./pwa.js";

// PWA。ビルドした版でだけ service worker を登録する（pwa.ts）。
registerServiceWorker();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
