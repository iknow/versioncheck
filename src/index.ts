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
import { Context, Fetch, fetchVersion, Version, VersionResult } from "./fetchers.ts";
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
  return color(value.main) + (value.app ? ` [${value.app}]` : '');
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

async function checkVersions(options: GlobalOptions) {
  const config = await getConfig(options);
  const context = await getContext(options);

  const checks = await Promise.all(
    Object.entries(config).map(([key, value]) =>
      checkVersion(key, value.upstream, value.usages, context)
    ),
  );

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

        const upstreamVersion =
          (upstream.latest === undefined || upstream.version.main === upstream.latest.main)
            ? versionToString(upstream.version, green)
            : `${versionToString(upstream.version, yellow)} (latest: ${versionToString(upstream.latest, green)})`;

        return [name, upstreamVersion, status];
      }
    }))
    .render();
}

async function listVersions(options: GlobalOptions, name: string, versionSpec?: string) {
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
    versions = versions.filter(v => semver.satisfies(v.main, versionSpec));
  }

  for (const v of versions) {
    console.log(versionToString(v, yellow));
  }
}

await new Command<void>()
  .name("versioncheck")
  .option<{ update?: boolean }>("-u --update", "Fetch new upstream versions", {
    global: true,
  })
  .option<{ config: string }>("-c --config [value:string]", "Path to config file", {
    default: "config.yaml",
    global: true,
  })
  .option<{ paths: string }>("-p --paths [value:string]", "Path to paths mapping file", {
    default: "paths.yaml",
    global: true,
  })
  .command("check")
  .description("Check versions")
  .action(checkVersions)
  .reset()
  .command<[string, string | undefined]>("versions <name> [version-spec]")
  .description("List available versions")
  .action(listVersions)
  .reset()
  .parse(Deno.args);

