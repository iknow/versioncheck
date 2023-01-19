import { YAML, z } from "./deps.ts";
import { FetchSchema } from "./fetchers.ts";
import { UsageSchema } from "./usage.ts";

const ConfigEntrySchema = z.object({
  upstream: FetchSchema,
  usages: z.record(UsageSchema),
});

export const ConfigSchema = z.record(ConfigEntrySchema);

export type Config = z.infer<typeof ConfigSchema>;

export const PathsSchema = z.object({
  alias: z.record(z.string()),
  github: z.record(z.string()),
});

export type Paths = z.infer<typeof PathsSchema>;

export async function loadYaml<Output, Def extends z.ZodTypeDef, Input>(
  path: string,
  parser: z.ZodSchema<Output, Def, Input>,
): Promise<Output> {
  const yaml = YAML.parse(await Deno.readTextFile(path));
  return parser.parse(yaml);
}
