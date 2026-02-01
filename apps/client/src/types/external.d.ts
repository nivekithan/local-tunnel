declare module "sshpk-agent" {
  import type sshpk from "sshpk";

  export interface ClientOptions {
    socketPath?: string;
    timeout?: number;
  }

  export interface RequestOptions {
    timeout?: number;
  }

  export class Client {
    constructor(opts?: ClientOptions);
    listKeys(cb: (err: Error | null, keys: sshpk.Key[]) => void): void;
    listKeys(opts: RequestOptions, cb: (err: Error | null, keys: sshpk.Key[]) => void): void;
    sign(
      key: sshpk.Key,
      data: Buffer | string,
      cb: (err: Error | null, signature: sshpk.Signature) => void,
    ): void;
    sign(
      key: sshpk.Key,
      data: Buffer | string,
      opts: RequestOptions,
      cb: (err: Error | null, signature: sshpk.Signature) => void,
    ): void;
  }

  export class AgentProtocolError extends Error {}

  const mod: {
    Client: typeof Client;
    AgentProtocolError: typeof AgentProtocolError;
  };

  export default mod;
}
