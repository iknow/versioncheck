import { join } from "https://deno.land/std@0.119.0/path/mod.ts";
import { z } from "https://deno.land/x/zod@v3.11.6/index.ts";
import {
  DOMParser,
  initParser,
} from "https://deno.land/x/deno_dom/deno-dom-wasm-noinit.ts";
import * as YAML from "https://deno.land/std@0.119.0/encoding/yaml.ts";
import * as semver from "https://deno.land/x/semver@v1.4.0/mod.ts";
import {
  JSONValue,
  search,
} from "https://deno.land/x/jmespath@v0.2.2/index.ts";
import { Cache } from "./cache.ts";
import { Paths } from "./config.ts";

const BaseFetchSchema = z.object({
  versionSpec: z.string().optional(),
  prerelease: z.boolean().default(false),
});

const GithubReleaseFetchSchema = BaseFetchSchema.extend({
  type: z.literal("github_release"),
  owner: z.string(),
  repo: z.string(),
  regexp: z.string().optional(),
});

const GithubReleaseResponseSchema = z.array(z.object({
  name: z.string(),
  tag_name: z.string(),
  prerelease: z.boolean(),
}));

type GithubReleaseFetch = z.infer<typeof GithubReleaseFetchSchema>;

const FileSourceSchema = z.union([
  z.string(),
  z.object({
    type: z.literal("local"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("github"),
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    rev: z.string().default("HEAD"),
  }),
]);

type FileSource = z.infer<typeof FileSourceSchema>;

const FileFetchSchema = BaseFetchSchema.extend({
  type: z.literal("file"),
  source: FileSourceSchema,
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

type FileFetch = z.infer<typeof FileFetchSchema>;

const HtmlFetchSchema = BaseFetchSchema.extend({
  type: z.literal("html"),
  url: z.string(),
  selector: z.string(),
  regexp: z.string().optional(),
});

type HtmlFetch = z.infer<typeof HtmlFetchSchema>;

const HelmFetchSchema = BaseFetchSchema.extend({
  type: z.literal("helm"),
  repo: z.string(),
  chart: z.string(),
});

const HelmResponseSchema = z.object({
  apiVersion: z.literal("v1"),
  entries: z.record(z.array(z.object({
    apiVersion: z.union([z.literal("v1"), z.literal("v2")]),
    version: z.string(),
    appVersion: z.string().optional(),
  }))),
});

type HelmFetch = z.infer<typeof HelmFetchSchema>;

export const FetchSchema = z.union([
  GithubReleaseFetchSchema,
  FileFetchSchema,
  HtmlFetchSchema,
  HelmFetchSchema,
]);

export type Fetch = z.infer<typeof FetchSchema>;

export interface Context {
  paths: Paths;
  cache: Cache;
  update: boolean;
}

export interface VersionResult {
  version: Version;
  latest?: Version;
  versions?: Version[];
}

export class Version {
  public readonly semantic: semver.SemVer;
  public readonly main: string;
  public readonly app?: string;
  public readonly prerelease: boolean;

  constructor(main: string, app?: string, prerelease?: boolean) {
    // coerce does not include prerelease tags so we try strict parsing first and then coerce if that fails
    const semantic = semver.parse(main) ?? semver.coerce(main);
    if (semantic === null) {
      throw new Error(`'${main}' could not be parsed as a version`);
    }
    this.semantic = semantic;
    this.main = cleanVersion(main);
    this.app = app && cleanVersion(app);
    this.prerelease = prerelease === undefined
      ? this.semantic.prerelease.length > 0
      : prerelease;
  }
}

/**
 * Cleans the version string
 *
 * Primarily, we want to strip the leading `v` even for non-semver versions.
 */
function cleanVersion(version: string): string {
  return semver.clean(version) ?? version.replace(/^v([0-9])/, "$1");
}

export function normalizePaths(source: FileSource, paths: Paths): string {
  if (typeof source === "string") {
    if (source.startsWith("/")) {
      return normalizePaths({ type: "local", path: source }, paths);
    }

    const url = new URL(source);
    if (url.host === "github.com") {
      const [_, owner, repo, type, rev, ...rest] = url.pathname.split("/");
      if (type !== "blob" || rev === undefined || rest.length === 0) {
        throw new Error(`Invalid github URL: ${source}`);
      }
      return normalizePaths({
        type: "github",
        owner,
        repo,
        rev,
        path: join(...rest),
      }, paths);
    } else {
      throw new Error(`Unsupported path: ${source}`);
    }
  } else if (source.type === "local") {
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
      path: join(mappedPath, source.path),
    }, paths);
  } else {
    throw new Error("Unreachable code");
  }
}

function applyRegexp(raw: string, regexp: string | undefined): string | null {
  return applyRegexpRaw(raw, regexp, () => {
    return null;
  });
}

function requireRegexp(raw: string, regexp: string | undefined): string {
  return applyRegexpRaw(raw, regexp, () => {
    throw new Error(`No match for ${regexp} in ${raw}`);
  });
}

function applyRegexpRaw<T>(
  raw: string,
  regexp: string | undefined,
  onFail: () => T,
): string | T {
  if (regexp) {
    const result = raw.match(new RegExp(regexp, "sm"));
    if (result === null) {
      return onFail();
    }
    if (result.length > 1) {
      return result[1];
    } else {
      return result[0];
    }
  }
  return raw;
}

async function fetchGithubRelease(
  spec: GithubReleaseFetch,
  context: Context,
): Promise<Version[]> {
  const body = await fetchUrl(
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases`,
    context,
  );
  const json = JSON.parse(body);
  const parsed = GithubReleaseResponseSchema.parse(json);

  return parsed.flatMap(({ tag_name, prerelease }) => {
    const version = applyRegexp(tag_name, spec.regexp);
    if (version === null) {
      return [];
    }
    return new Version(version, undefined, prerelease);
  });
}

async function fetchFile(
  spec: FileFetch,
  context: Context,
): Promise<Version> {
  const rawText = await Deno.readTextFile(
    normalizePaths(spec.source, context.paths),
  );
  if (spec.parser.type === "yaml") {
    let rawYaml = YAML.parseAll(rawText);
    if (Array.isArray(rawYaml) && rawYaml.length === 1) {
      rawYaml = rawYaml[0];
    }
    let version = search(rawYaml as JSONValue, spec.parser.query)?.toString();
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

async function fetchUrl(url: string, context: Context): Promise<string> {
  let body = undefined as string | undefined;
  if (!context.update) {
    const cached = context.cache.getBody(url);
    if (cached) {
      body = cached;
    }
  }

  if (body === undefined) {
    const response = await fetch(url);
    if (response.status !== 200) {
      throw new Error(
        `Got status ${response.status}: ${await response.text()}`,
      );
    }
    body = await response.text();
    context.cache.saveBody(url, body);
  }

  return body;
}

async function fetchHtml(
  spec: HtmlFetch,
  context: Context,
): Promise<Version[]> {
  const html = await fetchUrl(spec.url, context);

  await initParser();
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc === null) {
    throw new Error(`Could not parse as HTML: ${html}`);
  }

  const versions: Version[] = [];
  const elements = doc.querySelectorAll(spec.selector);
  if (elements.length === 0) {
    throw new Error(`Could not find ${spec.selector} in ${html}`);
  }
  for (const element of elements) {
    const version = applyRegexp(element.textContent, spec.regexp);
    if (version === null) {
      continue;
    }
    versions.push(new Version(version));
  }
  return versions;
}

async function fetchHelm(
  spec: HelmFetch,
  context: Context,
): Promise<Version[]> {
  const rawText = await fetchUrl(`${spec.repo}/index.yaml`, context);
  const rawYaml = YAML.parse(rawText);
  const helmRepo = HelmResponseSchema.parse(rawYaml);

  const chartVersions = helmRepo.entries[spec.chart];
  if (chartVersions === undefined) {
    throw new Error(`Chart ${spec.chart} does not exist in ${spec.repo}`);
  }
  if (chartVersions.length === 0) {
    throw new Error(`No versions for chart ${spec.chart} of ${spec.repo}`);
  }

  return chartVersions.map((entry) => {
    if (entry.appVersion !== undefined) {
      return new Version(entry.version, entry.appVersion);
    } else {
      return new Version(entry.version);
    }
  });
}

function assertNever(): never {
  throw new Error("Unreachable code");
}

export async function fetchVersion(
  spec: Fetch,
  context: Context,
): Promise<VersionResult> {
  const versions = await fetchVersions(spec, context);
  if (!Array.isArray(versions)) {
    return { version: versions };
  }

  if (versions.length === 0) {
    throw new Error(`No versions found`);
  }

  const validVersions = spec.prerelease
    ? versions
    : versions.filter(({ prerelease }) => {
      return !prerelease;
    });

  if (validVersions.length === 0) {
    throw new Error("No valid versions");
  }

  validVersions.sort((a, b) => {
    let result: number = semver.rcompare(a.semantic, b.semantic);
    if (result === 0) {
      result = -a.main.localeCompare(b.main);
    }
    return result;
  });

  const latest = validVersions[0];
  const version = spec.versionSpec
    ? validVersions.find(({ semantic }) =>
      semver.satisfies(semantic, spec.versionSpec!)
    )
    : latest;

  if (version === undefined) {
    throw new Error("No compatible version");
  }

  return { version, latest, versions: validVersions };
}

export async function fetchVersions(
  spec: Fetch,
  context: Context,
): Promise<Version | Version[]> {
  switch (spec.type) {
    case "github_release":
      return await fetchGithubRelease(spec, context);
    case "file":
      return await fetchFile(spec, context);
    case "html":
      return await fetchHtml(spec, context);
    case "helm":
      return await fetchHelm(spec, context);
    default:
      assertNever();
  }
}
