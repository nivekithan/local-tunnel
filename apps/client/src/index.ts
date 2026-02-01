#!/usr/bin/env node

import { yargsCli } from "./cli/cmd.ts";

await yargsCli.parse();
