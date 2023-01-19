import { semver } from "./deps.ts";

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

export function applyRegexp(
  raw: string,
  regexp: string | undefined,
): string | null {
  return applyRegexpRaw(raw, regexp, () => {
    return null;
  });
}

export function requireRegexp(raw: string, regexp: string | undefined): string {
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
