import z from "zod";

export const ServerSentMessage = z.union([
  z.object({ type: z.literal("registered") }),
]);
