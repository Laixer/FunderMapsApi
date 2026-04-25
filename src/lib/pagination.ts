import { z } from "zod/v4";

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;
