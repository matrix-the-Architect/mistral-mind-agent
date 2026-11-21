import { createFileRoute } from "@tanstack/react-router";

import {
  SAMPLE_PROPOSAL_HEADING,
  SAMPLE_PROPOSAL_LINES,
  SAMPLE_PROPOSAL_SUBHEADING,
} from "../../ghost/demo";
import "../../ghost/ghost.css";

/**
 * The sample proposal page for the milestone-4/5 screen-capture demo: large, readable SYNTHETIC
 * text, clearly labeled as example content. It is static — it never contains the judge's codeword
 * — and opening it is always a user action (a button opens this route in a new tab). Capture and
 * OCR run against whatever is actually on screen; this fixture is never substituted for real OCR
 * output.
 */
function SampleProposalPage() {
  return (
    <main className="ghost sample-proposal">
      <p className="sample-banner">{SAMPLE_PROPOSAL_HEADING}</p>
      <p className="note">{SAMPLE_PROPOSAL_SUBHEADING}</p>
      <h1 className="sample-title">Proposed check-in flow — Project Cedar kiosk (draft v0.3)</h1>
      <ul className="sample-lines">
        {SAMPLE_PROPOSAL_LINES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="note">
        Capture this tab with “Capture screen context” on the Ghost page; OCR runs locally in your browser and you review the
        extracted text before anything is sent.
      </p>
    </main>
  );
}

export const Route = createFileRoute("/demo/sample-proposal")({
  head: () => ({ meta: [{ title: "Sample proposal (example content)" }] }),
  component: SampleProposalPage,
});
