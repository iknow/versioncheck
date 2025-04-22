import { dom, YAML, z } from "./deps.ts";
import { Cache } from "./cache.ts";
import { applyRegexp, makeVersion, Version } from "./version.ts";

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

const GithubCommitFetchSchema = BaseFetchSchema.extend({
  type: z.literal("github_commit"),
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  private: z.boolean().default(false),
});

const GithubCommitResponseSchema = z.object({
  sha: z.string(),
});

type GithubCommitFetch = z.infer<typeof GithubCommitFetchSchema>;

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

const NixpkgsFetchSchema = BaseFetchSchema.extend({
  type: z.literal("nixpkgs"),
});

type NixpkgsFetch = z.infer<typeof NixpkgsFetchSchema>;

export const FetchSchema = z.union([
  GithubReleaseFetchSchema,
  GithubTagFetchSchema,
  GithubCommitFetchSchema,
  HtmlFetchSchema,
  HelmFetchSchema,
  NixpkgsFetchSchema,
]);

export type Fetch = z.infer<typeof FetchSchema>;

export interface FetchContext {
  cache: Cache;
  update: boolean;
  tokens?: Record<string, string>;
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
    tokenForOwner(context, spec.owner),
  );
  const json = JSON.parse(body);
  const parsed = GithubReleaseResponseSchema.parse(json);

  return parsed.flatMap(({ tag_name, prerelease }) => {
    const version = applyRegexp(tag_name, spec.regexp);
    if (version === null) {
      return [];
    }
    return makeVersion(version, undefined, prerelease);
  });
}

async function fetchGithubTag(
  spec: GithubTagFetch,
  context: FetchContext,
): Promise<Version[]> {
  const body = await fetchUrl(
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/tags`,
    context,
    tokenForOwner(context, spec.owner),
  );
  const json = JSON.parse(body);
  const parsed = GithubTagResponseSchema.parse(json);

  return parsed.flatMap(({ name }) => {
    const version = applyRegexp(name, spec.regexp);
    if (version === null) {
      return [];
    }
    return makeVersion(version);
  });
}

async function fetchGithubCommit(
  spec: GithubCommitFetch,
  context: FetchContext,
): Promise<Version[]> {
  const url =
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${spec.ref}`;
  let body = undefined as string | undefined;
  if (!context.update) {
    const cached = context.cache.getBody(url);
    if (cached) {
      body = cached;
    }
  }

  if (body === undefined) {
    if (spec.private && !context.tokens) {
      // if no tokens and the repo is private, fallback to git ls-remote
      const p = Deno.run({
        cmd: [
          "git",
          "ls-remote",
          `git@github.com:${spec.owner}/${spec.repo}`,
          spec.ref ?? "HEAD",
        ],
        stdout: "piped",
      });

      const [{ code }, output] = await Promise.all([p.status(), p.output()]);
      if (code !== 0) {
        throw new Error(`Failed to get commit for ${spec.owner}/${spec.repo}`);
      }
      const sha = new TextDecoder().decode(output).substring(0, 40);
      body = JSON.stringify({ sha });
      context.cache.saveBody(url, body);
    } else {
      body = await fetchUrl(
        `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${spec.ref}`,
        context,
        tokenForOwner(context, spec.owner),
      );
    }
  }

  const json = JSON.parse(body);
  const parsed = GithubCommitResponseSchema.parse(json);
  return [makeVersion(parsed.sha)];
}

function tokenForOwner(
  context: FetchContext,
  owner: string,
): string | undefined {
  if (!context.tokens) {
    return undefined;
  }
  return context.tokens[owner] ?? context.tokens.default;
}

async function fetchUrl(
  url: string,
  context: FetchContext,
  token?: string,
  options = {},
  transformer?: (response: Response) => Promise<string>,
): Promise<string> {
  let body = undefined as string | undefined;
  if (!context.update) {
    const cached = context.cache.getBody(url);
    if (cached) {
      body = cached;
    }
  }

  if (body === undefined) {
    const response = await fetch(url, {
      headers: token
        ? {
          Authorization: `Bearer ${token}`,
        }
        : {},
      ...options,
    });
    if (transformer) {
      body = await transformer(response);
    } else {
      if (response.status !== 200) {
        throw new Error(
          `Got status ${response.status}: ${await response.text()}`,
        );
      }
      body = await response.text();
    }
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
    versions.push(makeVersion(version));
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
      return makeVersion(entry.version, entry.appVersion);
    } else {
      return makeVersion(entry.version);
    }
  });
}

async function fetchNixpkgs(
  _spec: NixpkgsFetch,
  context: FetchContext,
): Promise<Version[]> {
  const cacheKey = "nix-channel:nixpkgs-unstable";
  let versions: string[] | undefined = undefined;
  if (!context.update) {
    const cached = context.cache.getBody(cacheKey);
    if (cached) {
      versions = JSON.parse(cached);
    }
  }

  if (versions === undefined) {
    await dom.initParser();
    versions = [];

    let continuationToken: string | null = null;
    do {
      const url = new URL("https://nix-releases.s3.amazonaws.com");
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", "nixpkgs/nixpkgs-");
      url.searchParams.set("delimiter", "/");
      if (continuationToken !== null) {
        url.searchParams.set("continuation-token", continuationToken);
      }

      const response = await fetch(url);
      if (response.status !== 200) {
        throw new Error(
          `Got status ${response.status}: ${await response.text()}`,
        );
      }

      const rawText = await response.text();
      const doc = new dom.DOMParser().parseFromString(rawText, "text/html");
      if (doc === null) {
        throw new Error(`Could not parse S3 response: ${rawText}`);
      }

      const keys = doc.querySelectorAll("Key");
      for (const key of keys) {
        // strip nixpkgs/ prefix
        const keyText = key.textContent.substring(8);
        versions.push(keyText);
      }

      continuationToken =
        doc.querySelector("NextContinuationToken")?.textContent ?? null;
    } while (continuationToken !== null);

    context.cache.saveBody(cacheKey, JSON.stringify(versions));
  }

  return versions.map((version) => makeVersion(version));
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
    throw new Error(`No versions found for ${stringifySpec(spec)}`);
  }

  const validVersions = spec.prerelease
    ? versions
    : versions.filter(({ prerelease }) => {
      return !prerelease;
    });

  if (validVersions.length === 0) {
    throw new Error(`No valid versions for ${stringifySpec(spec)}`);
  }

  validVersions.sort((a, b) => {
    return -a.compare(b);
  });

  const latest = validVersions[0];
  const version = spec.versionSpec
    ? validVersions.find((version) => version.satisfies(spec.versionSpec!))
    : latest;

  if (version === undefined) {
    throw new Error(`No compatible version ${stringifySpec(spec)}`);
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
    case "github_commit":
      return await fetchGithubCommit(spec, context);
    case "html":
      return await fetchHtml(spec, context);
    case "helm":
      return await fetchHelm(spec, context);
    case "nixpkgs":
      return await fetchNixpkgs(spec, context);
    default:
      assertNever();
  }
}

function getSpecName(spec: Fetch): string {
  switch (spec.type) {
    case "github_release":
    case "github_tag":
    case "github_commit":
      return `gh:${spec.owner}/${spec.repo}`;
    case "html":
      return `${spec.url} ${spec.selector}`;
    case "helm":
      return `helm:${spec.chart}/${spec.repo}`;
    case "nixpkgs":
      return "nixpkgs";
    default:
      assertNever();
  }
}

function stringifySpec(spec: Fetch): string {
  let text = getSpecName(spec);
  if (spec.versionSpec) {
    text += ` (${spec.versionSpec})`;
  }
  return text;
}
