import {
  TaskKind,
  TaskRepository,
  TaskRowRepository,
  TaskStatus,
  taskPayloadSchemas,
} from "@crystallize/tasks";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { match } from "ts-pattern";
import { z } from "zod";

import {
  CreateCatalogueReindexTaskDto,
  catalogueReindexBodySchema,
} from "../dtos/create-task.dto";
import {
  DeadLettersDto,
  deadLetterQuerySchema,
  RetryResultDto,
} from "../dtos/dead-letter.dto";
import { TaskCreatedDto, TaskDetailsDto } from "../dtos/task-response.dto";
import { TaskIngestionService } from "../services/task-ingestion.service";
import { ndjsonStream } from "../utils/ndjson-stream";

/** zod-parse a JSON body or 400 with the precise violation. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(z.prettifyError(result.error));
  }
  return result.data;
}

/**
 * One creation endpoint per task kind (each with its own body type), plus the
 * uniform status endpoint — the task resource itself (queue, claim, resume)
 * does not care where a task came from.
 */
@ApiTags("tasks")
@Controller("tasks")
export class TasksController {
  constructor(
    private readonly ingestion: TaskIngestionService,
    private readonly repo: TaskRepository,
    private readonly rowRepo: TaskRowRepository,
  ) {}

  /**
   * POST /tasks/product-price-updates — the bulk kind. NDJSON only: one
   * `{ id, price }` payload per line, streamed and inserted in batches so a
   * 50k-line job is never buffered whole in memory.
   */
  @Post("product-price-updates")
  @ApiOperation({
    summary: "Create a bulk product price update task",
    description:
      "Streams an `application/x-ndjson` body — one `{ id, price }` payload " +
      "per line — and publishes the task to the dispatcher once every row " +
      "is stored.",
  })
  @ApiConsumes("application/x-ndjson")
  @ApiBody({
    description: "NDJSON: one product price payload per line.",
    schema: {
      type: "string",
      example: '{"id":"prod-1","price":9.99}\n{"id":"prod-2","price":19.5}',
    },
  })
  @ApiCreatedResponse({ type: TaskCreatedDto })
  @ApiBadRequestResponse({
    description: "Wrong content type, malformed line, or empty job",
  })
  createProductPriceUpdate(@Req() req: Request) {
    // Guard, not a branch: an application/json body would already be drained
    // by express's parser, leaving a confusing "empty job" instead of this.
    if (!req.is("application/x-ndjson")) {
      throw new BadRequestException(
        'expected "application/x-ndjson": one {"id", "price"} payload per line',
      );
    }

    const payloads = ndjsonStream(
      req,
      taskPayloadSchemas[TaskKind.PRODUCT_PRICE_UPDATE],
    );
    return this.ingestion.ingest(TaskKind.PRODUCT_PRICE_UPDATE, payloads);
  }

  /**
   * POST /tasks/catalogue-reindex — the long external kind. Not a bulk job:
   * the body IS the single payload.
   */
  @Post("catalogue-reindex")
  @ApiOperation({ summary: "Create a catalogue re-index task" })
  @ApiBody({ type: CreateCatalogueReindexTaskDto })
  @ApiCreatedResponse({ type: TaskCreatedDto })
  @ApiBadRequestResponse({ description: "Malformed body" })
  createCatalogueReindex(@Body() body?: CreateCatalogueReindexTaskDto) {
    const payload = parseBody(catalogueReindexBodySchema, body);
    return this.ingestion.ingest(TaskKind.CATALOGUE_REINDEX, [payload]);
  }

  /**
   * GET /tasks/:id/dead-letters — inspect a task's dead-lettered rows. The DLQ
   * is a status, not a separate queue: these are the rows `failed` after
   * exhausting their attempts, with the error that killed them.
   */
  @Get(":id/dead-letters")
  @ApiOperation({ summary: "List a task's dead-lettered rows" })
  @ApiOkResponse({ type: DeadLettersDto })
  @ApiNotFoundResponse({ description: "Unknown task id" })
  async deadLetters(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<DeadLettersDto> {
    const { limit, offset } = parseBody(deadLetterQuerySchema, query ?? {});
    const task = await this.repo.getTask(id);
    if (!task) throw new NotFoundException(`task ${id} not found`);
    const rows = await this.rowRepo.fetchFailedRows(id, limit, offset);
    return { taskId: id, rows };
  }

  /**
   * POST /tasks/:id/retry — replay a failed task: its dead-lettered rows go
   * back to `pending` with a fresh attempts budget and the task is
   * re-published. `done` rows are untouched, so the no-double-apply guarantee
   * holds for replays too. Also the recovery path for a task the sweeper
   * dead-lettered after exhausting its restart budget.
   */
  @Post(":id/retry")
  @ApiOperation({ summary: "Replay a failed task (dead-lettered rows only)" })
  @ApiCreatedResponse({ type: RetryResultDto })
  @ApiNotFoundResponse({ description: "Unknown task id" })
  @ApiBadRequestResponse({
    description: "Task failed during ingestion and was never fully stored",
  })
  async retry(@Param("id") id: string): Promise<RetryResultDto> {
    const result = await this.repo.retryFailed(id);
    return match(result)
      .with({ outcome: "retried" }, ({ retriedRows }) => ({
        id,
        status: TaskStatus.PENDING as const,
        retriedRows,
      }))
      .with({ outcome: "not_found" }, () => {
        throw new NotFoundException(`Task ${id} not found`);
      })
      .with({ outcome: "not_failed" }, () => {
        throw new ConflictException(
          `Task ${id} is not failed — nothing to retry`,
        );
      })
      .with({ outcome: "never_published" }, () => {
        throw new BadRequestException(
          `Task ${id} failed during ingestion and was never fully stored — submit the job again`,
        );
      })
      .exhaustive();
  }

  /** GET /tasks/:id — live status and progress. */
  @Get(":id")
  @ApiOperation({ summary: "Task status and progress" })
  @ApiOkResponse({ type: TaskDetailsDto })
  @ApiNotFoundResponse({ description: "Unknown task id" })
  async get(@Param("id") id: string): Promise<TaskDetailsDto> {
    const task = await this.repo.getTask(id);
    if (!task) {
      throw new NotFoundException(`task ${id} not found`);
    }
    const progress =
      task.totalRows > 0
        ? Number((task.processedRows / task.totalRows).toFixed(4))
        : 0;
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      weight: task.weight,
      totalRows: task.totalRows,
      processedRows: task.processedRows,
      progress,
      error: task.error,
      runnerPid: task.runnerPid,
      heartbeatAt: task.heartbeatAt,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }
}
