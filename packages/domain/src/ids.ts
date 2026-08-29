import { randomUUID } from "node:crypto";
import { z } from "zod";

type Brand<TName extends string> = { readonly __brand: TName };
export type BrandedId<TName extends string> = string & Brand<TName>;

export type SessionId = BrandedId<"SessionId">;
export type EventId = BrandedId<"EventId">;
export type RequestId = BrandedId<"RequestId">;
export type UtteranceId = BrandedId<"UtteranceId">;
export type InputEpisodeId = BrandedId<"InputEpisodeId">;
export type TurnId = BrandedId<"TurnId">;
export type GenerationId = BrandedId<"GenerationId">;
export type DeliveryId = BrandedId<"DeliveryId">;
export type DisclosureId = BrandedId<"DisclosureId">;

const idSchema = <TName extends string>() =>
  z.string().min(1) as unknown as z.ZodType<BrandedId<TName>>;

export const SessionIdSchema = idSchema<"SessionId">();
export const EventIdSchema = idSchema<"EventId">();
export const RequestIdSchema = idSchema<"RequestId">();
export const UtteranceIdSchema = idSchema<"UtteranceId">();
export const InputEpisodeIdSchema = idSchema<"InputEpisodeId">();
export const TurnIdSchema = idSchema<"TurnId">();
export const GenerationIdSchema = idSchema<"GenerationId">();
export const DeliveryIdSchema = idSchema<"DeliveryId">();
export const DisclosureIdSchema = idSchema<"DisclosureId">();

function createId<TName extends string>(prefix: string): BrandedId<TName> {
  return `${prefix}_${randomUUID()}` as BrandedId<TName>;
}

export const newSessionId = (): SessionId => createId<"SessionId">("session");
export const newEventId = (): EventId => createId<"EventId">("event");
export const newRequestId = (): RequestId => createId<"RequestId">("request");
export const newInputEpisodeId = (): InputEpisodeId => createId<"InputEpisodeId">("episode");
export const newTurnId = (): TurnId => createId<"TurnId">("turn");
export const newGenerationId = (): GenerationId => createId<"GenerationId">("generation");
export const newDeliveryId = (): DeliveryId => createId<"DeliveryId">("delivery");

