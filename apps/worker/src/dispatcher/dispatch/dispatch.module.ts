import { Module } from "@nestjs/common";

import { ExecutionModule } from "../../runner/execution.module";
import { Dispatcher } from "./services/dispatcher.service";
import { InlineRunner } from "./services/inline-runner.service";
import { RunnerLauncher } from "./services/runner-launcher.service";

/**
 * The consume half of the process: poll, claim, route. Heavy tasks are spawned
 * as one-shot runner processes; light tasks run inline through the shared
 * ExecutionModule (threshold routing, ADR 0006).
 */
@Module({
  imports: [ExecutionModule],
  providers: [Dispatcher, RunnerLauncher, InlineRunner],
})
export class DispatchModule {}
