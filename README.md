# versioncheck

versioncheck helps with checking if version numbers in files spread out across
multiple repositories are out-of-date. This is primarily useful for gitops
workflows where versions of docker images, helm charts, etc are committed to a
repository.

versioncheck requires a configuration file that defines where to fetch versions
from and what files contain the version numbers to check against. A github token
must then be provided to fetch the files from github. Alternatively, a path
mapping file can map github URLs to a local checkout of the repository.

## Usage

The basic thing to do is check versions which can be done via:

```
versioncheck check
```

By default, upstream versions are cached. To force versions to be re-fetched,
run

```
versioncheck check --update
```

`--outdated` can also be passed to only show outdated versions.

It's also possible to list available upstream versions via

```
versioncheck versions <name> [version-spec]
```


## Configuration

A configuration file is a YAML file that looks like

```
ingress-nginx:
  upstream:
    type: helm
    repo: https://kubernetes.github.io/ingress-nginx
    chart: ingress-nginx
    versionSpec: 1.3.x
  usages:
    production:
      type: file
      source: https://github.com/org/repo/blob/HEAD/argocd/ingress-ops.yaml
      parser:
        type: yaml
        query: "spec.source.targetRevision"
```

The configuration file contains a mapping of names to the version specification
which is `upstream` and `usages`.

### `upstream`

`upstream` indicates how to fetch versions from upstream. `type` indicates what
fetcher to use. Each fetcher has its own specific configuration.

`versionSpec` specifies the version pattern to use for determining if a version
is outdated. For example, if upstream has maintained 2.x and 1.x lines, but
we're not ready to update to 2.x, we can restrict it to 1.x so that we can check
against that instead of being perpetually out-of-date against 2.x.

`prerelease` indicates whether or not to include prereleases in the list of
versions.

#### Github release / tag

```
traefik:
  upstream:
    type: github_release
    owner: traefik
    repo: traefik
    versionSpec: "2.6.x"
```

Fetching versions from github can be configured with either `type:
github_release` or `type: github_tag` depending on the project. Both of them
take the same options.

`owner` and `repo` indicate which github repository to fetch from. `regexp`
allows extracting part of the release / tag name in case there's additional
text.

#### Github commit

```
secret-project:
  upstream:
    type: github_commit
    owner: org
    repo: secret-project
    private: true
```

`type: github_commit` allows fetching the commit hash for the specified ref.
Unlike other fetchers, this only returns one version. This is mostly useful for
dependencies that are pinned by hash and don't have actual versions.

`owner` and `repo` indicate which github repository to fetch from. `ref` takes a
ref like `HEAD` or a branch / tag name. `private` is optional and indicates that
the repository is private. When fetching a private repository and no github
tokens are provided, the fetcher falls back to `git ls-remote` via SSH.

#### Helm

```
ingress-nginx:
  upstream:
    type: helm
    repo: https://kubernetes.github.io/ingress-nginx
    chart: ingress-nginx
```

`type: helm` allows fetching from helm repositories. In addition to the "main"
version, this also fetches the "app" version for display but all checking is
done against the "main" chart version.

`repo` is the url you would use with `helm repo add` and `chart` is the chart
name.

#### HTML

```
jenkins:
  upstream:
    type: html
    url: https://www.jenkins.io/changelog-stable/rss.xml
    selector: channel item title
    regexp: "Jenkins (.*)"
```

`type: html` allows fetching a single HTML / XML page and parsing out a list of
versions from it.

`url` indicates the URL of the HTML page. `selector` takes a CSS selector for
elements to consider. Finally `regexp` allows parsing the `textContent` of the
retrieved elements and getting the versions out.

### `usages`

`usages` is a map of names to usage specifications. Currently, only `type: file`
is supported.

`source` is a path to a local file when used within a single repository. When
working with multiple repositories, it should be the URL to the file on GitHub
(not the raw URL). If tokens are provided, these are fetched HTTP. Otherwise,
the files are retrieved locally according to the provided path mapping.

`parser` indicates how to get the used version out of the file. `type: regexp`
extracts the version via the provided `regexp`.

`type: yaml` parses the file as YAML (or JSON). `query` is a JMESPath expression
to get from the parsed data. Optionally, `regexp` can be provided to get the
actual version out.

## Path Mapping

The path mapping is used to map github urls to local paths. The file is a YAML
file with `alias` and `github`. Like so:

```
alias:
  ~org: /data/repos/org
  ~sister-org: /data/repos/sister-org

github:
  org/repo: ~org/repo
  org/secret-project: ~org/secret-repos/project
  sister-org/config: ~sister-org/config
```

`alias` allows mapping a `~name` to a local path that will be used in the rest
of the configuration. In the above example, any instance of `~org` will be
replaced by `/data/repos/org`.

`github` maps github repository names to the path of a local checkout. In the
above example, the `org/repo` repository is found at `~org/repo` which will be
expanded to `/data/repos/org/repo`. `org/secret-project` would be ultimately
resolved to `/data/repos/secret-repos/project` and `sister-org/config` resolves
to `/data/repos/sister-org/config`.
