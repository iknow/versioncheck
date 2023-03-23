import { cliffy, cliffyTable, colors, semver } from "./deps.ts";
import { Config, ConfigSchema, loadYaml, PathsSchema } from "./config.ts";
import { Fetch, FetchContext, FetchResult, fetchVersion } from "./fetchers.ts";
import { Cache } from "./cache.ts";
import {
  getUsage,
  normalizePaths,
  normalizeSource,
  Usage,
  UsageContext,
} from "./usage.ts";
import { Version } from "./version.ts";

interface CheckResult {
  name: string;
  upstream: FetchResult | null;
  outdated: Record<string, Version>;
  errored: string[];
}

async function checkVersion(
  name: string,
  upstream: Fetch,
  usages: Record<string, Usage>,
  fetchContext: FetchContext,
  usageContext: UsageContext,
): Promise<CheckResult> {
  const promises = [
    fetchVersion(upstream, fetchContext),
    ...Object.values(usages).map((spec) => getUsage(spec, usageContext)),
  ] as const;
  const keys = Object.keys(usages);

  const [upstreamResult, ...restResult] = await Promise.allSettled(promises);
  const upstreamVersion = upstreamResult.status === "fulfilled"
    ? upstreamResult.value
    : null;
  if (upstreamResult.status === "rejected") {
    console.error(upstreamResult.reason);
  }

  const rest: [string, Version][] = [];
  const errored: string[] = [];
  restResult.forEach((result, index) => {
    const key = keys[index];
    if (result.status === "fulfilled") {
      rest.push([key, result.value]);
    } else {
      console.error(result.reason);
      errored.push(key);
    }
  });

  const outdated: Record<string, Version> = {};
  if (upstreamVersion !== null) {
    for (const [key, version] of rest) {
      if (version.main !== upstreamVersion.version.main) {
        if (upstreamVersion.versions !== undefined) {
          const fullVersion = upstreamVersion.versions.find(({ main }) => {
            return main === version.main;
          });
          outdated[key] = fullVersion ?? version;
        } else {
          outdated[key] = version;
        }
      }
    }
  }

  return {
    name,
    upstream: upstreamVersion,
    outdated,
    errored,
  };
}

function versionToString(value: Version, color: (s: string) => string): string {
  return color(value.main) + (value.app ? ` [${value.app}]` : "");
}

function filterObject<T>(
  o: Record<string, T>,
  fn: (value: T, key: string) => boolean,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(o)) {
    if (fn(value, key)) {
      result[key] = value;
    }
  }
  return result;
}

function mapObject<A, B>(
  o: Record<string, A>,
  fn: (a: A) => B,
): Record<string, B> {
  const result: Record<string, B> = {};
  for (const [key, value] of Object.entries(o)) {
    result[key] = fn(value);
  }
  return result;
}

interface GlobalOptions {
  update?: boolean;
  config: string;
  paths?: string;
  token?: string;
}

async function getConfig(options: GlobalOptions): Promise<Config> {
  return await loadYaml(options.config, ConfigSchema);
}

function getFetchContext(options: GlobalOptions): FetchContext {
  const cache = new Cache();
  if (options.update) {
    console.log("Fetching upstream...");
  }
  return {
    cache,
    update: options.update ?? false,
    tokens: options.token ? parseTokens(options.token) : undefined,
  };
}

function parseTokens(token: string) {
  return Object.fromEntries(
    token
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .map((t) => {
        const split = t.split(":");
        if (split.length === 2) {
          return split;
        } else {
          return ["default", t];
        }
      }),
  );
}

async function getUsageContext(options: GlobalOptions): Promise<UsageContext> {
  const paths = options.paths
    ? await loadYaml(options.paths, PathsSchema)
    : undefined;

  return {
    paths,
    tokens: options.token ? parseTokens(options.token) : undefined,
  };
}

interface CheckOptions {
  outdated?: boolean;
  usage?: string;
}

async function checkVersions(options: GlobalOptions & CheckOptions) {
  let config = await getConfig(options);
  const fetchContext = getFetchContext(options);
  const usageContext = await getUsageContext(options);

  const usageFilter = options.usage;
  if (usageFilter) {
    config = mapObject(config, ({ usages, ...rest }) => {
      return {
        ...rest,
        usages: filterObject(usages, (_, key) => key === usageFilter),
      };
    });
    config = filterObject(
      config,
      ({ usages }) => Object.entries(usages).length > 0,
    );
  }

  let checks = await Promise.all(
    Object.entries(config).map(([key, value]) =>
      checkVersion(
        key,
        value.upstream,
        value.usages,
        fetchContext,
        usageContext,
      )
    ),
  );

  if (options.outdated) {
    checks = checks.filter(({ outdated }) =>
      Object.entries(outdated).length > 0
    );
  }

  new cliffyTable.Table()
    .border(true)
    .header(
      cliffyTable.Row.from(["Name", "Upstream", "Status"].map(colors.bold)),
    )
    .body(checks.map(({ name, upstream, outdated, errored }) => {
      if (upstream === null) {
        return [name, colors.red("error")];
      } else {
        const statusEntries = Object.entries(outdated).map(([key, value]) => {
          return [key, versionToString(value, colors.yellow)];
        })
          .concat(errored.map((key) => {
            return [key, colors.red("error")];
          }));

        const status = statusEntries.length === 0
          ? colors.green("up-to-date")
          : cliffyTable.Table.from(statusEntries).toString();

        const upstreamVersion = (upstream.latest === undefined ||
            upstream.version.main === upstream.latest.main)
          ? versionToString(upstream.version, colors.green)
          : `${versionToString(upstream.version, colors.yellow)}\n${
            versionToString(upstream.latest, colors.green)
          } (latest)`;

        return [name, upstreamVersion, status];
      }
    }))
    .render();
}

async function listVersions(
  options: GlobalOptions,
  name: string,
  versionSpec?: string,
) {
  const config = await getConfig(options);
  const context = getFetchContext(options);

  const application = config[name];
  if (application === undefined) {
    throw new Error(`${name} not found in config`);
  }

  let { versions } = await fetchVersion(application.upstream, context);
  if (versions === undefined) {
    throw new Error(`Could not find versions for ${name}`);
  }

  if (versionSpec) {
    versions = versions.filter((v) => semver.satisfies(v.main, versionSpec));
  }

  for (const v of versions) {
    console.log(versionToString(v, colors.yellow));
  }
}

async function getPath(
  options: GlobalOptions,
  name: string,
  usage: string,
) {
  const config = await getConfig(options);
  const context = await getUsageContext(options);

  const application = config[name];
  if (application === undefined) {
    throw new Error(`${name} not found in config`);
  }

  const usageSpec = application.usages[usage];
  if (usageSpec === undefined) {
    throw new Error(`${name}/${usage} not found in config`);
  }
  if (usageSpec.type !== "file") {
    throw new Error(`Cannot get path for non-file source ${name}/${usage}`);
  }

  if (!context.paths) {
    throw new Error("--paths must be specified to get the local path");
  }

  const source = normalizeSource(usageSpec.source);
  const path = normalizePaths(source, context.paths);
  console.log(path);
}

const cmd = new cliffy.Command<void>()
  .name("versioncheck")
  .env("VERSIONCHECK_CONFIG=<value:string>", "Path to config file", {
    prefix: "VERSIONCHECK_",
    global: true,
  })
  .env("VERSIONCHECK_PATHS=<value:string>", "Path to paths mapping file", {
    prefix: "VERSIONCHECK_",
    global: true,
  })
  .env("GITHUB_TOKEN=<value:string>", "GitHub token for fetching files", {
    prefix: "GITHUB_",
    global: true,
  })
  .option("-u, --update", "Fetch new upstream versions", {
    global: true,
  })
  .option(
    "-c, --config <value:string>",
    "Path to config file",
    {
      default: "config.yaml",
      global: true,
    },
  )
  .option(
    "-p, --paths <value:string>",
    "Path to paths mapping file",
    {
      global: true,
    },
  )
  .option(
    "-t, --token <value:string>",
    "GitHub token for fetching files",
    {
      global: true,
    },
  )
  .command("check")
  .description("Check versions")
  .option(
    "--outdated",
    "Only list outdated applications",
  )
  .option(
    "--usage <usage:string>",
    "List only the specified usage",
  )
  .action(checkVersions)
  .reset()
  .command("versions <name> [version-spec]")
  .description("List available versions")
  .action(listVersions)
  .reset()
  .command("path <name> <usage>")
  .description("Get local path for source")
  .action(getPath)
  .reset();

await cmd
  .action(() => cmd.showHelp())
  .parse(Deno.args);
