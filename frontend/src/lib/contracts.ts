import { z } from "zod";
export const accountIdentitySchema = z.object({ account_id: z.string() });
export const accountSchema = z.object({
  account_id: z.string(),
  is_guest: z.boolean(),
  nickname: z.string().nullable(),
  photo_url: z.string().nullable(),
  adult_mode: z.boolean(),
  adult_verified: z.boolean(),
  adult_verification_rejected: z.boolean(),
  consent_required: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;
export const characterSchema = z.object({
  id: z.string(),
  name: z.string(),
  image_url: z.string(),
});
export const homeSchema = z.object({
  banner: z
    .object({
      character_id: z.string(),
      name: z.string(),
      image_url: z.string(),
    })
    .nullable(),
  sections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      characters: z.array(
        characterSchema.extend({
          tagline: z.string(),
          creator_name: z.string(),
        }),
      ),
    }),
  ),
});
export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  created_at: z.string(),
  client_message_id: z.string().nullable(),
  turn_status: z.enum(["generating", "completed", "failed"]).nullable(),
  error_code: z.string().nullable(),
});
export type Message = z.infer<typeof messageSchema>;
export const roomSchema = z.object({
  room_id: z.string(),
  character: characterSchema,
  messages: z.array(messageSchema),
  generating: z.boolean(),
});
export type Room = z.infer<typeof roomSchema>;
export const recentSchema = z.object({
  chats: z.array(
    z.object({
      room_id: z.string(),
      character: characterSchema,
      last_message: z.string().nullable(),
      updated_at: z.string(),
    }),
  ),
});
export type RecentResponse = z.infer<typeof recentSchema>;
export const openSchema = z.object({
  room_id: z.string(),
  created: z.boolean(),
});
export const sendSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  client_message_id: z.uuid(),
});
export const scenarioSchema = z.object({
  response: z.enum(["normal", "slow", "fail", "disconnect"]),
  home: z.enum(["normal", "empty", "error"]),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export const eventsSchema = z.array(
  z.object({
    name: z.string(),
    at: z.string(),
    account_id: z.string(),
    properties: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  }),
);
export type LocalEvent = z.infer<typeof eventsSchema>[number];
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 500,
    public detail?: unknown,
  ) {
    super(code);
  }
}
