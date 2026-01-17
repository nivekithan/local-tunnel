import z from "zod";

// Messages sent from server to client
export const RegisteredMessage = z.object({
  type: z.literal("registered"),
  clientId: z.string(),
  subdomain: z.string(),
});

export const RequestMessage = z.object({
  type: z.literal("request"),
  requestId: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.string(),
});

export const ServerSentMessage = z.union([RegisteredMessage, RequestMessage]);

// Messages sent from client to server
export const ResponseMessage = z.object({
  type: z.literal("response"),
  requestId: z.string(),
  statusCode: z.number(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.string(),
});

export const ClientSentMessage = z.union([ResponseMessage]);

// Type exports
export type RegisteredMessage = z.infer<typeof RegisteredMessage>;
export type RequestMessage = z.infer<typeof RequestMessage>;
export type ServerSentMessage = z.infer<typeof ServerSentMessage>;
export type ResponseMessage = z.infer<typeof ResponseMessage>;
export type ClientSentMessage = z.infer<typeof ClientSentMessage>;

// Parse functions with error handling
export function parseServerSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ServerSentMessage.parse(parsed);
}

export function parseClientSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ClientSentMessage.parse(parsed);
}
