import { semver } from "./deps.ts";

export interface Version {
  main: string;
  app?: string;
  prerelease: boolean;

  compare(other: Version): number;
  satisfies(spec: string): boolean;
}

const COMMIT_REGEX = /^[0-9a-f]{40}$/;

export function makeVersion(main: string, app?: string, prerelease?: boolean) {
  if (COMMIT_REGEX.test(main)) {
    return new CommitVersion(main);
  } else {
    return new SemanticVersion(main, app, prerelease);
  }
}

export class CommitVersion implements Version {
  constructor(public readonly main: string) {}

  public get prerelease() {
    return false;
  }

  compare(other: Version): number {
    return this.main.localeCompare(other.main);
  }

  satisfies(spec: string): boolean {
    return this.main === spec;
  }
}

export class SemanticVersion implements Version {
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

  compare(other: Version): number {
    if (other instanceof SemanticVersion) {
      const compare = semver.compare(this.semantic, other.semantic);
      if (compare !== 0) {
        return compare;
      }
    }
    return this.main.localeCompare(other.main);
  }

  satisfies(spec: string): boolean {
    return semver.satisfies(this.semantic, spec);
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
