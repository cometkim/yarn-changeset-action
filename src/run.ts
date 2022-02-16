import { exec } from "@actions/exec";
import * as github from "@actions/github";
import fs from "fs-extra";
import { getPackages, Package } from "@manypkg/get-packages";
import path from "path";
import * as semver from "semver";
import {
  getChangelogEntry,
  execWithOutput,
  getChangedPackages,
  sortTheThings,
  getVersionsByDirectory,
} from "./utils";
import * as gitUtils from "./gitUtils";
import readChangesetState from "./readChangesetState";
import resolveFrom from "resolve-from";

const createRelease = async (
  octokit: ReturnType<typeof github.getOctokit>,
  { pkg, tagName }: { pkg: Package; tagName: string }
) => {
  try {
    let changelogFileName = path.join(pkg.dir, "CHANGELOG.md");

    let changelog = await fs.readFile(changelogFileName, "utf8");

    let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
    if (!changelogEntry) {
      // we can find a changelog but not the entry for this version
      // if this is true, something has probably gone wrong
      throw new Error(
        `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
      );
    }

    await octokit.repos.createRelease({
      name: tagName,
      tag_name: tagName,
      body: changelogEntry.content,
      prerelease: pkg.packageJson.version.includes("-"),
      ...github.context.repo,
    });
  } catch (err) {
    // if we can't find a changelog, the user has probably disabled changelogs
    if ((err as any)?.code !== "ENOENT") {
      throw err;
    }
  }
};

type PublishOptions = {
  npmToken: string;
  githubToken: string;
  createGithubReleases: boolean;
  cwd?: string;
};

type PublishedPackage = { name: string; version: string };

type PublishResult =
  | {
      published: true;
      publishedPackages: PublishedPackage[];
    }
  | {
      published: false;
    };

export async function runPublish({
  npmToken,
  githubToken,
  createGithubReleases,
  cwd = process.cwd(),
}: PublishOptions): Promise<PublishResult> {
  let octokit = github.getOctokit(githubToken);

  await exec(
    "yarn",
    [
      "config",
      "set",
      "npmAuthToken",
      npmToken,
    ],
    { cwd },
  );

  let changesetPublishOutput = await execWithOutput(
    "yarn",
    [
      "workspaces",
      "foreach",
      "-iv",
      "--topological-dev",
      "--no-private",
      "npm",
      "publish",
      "--tolerate-republish",
    ],
    { cwd },
  );


  let { tool } = await getPackages(cwd);

  if (tool !== "yarn") {
    throw new Error("Only Yarn is supported");
  }

  let publishedPattern = /\[(?<packageName>.+)\]:.*Package archive published/;
  let publishedPackages: Package[] = [];

  let lines = changesetPublishOutput.stdout.split("\n");
  for (let line of lines) {
    let packageName = line.match(publishedPattern)?.groups?.['packageName'];
    if (packageName) {
      let pkg = require(packageName + '/package.json');
      publishedPackages.push(pkg);
    }
  }

  if (createGithubReleases) {
    await Promise.all(
      publishedPackages.map((pkg) =>
        createRelease(octokit, {
          pkg,
          tagName: `${pkg.packageJson.name}@${pkg.packageJson.version}`,
        })
      )
    );
  }

  if (publishedPackages.length) {
    return {
      published: true,
      publishedPackages: publishedPackages.map((pkg) => ({
        name: pkg.packageJson.name,
        version: pkg.packageJson.version,
      })),
    };
  }

  return { published: false };
}

const requireChangesetsCliPkgJson = (cwd: string) => {
  try {
    return require(resolveFrom(cwd, "@changesets/cli/package.json"));
  } catch (err) {
    console.error(err);
    if ((err as any)?.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`
      );
    }
    throw err;
  }
};

type VersionOptions = {
  githubToken: string;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  autoPublish?: boolean;
  dedupe?: boolean;
};

export async function runVersion({
  githubToken,
  cwd = process.cwd(),
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  autoPublish = false,
  dedupe = false,
}: VersionOptions) {
  let repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  let branch = github.context.ref.replace("refs/heads/", "");
  let versionBranch = `changeset-release/${branch}`;
  let octokit = github.getOctokit(githubToken);
  let { preState } = await readChangesetState(cwd);

  await gitUtils.switchToMaybeExistingBranch(versionBranch);
  await gitUtils.reset(github.context.sha);

  let versionsByDirectory = await getVersionsByDirectory(cwd);

  let changesetsCliPkgJson = requireChangesetsCliPkgJson(cwd);
    let cmd = semver.lt(changesetsCliPkgJson.version, "2.0.0")
      ? "bump"
      : "version";
  await exec("yarn", ["changeset", cmd], { cwd });

  // update lock file
  await exec("yarn", [
    "install",
    "--mode=update-lockfile",
    "--no-immutable",
  ], { cwd });

  if (dedupe) {
    await exec("yarn", ["dedupe"], { cwd });
  }

  let searchQuery = `repo:${repo}+state:open+head:${versionBranch}+base:${branch}`;
  let searchResultPromise = octokit.search.issuesAndPullRequests({
    q: searchQuery,
  });
  let changedPackages = await getChangedPackages(cwd, versionsByDirectory);

  let prBodyPromise = (async () => {
    return (
      `This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and ${
        autoPublish 
          ? `the packages will be published to npm automatically`
          : `publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)`
      }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
${
  !!preState
    ? `
⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`changeset pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : ""
}
# Releases
` +
      (
        await Promise.all(
          changedPackages.map(async (pkg) => {
            let changelogContents = await fs.readFile(
              path.join(pkg.dir, "CHANGELOG.md"),
              "utf8"
            );

            let entry = getChangelogEntry(
              changelogContents,
              pkg.packageJson.version
            );
            return {
              highestLevel: entry.highestLevel,
              private: !!pkg.packageJson.private,
              content:
                `## ${pkg.packageJson.name}@${pkg.packageJson.version}\n\n` +
                entry.content,
            };
          })
        )
      )
        .filter((x) => x)
        .sort(sortTheThings)
        .map((x) => x.content)
        .join("\n ")
    );
  })();

  const finalPrTitle = `${prTitle}${!!preState ? ` (${preState.tag})` : ""}`;

  // project with `commit: true` setting could have already committed files
  if (!(await gitUtils.checkIfClean())) {
    const finalCommitMessage = `${commitMessage}${
      !!preState ? ` (${preState.tag})` : ""
    }`;
    await gitUtils.commitAll(finalCommitMessage);
  }

  await gitUtils.push(versionBranch, { force: true });

  let searchResult = await searchResultPromise;
  console.log(JSON.stringify(searchResult.data, null, 2));
  if (searchResult.data.items.length === 0) {
    console.log("creating pull request");
    await octokit.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: await prBodyPromise,
      ...github.context.repo,
    });
  } else {
    octokit.pulls.update({
      pull_number: searchResult.data.items[0].number,
      title: finalPrTitle,
      body: await prBodyPromise,
      ...github.context.repo,
    });
    console.log("pull request found");
  }
}
