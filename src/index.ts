import {
  bold,
  green,
  red,
  yellow,
} from "https://deno.land/std@0.119.0/fmt/colors.ts";
import { Command } from "https://deno.land/x/cliffy@v0.20.1/command/mod.ts";
import { Row, Table } from "https://deno.land/x/cliffy@v0.20.1/table/mod.ts";
import { ConfigSchema, loadYaml, PathsSchema } from "./config.ts";
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

const { options } = await new Command<{
  update: boolean;
  config: string;
  paths: string;
}>()
  .name("versioncheck")
  .option("-u --update [update:boolean]", "Fetch new upstream versions", {
    default: false,
  })
  .option("-c --config [config:string]", "Path to config file", {
    default: "config.yaml",
  })
  .option("-p --paths [paths:string]", "Path to paths mapping file", {
    default: "paths.yaml",
  })
  .parse(Deno.args);

const config = await loadYaml(options.config, ConfigSchema);
const paths = await loadYaml(options.paths, PathsSchema);
const cache = new Cache();
const context = { paths, cache, update: options.update };
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
