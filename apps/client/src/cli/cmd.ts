import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ServeCommand } from "./serve.ts";

export const yargsCli = yargs(hideBin(process.argv))
  .scriptName("ntunnel")
  .usage("Usage: $0 <command> [options]")
  .command(ServeCommand);
