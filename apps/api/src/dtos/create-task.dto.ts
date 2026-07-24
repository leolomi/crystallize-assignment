import {
  type CatalogueReindexPayload,
  taskPayloadSchemas,
} from "@crystallize/tasks";
import { ApiProperty } from "@nestjs/swagger";

/**
 * One body schema per endpoint (zod is this repo's single validation story —
 * no class-validator). Each endpoint owns its kind, so bodies carry no `type`
 * discriminator and a mixed-kind job is unrepresentable. The bulk endpoint has
 * no JSON body: it consumes NDJSON, validated line-by-line by ndjsonStream
 * against `taskPayloadSchemas.product_price_update`.
 */
export const catalogueReindexBodySchema = taskPayloadSchemas.catalogue_reindex;

/** Swagger mirror of the zod schema above. */
export class CreateCatalogueReindexTaskDto implements CatalogueReindexPayload {
  @ApiProperty({ example: "products" })
  catalogue!: string;
}
