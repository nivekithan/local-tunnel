declare module "sshpk-agent" {
  import { EventEmitter } from "node:events";
  import type sshpk from "sshpk";

  export interface ClientOptions {
    socketPath?: string;
    timeout?: number;
  }

  export interface RequestOptions {
    timeout?: number;
  }

  export interface AgentSignRequestFrame {
    type: "sign-request";
    publicKey: Buffer;
    data: Buffer;
    flags: string[];
  }

  export interface AgentFailureFrame {
    type: "failure";
  }

  export interface AgentSignResponseFrame {
    type: "sign-response";
    signature: Buffer;
  }

  export type AgentSignResponse = AgentFailureFrame | AgentSignResponseFrame;

  export class Client extends EventEmitter {
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

    doRequest(
      frame: AgentSignRequestFrame,
      resps: Array<AgentSignResponse["type"]>,
      timeout: number,
      cb: (err: Error | null, resp: AgentSignResponse) => void,
    ): void;
  }

  export class AgentProtocolError extends Error {}

  const mod: {
    Client: typeof Client;
    AgentProtocolError: typeof AgentProtocolError;
  };

  export default mod;
}
