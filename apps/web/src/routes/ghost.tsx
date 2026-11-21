import { createFileRoute } from "@tanstack/react-router";

import { GhostPage } from "../ghost/GhostPage";
import "../ghost/ghost.css";

/**
 * Ghost's single page. It claims the landing spot, so `/` redirects here (`landing.ts`).
 */
export const Route = createFileRoute("/ghost")({
  staticData: { landing: true },
  head: () => ({ meta: [{ title: "Mistral Mind" }] }),
  component: GhostPage,
});
