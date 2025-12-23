#!/usr/bin/env node
const { spawnSync } = require('child_process');

const API_BASE = 'https://app.testiny.io/api/v1';
const API_KEY = process.env.TESTINY_API_KEY;
const PROJECT_ID = Number(process.env.PROJECT_ID);
const TESTS_JSON = process.env.TESTS_JSON || '[]';
const ENVIRONMENT = process.env.ENVIRONMENT || 'staging';

if (!API_KEY) {
    console.error('TESTINY_API_KEY is required');
    process.exit(1);
}
if (!PROJECT_ID) {
    console.error('PROJECT_ID is required');
    process.exit(1);
}

const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : '';

function formatRunTitle(date) {
    const pad = (value) => String(value).padStart(2, '0');
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = String(date.getFullYear()).slice(-2);
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `Autocreated test run ${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

async function post(endpoint, body) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': API_KEY,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${endpoint} ${res.status}: ${text}`);
    }
    return res.json();
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function createTestRun(projectId) {
    const title = formatRunTitle(new Date());
    const payload = {
        title,
        project_id: projectId,
        description: 'Создано через API',
    };
    const run = await post('/testrun', payload);
    if (!run?.id) {
        throw new Error('Testiny did not return testrun id');
    }
    console.log(`Created Testiny run #${run.id}`);
    return run.id;
}

async function mapTestsToRun(testRunId, tests) {
    const batches = chunkArray(tests, 200);
    for (const batch of batches) {
        const payload = batch.map((test) => ({
            ids: {
                testcase_id: test.id,
                testrun_id: testRunId,
            },
            mapped: {
                result_status: 'NOTRUN',
            },
        }));
        await post('/testrun/mapping/bulk/testcase:testrun?op=add_or_update', payload);
    }
}

async function updateTestResult(testRunId, testId, status, comment) {
    const payload = [
        {
            ids: {
                testcase_id: testId,
                testrun_id: testRunId,
            },
            mapped: {
                result_status: status,
                comment,
            },
        },
    ];
    await post('/testrun/mapping/bulk/testcase:testrun?op=update', payload);
}

function runPlaywrightTest(title) {
    const result = spawnSync(
        'npx',
        ['playwright', 'test', '--grep', title],
        {
            stdio: 'inherit',
            env: {
                ...process.env,
                ENVIRONMENT,
            },
        }
    );
    return result.status === 0;
}

async function main() {
    const tests = JSON.parse(TESTS_JSON);
    if (!Array.isArray(tests) || tests.length === 0) {
        console.error('No tests to run');
        process.exit(1);
    }

    const testRunId = await createTestRun(PROJECT_ID);
    await mapTestsToRun(testRunId, tests);

    let hasFailures = false;
    for (const test of tests) {
        if (!test?.id || !test?.title) continue;
        console.log(`Running: ${test.title}`);
        const ok = runPlaywrightTest(test.title);
        const status = ok ? 'PASSED' : 'FAILED';
        const comment = runUrl
            ? `Автоматически пройденны тест. Подробнее <a href="${runUrl}">Actions run</a>`
            : 'Автоматически пройденны тест.';
        await updateTestResult(testRunId, test.id, status, comment);
        if (!ok) {
            hasFailures = true;
        }
    }

    process.exit(hasFailures ? 1 : 0);
}

main().catch((err) => {
    console.error('Bulk run failed:', err);
    process.exit(1);
});
