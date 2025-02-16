import * as core from "@actions/core";
import * as path from "node:path";
import fs from "fs-extra";
import * as gitUtils from "./gitUtils";
import { runPublish, runVersion } from "./run";
import readChangesetState from "./readChangesetState";

const getOptionalInput = (name: string) => core.getInput(name) || undefined;

(async () => {
  let githubToken = process.env.GITHUB_TOKEN;
  let npmToken = process.env.NPM_TOKEN;

  if (!githubToken) {
    core.setFailed("Please add the GITHUB_TOKEN to the changesets action");
    return;
  }

  let setupGitUser = core.getBooleanInput("setupGitUser");

  if (setupGitUser) {
    console.log("setting git user");
    await gitUtils.setupUser();
  }

  console.log("setting GitHub credentials");
  await fs.writeFile(
    `${process.env.HOME}/.netrc`,
    `machine github.com\nlogin github-actions[bot]\npassword ${githubToken}`
  );

  let inputCwd = core.getInput("cwd");
  let resolvedCwd = path.isAbsolute(inputCwd)
    ? inputCwd
    : path.resolve(process.cwd(), inputCwd);

  let { changesets } = await readChangesetState(resolvedCwd);

  let autoPublish = core.getBooleanInput("autoPublish");
  let dedupe = core.getBooleanInput("dedupe");
  let hasChangesets = changesets.length !== 0;

  const hasNonEmptyChangesets = changesets.some(
    (changeset) => changeset.releases.length > 0
  );

  core.setOutput("published", "false");
  core.setOutput("publishedPackages", "[]");
  core.setOutput("hasChangesets", String(hasChangesets));

  if (hasChangesets) {
    if (hasNonEmptyChangesets) {
      const { pullRequestNumber } = await runVersion({
        cwd: resolvedCwd,
        githubToken,
        prTitle: getOptionalInput("title"),
        commitMessage: getOptionalInput("commit"),
        autoPublish,
        dedupe,
      });
      core.setOutput("pullRequestNumber", String(pullRequestNumber));
      return;
    } else {
      console.log("All changesets are empty; not creating PR");
      return;
    }
  } else {
    console.log("No changesets found");

    if (autoPublish) {
      if (!npmToken) {
        core.setFailed("Please add the NPM_TOKEN to the changesets action");
        return;
      }

      console.log("Attempting to publish any unpublished packages to npm");

      const result = await runPublish({
        cwd: resolvedCwd,
        npmToken,
        githubToken,
        createGithubReleases: core.getBooleanInput("createGithubReleases"),
      });

      if (result.published) {
        core.setOutput("published", "true");
        core.setOutput(
          "publishedPackages",
          JSON.stringify(result.publishedPackages),
        );
      }
    }
  }
})().catch((err) => {
  console.error(err);
  core.setFailed(err.message);
});
