import { createFileRoute } from "@tanstack/react-router";

import { MistralMindPage } from "../ghost/MistralMindPage";
import "../ghost/ghost.css";

/**
 * The alternate "mistral mind" UI at /mistral_mind. The original page stays the landing route
 * (`/ghost` keeps `staticData: { landing: true }`, so `/` still redirects there); this route only
 * adds a second presentation over the SAME application state, services and backend.
 */
export const Route = createFileRoute("/mistral_mind")({
  head: () => ({ meta: [{ title: "mistral mind" }] }),
  component: MistralMindPage,
});
