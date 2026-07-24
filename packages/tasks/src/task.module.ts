import { DatabaseModule } from "@crystallize/database";
import { Module } from "@nestjs/common";

import { TaskRepository } from "./repositories/task.repository";
import { TaskRowRepository } from "./repositories/task-row.repository";

/**
 * Exposes the shared repositories: TaskRepository for the task lifecycle,
 * TaskRowRepository for the row ledger. Imports DatabaseModule explicitly —
 * the module states its own needs instead of leaning on a global provider,
 * so importing TaskModule alone is enough to get working repositories.
 */
@Module({
  imports: [DatabaseModule],
  providers: [TaskRepository, TaskRowRepository],
  exports: [TaskRepository, TaskRowRepository],
})
export class TaskModule {}
