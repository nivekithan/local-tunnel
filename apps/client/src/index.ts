#!/usr/bin/env bun

import { yargsCli } from "./cli/cmd.ts";

await yargsCli.parse();
