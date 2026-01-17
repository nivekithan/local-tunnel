import z from "zod";

export const RegisteredMessageSchema = z.object({
  type: z.literal("registered"),
  clientId: z.string(),
  subdomain: z.string(),
});

export const RequestMessageSchema = z.object({
  type: z.literal("request"),
  requestId: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.record(
    z.string(),
    z.union([z.string(), z.array(z.string()), z.undefined()]),
  ),
  body: z.string(),
});

export const ServerSentMessageSchema = z.union([
  RegisteredMessageSchema,
  RequestMessageSchema,
]);

export const ResponseMessageSchema = z.object({
  type: z.literal("response"),
  requestId: z.string(),
  statusCode: z.number(),
  headers: z.record(
    z.string(),
    z.union([z.string(), z.array(z.string()), z.undefined()]),
  ),
  body: z.string(),
});

export const ClientSentMessageSchema = z.discriminatedUnion("type", [
  ResponseMessageSchema,
]);

export type RegisteredMessage = z.infer<typeof RegisteredMessageSchema>;
export type RequestMessage = z.infer<typeof RequestMessageSchema>;
export type ServerSentMessage = z.infer<typeof ServerSentMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export type ClientSentMessage = z.infer<typeof ClientSentMessageSchema>;

export function parseServerSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ServerSentMessageSchema.parse(parsed);
}

export function parseClientSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ClientSentMessageSchema.parse(parsed);
}
