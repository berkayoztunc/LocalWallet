import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App";

// Privacy Cash's proving and serialization code is written for Node and reaches
// for `Buffer` as a global. Everything else in the app is browser-native, so
// this is the one shim, installed before any of it can run.
if (!("Buffer" in globalThis)) {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

async function start() {
  // Dev only, and only outside Tauri: a fake backend so the UI can be viewed in
  // a plain browser. The dynamic import keeps it out of production builds.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mock");
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start();
