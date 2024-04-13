import { exec, getExecOutput } from "@actions/exec";
import * as github from "@actions/github";
import fs from "fs-extra";
import { getPackages, type Package } from "@manypkg/get-packages";
import path from "path";
import * as semver from "semver";
import { type PreState } from "@changesets/types";
import {
  getChangelogEntry,
  getChangedPackages,
  sortTheThings,
  getVersionsByDirectory,
  type ChangelogEntry,
} from "./utils";
import * as gitUtils from "./gitUtils";
import readChangesetState from "./readChangesetState";

// GitHub Issues/PRs messages have a max size limit on the
// message body payload.
// `body is too long (maximum is 65536 characters)`.
// To avoid that, we ensure to cap the message to 60k chars.
const MAX_CHARACTERS_PER_MESSAGE = 60000;

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

    await octokit.rest.repos.createRelease({
      name: tagName,
      tag_name: tagName,
      body: changelogEntry.content as string,
      prerelease: pkg.packageJson.version.includes("-"),
      ...github.context.repo,
    });
  } catch (err: any) {
    // if we can't find a changelog, the user has probably disabled changelogs
    if ((err as any)?.code !== "ENOENT") {
      throw err;
    }
  }
};

type PublishOptions = {
  cwd: string;
  npmToken: string;
  githubToken: string;
  createGithubReleases: boolean;
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
  cwd,
  npmToken,
  githubToken,
  createGithubReleases,
}: PublishOptions): Promise<PublishResult> {
  let octokit = github.getOctokit(githubToken);

  let { tool } = await getPackages(cwd);
  if (tool.type !== "yarn" && tool.type !== "root") {
    throw new Error("Only Yarn is supported");
  }

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

  let yarnVersionResult = await getExecOutput("yarn", ["--version"], { cwd });
  if (yarnVersionResult.exitCode !== 0) {
    throw new Error(yarnVersionResult.stderr);
  }

  let changesetPublishResult = await getExecOutput(
    "yarn",
    semver.gte(yarnVersionResult.stdout, "4.0.0")
    ? [
      "workspaces",
      "foreach",
      "--verbose",
      "--worktree",
      "--interlaced",
      "--topological-dev",
      "--no-private",
      "npm",
      "publish",
      "--tolerate-republish",
    ] : [
      "workspaces",
      "foreach",
      "--verbose",
      "--interlaced",
      "--topological-dev",
      "--no-private",
      "npm",
      "publish",
      "--tolerate-republish",
    ],
    { cwd },
  );
  if (changesetPublishResult.exitCode !== 0) {
    throw new Error(changesetPublishResult.stderr);
  }

  let { packages } = await getPackages(cwd);

  let publishedPattern = /\[(?<packageName>[^\[]+)\]:.*Package archive published/;
  let publishedPackages: Package[] = [];

  let lines = changesetPublishResult.stdout.split("\n");
  for (let line of lines) {
    let packageName = line.match(publishedPattern)?.groups?.['packageName'];
    let pkg = packages.find(pkg => pkg.packageJson.name === packageName);
    if (pkg) {
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

type ChangedPackageInfo = ChangelogEntry & {
  private: boolean;
  header: string;
};

type GetMessageOptions = {
  autoPublish: boolean;
  branch: string;
  changedPackagesInfo: ChangedPackageInfo[];
  prBodyMaxCharacters: number;
  preState?: PreState;
};

export async function getVersionPrBody({
  autoPublish,
  preState,
  changedPackagesInfo,
  prBodyMaxCharacters,
  branch,
}: GetMessageOptions) {
  let messageHeader = `This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and ${
    autoPublish
      ? `the packages will be published to npm automatically`
      : `publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)`
  }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
`;
  let messagePrestate = !!preState
    ? `⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`changeset pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : "";
  let messageReleasesHeading = `# Releases`;

  let fullMessage = [
    messageHeader,
    messagePrestate,
    messageReleasesHeading,
    ...changedPackagesInfo.map((info) => `${info.header}\n\n${info.content}`),
  ].join("\n");

  // Check that the message does not exceed the size limit.
  // If not, omit the changelog entries of each package.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> The changelog information of each package has been omitted from this message, as the content exceeds the size limit.\n`,
      ...changedPackagesInfo.map((info) => `${info.header}\n\n`),
    ].join("\n");
  }

  // Check (again) that the message is within the size limit.
  // If not, omit all release content this time.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> All release information have been omitted from this message, as the content exceeds the size limit.`,
    ].join("\n");
  }

  return fullMessage;
}

type VersionOptions = {
  cwd: string;
  githubToken: string;
  prTitle?: string;
  commitMessage?: string;
  autoPublish?: boolean;
  dedupe?: boolean;
  prBodyMaxCharacters?: number;
};

type RunVersionResult = {
  pullRequestNumber: number;
};

export async function runVersion({
  cwd,
  githubToken,
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  autoPublish = false,
  dedupe = false,
  prBodyMaxCharacters = MAX_CHARACTERS_PER_MESSAGE,
}: VersionOptions): Promise<RunVersionResult> {
  let repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  let branch = github.context.ref.replace("refs/heads/", "");
  let versionBranch = `changeset-release/${branch}`;
  let octokit = github.getOctokit(githubToken);
  let { preState } = await readChangesetState(cwd);

  await gitUtils.switchToMaybeExistingBranch(versionBranch);
  await gitUtils.reset(github.context.sha);

  let versionsByDirectory = await getVersionsByDirectory(cwd);

  let changesetVersionResult = await getExecOutput(
    "yarn",
    ["changeset", "--version"],
    { cwd },
  );
  if (changesetVersionResult.exitCode !== 0) {
    throw new Error(
      `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`
    );
  }
  let cmd = semver.lt(changesetVersionResult.stdout, "2.0.0")
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

  let searchQuery = `repo:${repo}+state:open+head:${versionBranch}+base:${branch}+is:pull-request`;
  let searchResultPromise = octokit.rest.search.issuesAndPullRequests({
    q: searchQuery,
  });
  let changedPackages = await getChangedPackages(cwd, versionsByDirectory);
  let changedPackagesInfoPromises = Promise.all(
    changedPackages.map(async (pkg): Promise<ChangedPackageInfo> => {
      let changelogContents = await fs.readFile(
        path.join(pkg.dir, "CHANGELOG.md"),
        "utf8"
      );
      return {
        ...getChangelogEntry(changelogContents, pkg.packageJson.version),
        private: !!pkg.packageJson.private,
        header: `## ${pkg.packageJson.name}@${pkg.packageJson.version}`,
      };
    })
  );

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

  const changedPackagesInfo = (await changedPackagesInfoPromises)
    .filter(Boolean)
    .sort(sortTheThings);

  let prBody = await getVersionPrBody({
    autoPublish,
    preState,
    branch,
    changedPackagesInfo,
    prBodyMaxCharacters,
  });

  if (searchResult.data.items.length === 0) {
    console.log("creating pull request");

    const { data: pullRequest } = await octokit.rest.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: pullRequest.number,
    };

  } else {
    const [pullRequest] = searchResult.data.items;
    console.log(`updating found pull request #${pullRequest.number}`);

    await octokit.rest.pulls.update({
      pull_number: pullRequest.number,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: pullRequest.number,
    };
  }
}
