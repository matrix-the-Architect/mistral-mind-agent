/**
 * Milestone 5 tests: demo mode's pure logic. Demo mode is presentation-only, so the guarantees
 * pinned here are: the sample brief embeds the codeword exactly as ordinary context; the proposal
 * fixture never contains a codeword; step completion is DERIVED from real operation results; the
 * evidence builder labels every item with a source and observation time and stays honest about
 * unavailable state; and demo.ts itself performs no network or storage operations.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DEMO_STEPS,
  SAMPLE_PROPOSAL_LINES,
  buildEvidence,
  buildSampleBrief,
  demoProgress,
  demoStepDone,
} from "./demo";
import type { DemoProgressInput } from "./demo";
import { createRemoteApi } from "./api";
import { createFakeRelay } from "../test/fakeRelay";

const EMPTY: DemoProgressInput = {
  briefLoaded: false,
  analyzeAnswered: false,
  memorySaved: false,
  proposalOpened: false,
  captureReviewed: false,
  requestAnswered: false,
  trailPopulated: false,
  forgotten: false,
};

describe("buildSampleBrief", () => {
  test("describes Project Cedar with both constraints and weaves in the codeword", () => {
    const brief = buildSampleBrief("Juniper-42");
    expect(brief).toContain("Project Cedar");
    expect(brief).toContain("internet outages");
    expect(brief).toContain("must not collect visitor email addresses");
    expect(brief).toContain("Juniper-42");
  });

  test("the sample proposal fixture contains no codeword and is labeled example content", () => {
    const fixture = SAMPLE_PROPOSAL_LINES.join("\n");
    expect(fixture).not.toContain("Juniper-42");
    expect(fixture).toContain("maya@example.com");
    expect(fixture).toContain("Google sign-in");
    expect(fixture).not.toMatch(/codeword/i);
    // The fixture page renders the labeled heading constant (it cannot receive a codeword).
    const { SAMPLE_PROPOSAL_HEADING } = require("./demo") as typeof import("./demo");
    expect(SAMPLE_PROPOSAL_HEADING).toContain("EXAMPLE CONTENT");
    const routeSource = readFileSync(new URL("../routes/demo/sample-proposal.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(routeSource).toContain("SAMPLE_PROPOSAL_HEADING");
    expect(routeSource).not.toMatch(/codeword/i);
  });
});

describe("demoStepDone derives completion from real operation results", () => {
  test("nothing is complete initially", () => {
    expect(demoProgress(EMPTY)).toEqual({ done: 0, total: DEMO_STEPS.length });
    for (const step of DEMO_STEPS) expect(demoStepDone(step.id, EMPTY)).toBe(false);
  });

  test("each step completes only on its real signal", () => {
    expect(demoStepDone("load-brief", { ...EMPTY, briefLoaded: true })).toBe(true);
    // analyze-save needs BOTH a real answer and a real save
    expect(demoStepDone("analyze-save", { ...EMPTY, analyzeAnswered: true })).toBe(false);
    expect(demoStepDone("analyze-save", { ...EMPTY, memorySaved: true })).toBe(false);
    expect(demoStepDone("analyze-save", { ...EMPTY, analyzeAnswered: true, memorySaved: true })).toBe(true);
    expect(demoStepDone("open-proposal", { ...EMPTY, proposalOpened: true })).toBe(true);
    expect(demoStepDone("capture-review", { ...EMPTY, captureReviewed: true })).toBe(true);
    expect(demoStepDone("recall-send", { ...EMPTY, requestAnswered: true })).toBe(true);
    expect(demoStepDone("inspect-trail", { ...EMPTY, trailPopulated: true })).toBe(true);
    expect(demoStepDone("forget", { ...EMPTY, forgotten: true })).toBe(true);
  });

  test("full run reaches 7/7", () => {
    const all: DemoProgressInput = {
      briefLoaded: true,
      analyzeAnswered: true,
      memorySaved: true,
      proposalOpened: true,
      captureReviewed: true,
      requestAnswered: true,
      trailPopulated: true,
      forgotten: true,
    };
    expect(demoProgress(all)).toEqual({ done: DEMO_STEPS.length, total: DEMO_STEPS.length });
  });
});

describe("buildEvidence labels sources and observation times honestly", () => {
  const base = {
    vault: { namespaceId: "ns-1", generation: 1 },
    vaultState: "ready" as const,
    localInspection: null,
    relayConfig: { configured: true, model: "m", provider_origin: "https://api.mistral.ai", model_available: true },
    usage: [
      {
        requestId: "req-1",
        status: "answered" as const,
        memoryIds: ["mem-1"],
        snapshot: [],
        at: "2026-11-21T15:00:00.000Z",
        completedAt: "2026-11-21T15:00:04.500Z",
        inputLabel: "Text extracted locally from your screen",
      },
    ],
    captureStage: "reviewing extracted text",
    serverStatus: {
      status: {
        namespaceId: "ns-1",
        generation: 1,
        state: "active",
        artifactCount: 2,
        observedAt: "2026-11-21T15:01:00.000Z",
      },
      fetchedAt: "2026-11-21T15:01:00.100Z",
    },
    forgetRecord: null,
    now: "2026-11-21T15:02:00.000Z",
  };

  test("browser section shows namespace/generation and honest not-inspected state", () => {
    const browser = buildEvidence(base)[0]!;
    expect(browser.title).toBe("Browser observations");
    const ns = browser.items.find((item) => item.label.includes("namespace"));
    expect(ns?.value).toContain("ns-1");
    expect(ns?.value).toContain("generation 1");
    const local = browser.items.find((item) => item.label === "Local inspection");
    expect(local?.value).toContain("not inspected yet");
    expect(local?.at).toBeNull();
  });

  test("local inspection is reported with its observation time", () => {
    const browser = buildEvidence({
      ...base,
      localInspection: { keyRecordPresent: true, keyExtractable: false, artifactCount: 3, observedAt: "2026-11-21T15:00:30.000Z" },
    })[0]!;
    const key = browser.items.find((item) => item.label.includes("key record"));
    expect(key?.value).toContain("extractable=false");
    expect(key?.at).toBe("2026-11-21T15:00:30.000Z");
    const count = browser.items.find((item) => item.label.includes("artifact count"));
    expect(count?.value).toBe("3");
  });

  test("request section shows Mistral Mind request ID label, status, elapsed time, memory IDs, input label", () => {
    const sections = buildEvidence(base);
    const requests = sections.find((section) => section.title === "Request observations");
    const req = requests?.items.find((item) => item.label.includes("req-1"));
    expect(req?.label).toContain("Mistral Mind request ID");
    expect(req?.value).toContain("status: answered");
    expect(req?.value).toContain("elapsed 4.50s");
    expect(req?.value).toContain("mem-1");
    expect(req?.value).toContain("Text extracted locally from your screen");
    const model = requests?.items.find((item) => item.label.includes("model"));
    expect(model?.value).toContain("m @ https://api.mistral.ai");
  });

  test("server section shows real artifact count and observation time; erasure ack when forgotten", () => {
    const sections = buildEvidence(base);
    const server = sections.find((section) => section.title === "Server observations");
    const count = server?.items.find((item) => item.label.includes("artifact count"));
    expect(count?.value).toBe("2");
    expect(count?.value).not.toContain("database"); // not claimed as a global count
    expect(count?.label).toContain("this namespace");
    expect(count?.at).toBe("2026-11-21T15:01:00.000Z");

    const forgottenSections = buildEvidence({
      ...base,
      vaultState: "forgotten",
      vault: null,
      serverStatus: null,
      forgetRecord: {
        namespaceId: "ns-1",
        generation: 1,
        deletionToken: "x",
        idempotencyKey: "k",
        state: "forgotten",
        remote: "completed",
        localKeyRemoved: true,
        localRecordsRemoved: 3,
        artifactsRemoved: 3,
        revokedAt: "2026-11-21T15:05:00.000Z",
        attempts: 1,
        lastError: null,
        createdAt: "2026-11-21T15:05:00.000Z",
        updatedAt: "2026-11-21T15:05:01.000Z",
      },
    });
    const forgottenServer = forgottenSections.find((section) => section.title === "Server observations");
    const ack = forgottenServer?.items.find((item) => item.label.includes("erasure acknowledgment"));
    expect(ack?.value).toContain("revoked");
    expect(ack?.value).toContain("deletion of 3 record(s)");
    const retained = forgottenServer?.items.find((item) => item.label.includes("Retained"));
    expect(retained?.value).toContain("not integrated");
  });

  test("server status failure is shown as unavailable, not as success", () => {
    const sections = buildEvidence({ ...base, serverStatus: { error: "network down", fetchedAt: "2026-11-21T15:03:00.000Z" } });
    const server = sections.find((section) => section.title === "Server observations");
    expect(server?.items[0]?.value).toContain("unavailable: network down");
  });
});

describe("demo mode has no side-effect channels", () => {
  test("demo.ts never calls the relay or writes storage", () => {
    const source = readFileSync(new URL("./demo.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/postInference|uploadArtifact|eraseNamespace|saveMemory|initVault|getVault/);
    // Actual storage/API access (not labels that merely mention the words).
    expect(source).not.toMatch(/\bindexedDB\s*\.|localStorage\s*\.|sessionStorage\s*\.|\bcaches\s*\./i);
    expect(source).not.toMatch(/console\.(log|info|debug)/);
  });

  test("the new status endpoint is reachable through the real client against the fake relay contract", async () => {
    const relay = createFakeRelay();
    const api = createRemoteApi(relay.fetchFn);
    const session = await api.createSession();
    const ns = crypto.randomUUID();
    const reg = await api.registerNamespace(session.token, ns, 1);
    expect(reg.deletionToken).not.toBeNull();
    const status = await api.getNamespaceStatus(session.token, ns);
    expect(status.state).toBe("active");
    expect(status.artifactCount).toBe(0);
    expect(status.observedAt).toBeTruthy();
    // Another session cannot see it (same answer as a nonexistent namespace).
    const other = await api.createSession();
    await expect(api.getNamespaceStatus(other.token, ns)).rejects.toThrow(/No such namespace/);
  });
});

describe("read-aloud safety", () => {
  test("speech.ts uses only local voices: no microphone, no network, no remote voice fallback", () => {
    const source = readFileSync(new URL("./speech.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/getUserMedia|\bfetch\s*\(|XMLHttpRequest/);
    expect(source).not.toMatch(/localService\s*={2,3}\s*false|localService\s*!==\s*true/);
    expect(source).toContain("localService");
  });
});
