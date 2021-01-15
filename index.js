// External Dependencies
const fs     = require('fs');
const path     = require('path');
const github = require('@actions/github');
const core   = require('@actions/core');

const context = github.context;
const repo    = context.payload.repository;
const owner   = repo.owner;

const FILES          = new Set();

const gh = github.getOctokit(core.getInput('token'));
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

function toJSON(value, pretty=true) {
	return pretty
		? JSON.stringify(value, null, 4)
		: JSON.stringify(value);
}

function fetchCommitData(commit) {
	args.ref = commit.id || commit.sha;

	debug('Calling gh.repos.getCommit() with args', args)

	return gh.repos.getCommit(args);
}

async function getCommits() {
	let commits;

	debug('Getting commits...');

	switch(context.eventName) {
		case 'push':
			commits = context.payload.commits;
		break;
		default:
			info('You are using this action on an event for which it has not been tested. Only the "push" events are supported.');
			commits = [];
		break;
	}

	return commits;
}

function filterPackageJson(files) {
    return files.filter(f => f.match(/package.json$/))
}

async function outputResults() {
	debug('FILES', Array.from(FILES.values()));
    const allUpdatedPackageJsonPath = filterPackageJson(Array.from(FILES.values()));
    let updatedPackages = [];
    allUpdatedPackageJsonPath.map(packageJsonPath => {
        const packageDirectory = path.dirname(`./${packageJsonPath}`)
        const packageJson = JSON.parse(fs.readFileSync(`${packageDirectory}/package.json`, 'utf-8'));
        const changelogContent = fs.readFileSync(`${packageDirectory}/CHANGELOG.md`, 'utf-8');
        const changes = changelogContent.split(/\s##\s/).filter(f => f.match(new RegExp('^' + packageJson.version)))[0].split(new RegExp('^' + packageJson.version))[1]
        updatedPackages.push({
            name: packageJson.name,
            version: packageJson.version,
            changes: changes
        })
    })

    updatedPackages.map(({name, version, changes}) => {
        gh.repos.createRelease({
            tag_name: `${name}@${version}`,
            name: `${name}@${version}`,
            body: changes,
            ...context.repo
        })
    })
	core.setOutput('updated', toJSON(updatedPackages, 0));
}

async function processCommitData(result) {
	debug('Processing API Response', result);

	if (! result || ! result.data) {
		return;
	}

	result.data.files.forEach(file => {
		FILES.add(file.filename);
	});
}

getCommits().then(commits => {
	// Exclude merge commits
	commits = commits.filter(c => ! c.parents || 1 === c.parents.length);

	if ('push' === context.eventName) {
		commits = commits.filter(c => c.distinct);
	}

	debug('All Commits', commits);

	Promise.all(commits.map(fetchCommitData))
		.then(data => Promise.all(data.map(processCommitData)))
		.then(outputResults)
		.then(() => process.exitCode = 0)
		.catch(err => core.error(err) && (process.exitCode = 1));
});

