const core = require('@actions/core')
const github = require('@actions/github')

const gitRawCommits = require('git-raw-commits')

const JiraClient = require('jira-connector');

const pullRequestEvent = 'pull_request'

const {GH_TOKEN, GITHUB_EVENT_NAME, GITHUB_SHA, JIRA_TOKEN, JIRA_USER, JIRA_HOST} = process.env

const {context: eventContext} = github

const jira = new JiraClient({
                                host: JIRA_HOST,
                                basic_auth: {
                                    email: JIRA_USER,
                                    api_token: JIRA_TOKEN
                                }
                            });

const pushEventHasOnlyOneCommit = from => {
    const gitEmptySha = '0000000000000000000000000000000000000000'

    return from === gitEmptySha
}

const getRangeForPushEvent = () => {
    let from = eventContext.payload.before
    const to = GITHUB_SHA

    if (eventContext.payload.forced) {
        // When a commit is forced, "before" field from the push event data may point to a commit that doesn't exist
        console.warn(
            'Commit was forced, checking only the latest commit from push instead of a range of commit messages',
        )
        from = null
    }

    if (pushEventHasOnlyOneCommit(from)) {
        from = null
    }

    return [from, to]
}

const getRangeForEvent = async () => {
    if (GITHUB_EVENT_NAME !== pullRequestEvent) {
        return getRangeForPushEvent()
    }

    const octokit = new github.GitHub(GH_TOKEN)
    const {owner, repo, number} = eventContext.issue
    const {data: commits} = await octokit.pulls.listCommits({
                                                                owner,
                                                                repo,
                                                                pull_number: number,
                                                            })
    const commitShas = commits.map(commit => commit.sha)
    const [from] = commitShas
    const to = commitShas[commitShas.length - 1]
    // Git revision range doesn't include the "from" field in "git log", so for "from" we use the parent commit of PR's
    // first commit
    const fromParent = `${from}^1`

    return [fromParent, to]
}

function getHistoryCommits(from, to) {
    const options = {
        from,
        to,
    }

    if (core.getInput('firstParent') === 'true') {
        options.firstParent = true
    }

    if (!from) {
        options.maxCount = 1
    }

    return new Promise((resolve, reject) => {
        const data = []

        gitRawCommits(options)
            .on('data', chunk => data.push(chunk.toString('utf-8')))
            .on('error', reject)
            .on('end', () => {
                resolve(data)
            })
    })
}

const setFailed = formattedResults => {
    core.setFailed(`You have commit messages with errors\n\n${formattedResults}`)
}

const showLintResults = async ([from, to]) => {
    const commits = await getHistoryCommits(from, to)
    console.log(`all commits: ${commits}`)

    let failed = false

    const results = await Promise.all(
        commits.map((commit) => {
            console.log(`Commit message: ${commit}`)

            if (commit.includes("TRIVIAL")) {
                return
            }

            let match = commit.match(/WND-\d+/g);
            console.log(`matching? : ${match}`)
            if (match) {
                let issueId = match
                console.log(`issueId: ${issueId}`)
                jira.issue.getIssue({
                                        issueKey: issueId,
                                        fields: ['summary','labels','status','components','issueType']
                                    }, function(error, iss) {
                    if (error) {
                        console.error(err);
                        //check if not found and set failed
                        failed = true
                        callback(error, "Jira issue number in commit message could not be found")
                    }
                    console.log(`Issue: ${JSON.stringify(iss)}`)
                    if (iss.fields.status.name == "Resolved") {
                        console.log(`Issue is already resolved`)
                        failed = true
                        return "Issue is already resolved"
                    }
                });

            } else {
                failed = true
                return "Commit message does not contain jira issue number"
            }
        }),
    )

    if (failed) {
        setFailed(results)
    } else {
        console.log('Commit message ok 🎉')
    }
}

const exitWithMessage = message => error => {
    core.setFailed(`${message}\n${error.message}\n${error.stack}`)
}

getRangeForEvent()
    .catch(
        exitWithMessage("error trying to get list of pull request's commits"),
    )
    .then(showLintResults)
    .catch(exitWithMessage('error running commitlint'))

