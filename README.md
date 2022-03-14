# Changesets Release Action

This is fork for **Yarn 2+ (only)** support

Solving problems of original action:
- It doesn't update lockfile on version bumping
- It doesn't handle [workspace protocol](https://yarnpkg.com/features/protocols/#workspace) on publishing

----

This action for [Changesets](https://github.com/atlassian/changesets) creates a pull request with all of the package versions updated and changelogs updated and when there are new changesets on [your configured `baseBranch`](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md#basebranch-git-branch-name), the PR will be updated. When you're ready, you can merge the pull request and you can either publish the packages to npm manually or setup the action to do it for you.

## Usage

### Inputs

- `autoPublish` - The flag to enable auto-publishing packages. Default to `false`
- `dedupe` - The flag to enable auto-deduplication of dependencies. Default to `false`
- `commit` - The commit message to use. Default to `Version Packages`
- `title` - The pull request title. Default to `Version Packages`
- `setupGitUser` - Sets up the git user for commits as `"github-actions[bot]"`. Default to `true`
- `cwd` - Changes node's `process.cwd()` if the project is not located on the root. Default to `process.cwd()`

### Outputs

- `published` - A boolean value to indicate whether a publishing is happened or not
- `publishedPackages` - A JSON array to present the published packages. The format is `[{"name": "@xx/xx", "version": "1.2.0"}, {"name": "@xx/xy", "version": "0.8.9"}]`

### Example workflow:

#### Without Publishing

Create a file at `.github/workflows/release.yml` with the following content.

```yml
name: Release

on:
  push:
    branches:
      - main

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v2
        with:
          # This makes Actions fetch all Git history so that Changesets can generate changelogs with the correct commits
          fetch-depth: 0

      - name: Setup Node.js 16.x
        uses: actions/setup-node@v2
        with:
          node-version: 16.x

      - name: Install Dependencies
        run: yarn install --immutable

      - name: Create Release Pull Request
        uses: cometkim/yarn-changeset-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### With Publishing

Before you can setup this action with publishing, you'll need to have an [npm token](https://docs.npmjs.com/creating-and-viewing-authentication-tokens) that can publish the packages in the repo you're setting up the action for and doesn't have 2FA on publish enabled ([2FA on auth can be enabled](https://docs.npmjs.com/about-two-factor-authentication)). You'll also need to [add it as a secret on your GitHub repo](https://help.github.com/en/articles/virtual-environments-for-github-actions#creating-and-using-secrets-encrypted-variables) with the name `NPM_TOKEN`. Once you've done that, you can create a file at `.github/workflows/release.yml` with the following content.

```yml
name: Release

on:
  push:
    branches:
      - main

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v2
        with:
          # This makes Actions fetch all Git history so that Changesets can generate changelogs with the correct commits
          fetch-depth: 0

      - name: Setup Node.js 16.x
        uses: actions/setup-node@v2
        with:
          node-version: 16.x

      - name: Install Dependencies
        run: yarn install --immutable

      - name: Create Release Pull Request or Publish to npm
        id: changesets
        uses: cometkim/yarn-changeset-action@v1
        with:
          autoPublish: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Send a Slack notification if a publish happens
        if: steps.changesets.outputs.published == 'true'
        # You can do something when a publish happens.
        run: my-slack-bot send-notification --message "A new version of ${GITHUB_REPOSITORY} was published!"
```

#### Custom Publishing

If you want to hook into when publishing should occur but have your own publishing functionality you can utilize the `hasChangesets` output.

Note that you might need to account for things already being published in your script because a commit without any new changesets can always land on your base branch after a successful publish. In such a case you need to figure out on your own how to skip over the actual publishing logic or handle errors gracefully as most package registries won't allow you to publish over already published version.

```yml
name: Release
on:
  push:
    branches:
      - main
jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v2
        with:
          # This makes Actions fetch all Git history so that Changesets can generate changelogs with the correct commits
          fetch-depth: 0
      - name: Setup Node.js 12.x
        uses: actions/setup-node@v2
        with:
          node-version: 12.x
      - name: Install Dependencies
        run: yarn
      - name: Create Release Pull Request or Publish to npm
        id: changesets
        uses: cometkim/yarn-changeset-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Publish
        if: steps.changesets.outputs.hasChangesets == 'false'
        # You can do something when a publish should happen.
        run: yarn publish
```
