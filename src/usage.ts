import { jmespath, path, YAML, z } from "./deps.ts";
import { Paths } from "./config.ts";
import { requireRegexp, Version } from "./version.ts";

export interface UsageContext {
  tokens?: Record<string, string>;
  paths?: Paths;
}

interface LocalSource {
  type: "local";
  path: string;
}

interface GithubSource {
  type: "github";
  owner: string;
  repo: string;
  path: string;
  rev: string;
}

type FileSource = LocalSource | GithubSource;

const FileUsageSchema = z.object({
  type: z.literal("file"),
  source: z.string(),
  parser: z.union([
    z.object({
      type: z.literal("yaml"),
      query: z.string(),
      regexp: z.string().optional(),
    }),
    z.object({
      type: z.literal("regexp"),
      regexp: z.string(),
    }),
  ]),
});

type FileUsage = z.infer<typeof FileUsageSchema>;

export const UsageSchema = FileUsageSchema;

export type Usage = FileUsage;

async function getFile(
  source: FileSource,
  context: UsageContext,
): Promise<string> {
  if (source.type === "local") {
    let sourcePath = source.path;
    if (context.paths) {
      sourcePath = normalizePaths(source, context.paths);
    }
    return await Deno.readTextFile(sourcePath);
  } else if (source.type === "github") {
    if (context.tokens) {
      const url = new URL(
        `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${source.path}`,
      );
      url.searchParams.set("rev", source.rev);

      const token = context.tokens[source.owner] ?? context.tokens.default;
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github.raw",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status !== 200) {
        throw new Error(
          `Got status ${response.status}: ${await response.text()}`,
        );
      }
      return await response.text();
    } else if (context.paths) {
      return await Deno.readTextFile(normalizePaths(source, context.paths));
    } else {
      throw new Error("GitHub sources require --path or --token specified");
    }
  } else {
    throw new Error("Unreachable code");
  }
}

export async function getUsage(
  spec: FileUsage,
  context: UsageContext,
): Promise<Version> {
  const source = normalizeSource(spec.source);
  const rawText = await getFile(source, context);
  if (spec.parser.type === "yaml") {
    let rawYaml = YAML.parseAll(rawText);
    if (Array.isArray(rawYaml) && rawYaml.length === 1) {
      rawYaml = rawYaml[0];
    }
    let version = jmespath.search(
      rawYaml as jmespath.JSONValue,
      spec.parser.query,
    )?.toString();
    if (version === undefined) {
      throw new Error(`${spec.parser.query} in ${spec.source} not found`);
    }
    version = requireRegexp(version, spec.parser.regexp);
    return new Version(version);
  } else if (spec.parser.type === "regexp") {
    const version = requireRegexp(rawText, spec.parser.regexp);
    return new Version(version);
  } else {
    throw new Error("Unknown parser type");
  }
}

export function normalizeSource(source: string): FileSource {
  if (source.startsWith("/")) {
    return { type: "local", path: source };
  }

  const url = new URL(source);
  if (url.host === "github.com") {
    const [_, owner, repo, type, rev, ...rest] = url.pathname.split("/");
    if (type !== "blob" || rev === undefined || rest.length === 0) {
      throw new Error(`Invalid github URL: ${source}`);
    }
    return {
      type: "github",
      owner,
      repo,
      rev,
      path: path.join(...rest),
    };
  } else {
    throw new Error(`Unsupported path: ${source}`);
  }
}

export function normalizePaths(source: FileSource, paths: Paths): string {
  if (source.type === "local") {
    let newPath = source.path;
    let changed: boolean;
    do {
      changed = false;
      for (const [key, value] of Object.entries(paths.alias)) {
        const replacedPath = newPath.replaceAll(key, value);
        if (replacedPath !== newPath) {
          changed = true;
        }
        newPath = replacedPath;
      }
    } while (changed);
    return newPath;
  } else if (source.type === "github") {
    const pathKey = `${source.owner}/${source.repo}`;
    const mappedPath = paths.github[pathKey];
    if (mappedPath === undefined) {
      throw new Error(`Could not resolve github path ${pathKey}`);
    }
    return normalizePaths({
      type: "local",
      path: path.join(mappedPath, source.path),
    }, paths);
  } else {
    throw new Error("Unreachable code");
  }
}
