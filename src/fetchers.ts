import { dom, semver, YAML, z } from "./deps.ts";
import { Cache } from "./cache.ts";
import { applyRegexp, Version } from "./version.ts";

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

const GithubTagFetchSchema = BaseFetchSchema.extend({
  type: z.literal("github_tag"),
  owner: z.string(),
  repo: z.string(),
  regexp: z.string().optional(),
});

const GithubTagResponseSchema = z.array(z.object({
  name: z.string(),
}));

type GithubTagFetch = z.infer<typeof GithubTagFetchSchema>;

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
  GithubTagFetchSchema,
  HtmlFetchSchema,
  HelmFetchSchema,
]);

export type Fetch = z.infer<typeof FetchSchema>;

export interface FetchContext {
  cache: Cache;
  update: boolean;
}

export interface FetchResult {
  version: Version;
  latest?: Version;
  versions?: Version[];
}

async function fetchGithubRelease(
  spec: GithubReleaseFetch,
  context: FetchContext,
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

async function fetchGithubTag(
  spec: GithubTagFetch,
  context: FetchContext,
): Promise<Version[]> {
  const body = await fetchUrl(
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/tags`,
    context,
  );
  const json = JSON.parse(body);
  const parsed = GithubTagResponseSchema.parse(json);

  return parsed.flatMap(({ name }) => {
    const version = applyRegexp(name, spec.regexp);
    if (version === null) {
      return [];
    }
    return new Version(version, undefined);
  });
}

async function fetchUrl(url: string, context: FetchContext): Promise<string> {
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
  context: FetchContext,
): Promise<Version[]> {
  const html = await fetchUrl(spec.url, context);

  await dom.initParser();
  const doc = new dom.DOMParser().parseFromString(html, "text/html");
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
  context: FetchContext,
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
  context: FetchContext,
): Promise<FetchResult> {
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
  context: FetchContext,
): Promise<Version[]> {
  switch (spec.type) {
    case "github_release":
      return await fetchGithubRelease(spec, context);
    case "github_tag":
      return await fetchGithubTag(spec, context);
    case "html":
      return await fetchHtml(spec, context);
    case "helm":
      return await fetchHelm(spec, context);
    default:
      assertNever();
  }
}
