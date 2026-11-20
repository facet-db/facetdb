import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The skeleton: the app mounts and builds. The composition root (the router, the query client, the
// API client) and the shell are not here yet.
const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}
createRoot(root).render(<StrictMode />);
