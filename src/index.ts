import {
  bold,
  green,
  red,
  yellow,
} from "https://deno.land/std@0.119.0/fmt/colors.ts";
import { Command } from "https://deno.land/x/cliffy@v0.20.1/command/mod.ts";
import { Row, Table } from "https://deno.land/x/cliffy@v0.20.1/table/mod.ts";
import * as semver from "https://deno.land/x/semver@v1.4.0/mod.ts";
import { Config, ConfigSchema, loadYaml, PathsSchema } from "./config.ts";
import {
  Context,
  Fetch,
  fetchVersion,
  normalizePaths,
  Version,
  VersionResult,
} from "./fetchers.ts";
import { Cache } from "./cache.ts";

interface CheckResult {
  name: string;
  upstream: VersionResult | null;
  outdated: Record<string, VersionResult>;
  errored: string[];
}

async function checkVersion(
  name: string,
  upstream: Fetch,
  usages: Record<string, Fetch>,
  context: Context,
): Promise<CheckResult> {
  const promises = [upstream, ...Object.values(usages)].map((spec) =>
    fetchVersion(spec, context)
  );
  const keys = Object.keys(usages);

  const [upstreamResult, ...restResult] = await Promise.allSettled(promises);
  const upstreamVersion = upstreamResult.status === "fulfilled"
    ? upstreamResult.value
    : null;
  if (upstreamResult.status === "rejected") {
    console.error(upstreamResult.reason);
  }

  const rest: [string, VersionResult][] = [];
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

  const outdated: Record<string, VersionResult> = {};
  if (upstreamVersion !== null) {
    for (const [key, version] of rest) {
      if (version.version.main !== upstreamVersion.version.main) {
        if (upstreamVersion.versions !== undefined) {
          const fullVersion = upstreamVersion.versions.find(({ main }) => {
            return main === version.version.main;
          });
          outdated[key] = fullVersion ? { version: fullVersion } : version;
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

function filterObject<T>(o: Record<string, T>, fn: (value: T, key: string) => boolean): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(o)) {
    if (fn(value, key)) {
      result[key] = value;
    }
  }
  return result;
}

function mapObject<A, B>(o: Record<string, A>, fn: (a: A) => B): Record<string, B> {
  const result: Record<string, B> = {};
  for (const [key, value] of Object.entries(o)) {
    result[key] = fn(value);
  }
  return result;
}

interface GlobalOptions {
  update?: boolean;
  config: string;
  paths: string;
}

async function getConfig(options: GlobalOptions): Promise<Config> {
  return await loadYaml(options.config, ConfigSchema);
}

async function getContext(options: GlobalOptions): Promise<Context> {
  const paths = await loadYaml(options.paths, PathsSchema);
  const cache = new Cache();
  if (options.update) {
    console.log("Fetching upstream...");
  }
  return { paths, cache, update: options.update ?? false };
}

interface CheckOptions {
  outdated?: boolean;
  usage?: string;
}

async function checkVersions(options: GlobalOptions & CheckOptions) {
  let config = await getConfig(options);
  const context = await getContext(options);

  const usageFilter = options.usage;
  if (usageFilter) {
    config = mapObject(config, (({ usages, ...rest }) => {
      return { ...rest, usages: filterObject(usages, (_, key) => key === usageFilter) };
    }));
    config = filterObject(config, (({ usages }) => Object.entries(usages).length > 0));
  }

  let checks = await Promise.all(
    Object.entries(config).map(([key, value]) =>
      checkVersion(key, value.upstream, value.usages, context)
    ),
  );

  if (options.outdated) {
    checks = checks.filter(({ outdated }) =>
      Object.entries(outdated).length > 0
    );
  }

  new Table()
    .border(true)
    .header(Row.from(["Name", "Upstream", "Status"].map(bold)))
    .body(checks.map(({ name, upstream, outdated, errored }) => {
      if (upstream === null) {
        return [name, red("error")];
      } else {
        const statusEntries = Object.entries(outdated).map(([key, value]) => {
          return [key, versionToString(value.version, yellow)];
        })
          .concat(errored.map((key) => {
            return [key, red("error")];
          }));

        const status = statusEntries.length === 0
          ? green("up-to-date")
          : Table.from(statusEntries).toString();

        const upstreamVersion = (upstream.latest === undefined ||
            upstream.version.main === upstream.latest.main)
          ? versionToString(upstream.version, green)
          : `${versionToString(upstream.version, yellow)}\n${
            versionToString(upstream.latest, green)
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
  const context = await getContext(options);

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
    console.log(versionToString(v, yellow));
  }
}

async function getPath(
  options: GlobalOptions,
  name: string,
  usage: string,
) {
  const config = await getConfig(options);
  const context = await getContext(options);

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

  const path = normalizePaths(usageSpec.source, context.paths);
  console.log(path);
}

const cmd = new Command<void>()
  .name("versioncheck")
  .option<{ update?: boolean }>("-u --update", "Fetch new upstream versions", {
    global: true,
  })
  // env is handled as defaults as cliffy doesn't support restricted env yet
  .option<{ config: string }>(
    "-c --config [value:string]",
    "Path to config file",
    {
      default: Deno.env.get("VERSIONCHECK_CONFIG") ?? "config.yaml",
      global: true,
    },
  )
  .option<{ paths: string }>(
    "-p --paths [value:string]",
    "Path to paths mapping file",
    {
      default: Deno.env.get("VERSIONCHECK_PATHS") ?? "paths.yaml",
      global: true,
    },
  )
  .command("check")
  .description("Check versions")
  .option<{ outdated?: boolean }>(
    "--outdated",
    "Only list outdated applications",
  )
  .option<{ usage?: string }>(
    "--usage <usage:string>",
    "List only the specified usage",
  )
  .action(checkVersions)
  .reset()
  .command<[string, string | undefined]>("versions <name> [version-spec]")
  .description("List available versions")
  .action(listVersions)
  .reset()
  .command<[string, string]>("path <name> <usage>")
  .description("Get local path for source")
  .action(getPath)
  .reset();

await cmd
  .action(() => cmd.showHelp())
  .parse(Deno.args);
