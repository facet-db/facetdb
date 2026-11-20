import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The skeleton: the React plugin and Tailwind. The dev proxy of /v1 to the worker's port is not
// here yet.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
