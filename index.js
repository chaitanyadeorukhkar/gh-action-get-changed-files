// External Dependencies
const fs = require('fs');
const path = require('path');
const github = require('@actions/github');
const core = require('@actions/core');
const unified = require('unified');
const remarkParse = require('remark-parse');
const remarkStringify = require('remark-stringify');
const mdastToString = require('mdast-util-to-string');

const context = github.context;
const repo = context.payload.repository;
const owner = repo.owner;

const FILES = new Set();

const gh = github.getOctokit(core.getInput('token'));
const packageNameInput = core.getInput('package_name');
const args = { owner: owner.name || owner.login, repo: repo.name };

function formatLogMessage(msg, obj = null) {
  return obj ? `${msg}: ${toJSON(obj)}` : msg;
}

function debug(msg, obj = null) {
  core.debug(formatLogMessage(msg, obj));
}

function info(msg, obj = null) {
  core.info(formatLogMessage(msg, obj));
}

function toJSON(value, pretty = true) {
  return pretty ? JSON.stringify(value, null, 4) : JSON.stringify(value);
}

function fetchCommitData(commit) {
  args.ref = commit.id || commit.sha;

  debug('Calling gh.repos.getCommit() with args', args);

  return gh.repos.getCommit(args);
}

async function getCommits() {
  let commits;

  debug('Getting commits...');

  switch (context.eventName) {
    case 'push':
      commits = context.payload.commits;
      break;
    default:
      info(
        'You are using this action on an event for which it has not been tested. Only the "push" events are supported.',
      );
      commits = [];
      break;
  }

  return commits;
}

function filterPackageJson(files) {
  return files.filter((f) => f.match(/package.json$/));
}

function getChangelogEntry(changelog, version) {
  let ast = unified().use(remarkParse).parse(changelog);
  const BumpLevels = {
    dep: 0,
    patch: 1,
    minor: 2,
    major: 3,
  };
  let highestLevel = BumpLevels.dep;

  let nodes = ast.children;
  let headingStartInfo;
  let endIndex;

  for (let i = 0; i < nodes.length; i++) {
    let node = nodes[i];
    if (node.type === 'heading') {
      let stringified = mdastToString(node);
      let match = stringified.toLowerCase().match(/(major|minor|patch)/);
      if (match !== null) {
        let level = BumpLevels[match[0]];
        highestLevel = Math.max(level, highestLevel);
      }
      if (headingStartInfo === undefined && stringified === version) {
        headingStartInfo = {
          index: i,
          depth: node.depth,
        };
        continue;
      }
      if (
        endIndex === undefined &&
        headingStartInfo !== undefined &&
        headingStartInfo.depth === node.depth
      ) {
        endIndex = i;
        break;
      }
    }
  }
  if (headingStartInfo) {
    ast.children = ast.children.slice(headingStartInfo.index + 1, endIndex);
  }
  return {
    content: unified().use(remarkStringify).stringify(ast),
    highestLevel: highestLevel,
  };
}

async function processOutputs() {
  debug('FILES', Array.from(FILES.values()));
  const allUpdatedPackageJsonPath = filterPackageJson(Array.from(FILES.values()));
  let updatedPackages = [];
  allUpdatedPackageJsonPath.map((packageJsonPath) => {
    const packageDirectory = path.dirname(`./${packageJsonPath}`);
    const packageJson = JSON.parse(fs.readFileSync(`${packageDirectory}/package.json`, 'utf-8'));
    const changelog = fs.readFileSync(`${packageDirectory}/CHANGELOG.md`, 'utf-8');
    const changelogEntry = getChangelogEntry(changelog, packageJson.version);
    updatedPackages.push({
      name: packageJson.name,
      version: packageJson.version,
      changes: changelogEntry.content,
    });
  });

  let updatedVersion = null;
  let updatedChangelogEntry = null;
  if (packageNameInput) {
    const updatedPackage = updatedPackages.find((package) => package.name == packageNameInput);
    updatedVersion = updatedPackage.version;
    updatedChangelogEntry = updatedPackage.changes;
  }

  //   updatedPackages.map(({ name, version, changes }) => {
  //     gh.repos.createRelease({
  //       tag_name: `${name}@${version}`,
  //       name: `${name}@${version}`,
  //       body: changes,
  //       ...context.repo,
  //     });
  //   });

  core.setOutput('updated', toJSON(updatedPackages, 0));
  core.setOutput('updatedVersion', updatedVersion);
  core.setOutput('updatedChangelogEntry', updatedChangelogEntry);
}

async function processCommitData(result) {
  debug('Processing API Response', result);

  if (!result || !result.data) {
    return;
  }

  result.data.files.forEach((file) => {
    FILES.add(file.filename);
  });
}

getCommits().then((commits) => {
  // Exclude merge commits
  commits = commits.filter((c) => !c.parents || 1 === c.parents.length);

  if ('push' === context.eventName) {
    commits = commits.filter((c) => c.distinct);
  }

  debug('All Commits', commits);

  Promise.all(commits.map(fetchCommitData))
    .then((data) => Promise.all(data.map(processCommitData)))
    .then(processOutputs)
    .then(() => (process.exitCode = 0))
    .catch((err) => core.error(err) && (process.exitCode = 1));
});
