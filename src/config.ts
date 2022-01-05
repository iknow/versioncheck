import { z } from "https://deno.land/x/zod@v3.11.6/index.ts";
import { parse } from "https://deno.land/std@0.119.0/encoding/yaml.ts";
import { FetchSchema } from "./fetchers.ts";

const ConfigEntrySchema = z.object({
  upstream: FetchSchema,
  usages: z.record(FetchSchema),
});

export const ConfigSchema = z.record(ConfigEntrySchema);

export type Config = z.infer<typeof ConfigSchema>;

export const PathsSchema = z.object({
  alias: z.record(z.string()),
  github: z.record(z.string()),
});

export type Paths = z.infer<typeof PathsSchema>;

export async function loadYaml<Output, Def, Input>(
  path: string,
  parser: z.ZodSchema<Output, Def, Input>,
): Promise<Output> {
  const yaml = parse(await Deno.readTextFile(path));
  return parser.parse(yaml);
}
