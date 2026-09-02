import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import {
  createCoreHarness,
  authorizeSafeProbe
} from "./harness.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function audioRef(seed: string): string {
  return `audio_v1_${sha256(seed)}`;
}

describe("authoritative voice delivery admission", () => {
  it("derives AUDIO only from the exact validated speech text and preserves disclosure semantics", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);

      const atom = await harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("validated-voice-fixture")
      });

      expect(atom).toBeDefined();
      expect(atom?.content).toEqual({
        medium: "AUDIO",
        text: harness.safeProbe,
        audioRef: audioRef("validated-voice-fixture")
      });
      expect(atom?.generationId).toBe(source.generationId);
      expect(atom?.disclosureIds).toEqual(source.disclosureIds);
      expect(atom?.effectiveDisclosureLevel).toBe(source.effectiveDisclosureLevel);
      expect(harness.writer.getState().deliveries[atom?.deliveryId ?? "missing" as never]?.status)
        .toBe("QUEUED");

      await expect(harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: `${harness.safeProbe} semantic substitution`,
        textSha256: sha256(`${harness.safeProbe} semantic substitution`),
        audioRef: audioRef("substitution")
      })).resolves.toBeUndefined();

      await expect(harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: "0".repeat(64),
        audioRef: audioRef("wrong-hash")
      })).rejects.toThrow(/hash does not match/u);
    } finally {
      harness.store.close();
    }
  });

  it("keeps TEXT and AUDIO as separate exposures without duplicating semantic disclosure ids", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);
      await deliveries.acknowledgeExposed(source.deliveryId);

      const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("multimodal-disclosure")
      });
      if (audio === undefined) throw new Error("Expected authoritative AUDIO delivery");
      await deliveries.markStarted(audio.deliveryId);
      await deliveries.acknowledgeExposed(audio.deliveryId);

      const state = harness.writer.getState();
      expect(state.deliveries[source.deliveryId]?.status).toBe("EXPOSED");
      expect(state.deliveries[audio.deliveryId]?.status).toBe("EXPOSED");
      expect(audio.disclosureIds).toEqual(source.disclosureIds);
      expect(state.disclosureLedger).toEqual([...new Set(source.disclosureIds)]);
    } finally {
      harness.store.close();
    }
  });

  it("lets beginUtterance supersede generation authority and conservatively classify started audio", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);

      const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("started-audio")
      });
      if (audio === undefined) throw new Error("Expected authoritative AUDIO delivery");
      await deliveries.markStarted(audio.deliveryId);

      const utteranceId = await harness.turns.beginUtterance();
      const state = harness.writer.getState();

      expect(state.utterances[utteranceId]?.status).toBe("CAPTURING");
      expect(state.generations[harness.generationId]?.status).toBe("SUPERSEDED");
      expect(state.deliveries[source.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
      expect(state.deliveries[audio.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");

      await expect(harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("late-old-tts")
      })).resolves.toBeUndefined();
    } finally {
      harness.store.close();
    }
  });

  it("rejects late TTS admission after the session becomes terminal", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);
      await deliveries.acknowledgeExposed(source.deliveryId);
      await deliveries.acknowledgeCompleted(source.deliveryId);

      await harness.turns.completeSession();
      expect(harness.writer.getState().status).toBe("COMPLETED");
      expect(harness.writer.getState().generations[harness.generationId]?.status)
        .toBe("SUPERSEDED");

      await expect(harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("terminal-late-tts")
      })).resolves.toBeUndefined();

      expect(Object.values(harness.writer.getState().deliveries)
        .filter((delivery) => delivery.content.medium === "AUDIO"))
        .toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("preserves persisted AUDIO exposure across a later barge-in", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);
      await deliveries.acknowledgeExposed(source.deliveryId);

      const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("already-exposed-audio")
      });
      if (audio === undefined) throw new Error("Expected authoritative AUDIO delivery");
      await deliveries.markStarted(audio.deliveryId);
      await deliveries.acknowledgeExposed(audio.deliveryId);

      await harness.turns.beginUtterance();

      expect(harness.writer.getState().deliveries[audio.deliveryId]?.status).toBe("EXPOSED");
      expect(harness.writer.getState().deliveries[source.deliveryId]?.status).toBe("EXPOSED");
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("safely cancels queued audio on barge-in without rewriting it as exposed", async () => {
    const harness = await createCoreHarness();
    try {
      const source = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(source.deliveryId);

      const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
        sourceDeliveryId: source.deliveryId,
        generationId: harness.generationId,
        text: harness.safeProbe,
        textSha256: sha256(harness.safeProbe),
        audioRef: audioRef("queued-audio")
      });
      if (audio === undefined) throw new Error("Expected authoritative AUDIO delivery");

      await harness.turns.beginUtterance();

      expect(harness.writer.getState().deliveries[audio.deliveryId]?.status).toBe("CANCELLED");
      expect(harness.writer.getState().deliveries[source.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      harness.store.close();
    }
  });
});
