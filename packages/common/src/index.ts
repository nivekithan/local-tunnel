import z from "zod";

export const RegisteredMessageSchema = z.object({
  type: z.literal("registered"),
  clientId: z.string(),
  subdomain: z.string(),
});

export const AuthChallengeMessageSchema = z.object({
  type: z.literal("auth_challenge"),
  nonce: z.string(),
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
  AuthChallengeMessageSchema,
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

export const HashAlgorithmSchema = z.enum([
  "md5",
  "sha1",
  "sha256",
  "sha384",
  "sha512",
]);

export const AuthResponseMessageSchema = z.object({
  type: z.literal("auth_response"),
  publicKey: z.string(),
  signature: z.string(),
  hashAlgorithm: HashAlgorithmSchema,
});

export const ClientSentMessageSchema = z.discriminatedUnion("type", [
  AuthResponseMessageSchema,
  ResponseMessageSchema,
]);

export type RegisteredMessage = z.infer<typeof RegisteredMessageSchema>;
export type AuthChallengeMessage = z.infer<typeof AuthChallengeMessageSchema>;
export type RequestMessage = z.infer<typeof RequestMessageSchema>;
export type ServerSentMessage = z.infer<typeof ServerSentMessageSchema>;
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export type AuthResponseMessage = z.infer<typeof AuthResponseMessageSchema>;

export type ClientSentMessage = z.infer<typeof ClientSentMessageSchema>;

export function parseServerSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ServerSentMessageSchema.parse(parsed);
}

export function parseClientSentMessage(data: string) {
  const parsed = JSON.parse(data.toString());
  return ClientSentMessageSchema.parse(parsed);
}
