#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://app.testiny.io/api/v1';
const API_KEY = process.env.TESTINY_API_KEY;
const PAGE_LIMIT = 500;

if (!API_KEY) {
    console.error('TESTINY_API_KEY is required');
    process.exit(1);
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

async function fetchProjects() {
    return post('/project/find', {
        pagination: { offset: 0, limit: 200 },
        order: [{ column: 'name', order: 'asc' }],
        includeTotalCount: true,
        filter: {},
    });
}

async function fetchTestsForFolder(projectId, folderId) {
    let offset = 0;
    let total = 0;
    const acc = [];

    // Fetch tests per root folder subtree via map to include testcase_folder.
    while (true) {
        const res = await post('/testcase/find', {
            pagination: { offset, limit: PAGE_LIMIT },
            order: [{ column: 'title', order: 'asc' }],
            includeTotalCount: true,
            filter: { project_id: Number(projectId) },
            map: {
                entities: ['testcase', 'testcase_folder'],
                result: 'testcase_folder',
                resultFilter: {
                    or: [
                        { testcase_folder_parent_id: { op: 'in_subtree', value: Number(folderId) } },
                        { id: Number(folderId) },
                    ],
                },
            },
        });

        acc.push(...(res.data || []));
        total = res.meta?.totalCount ?? acc.length;
        offset += res.data?.length ?? 0;

        if (offset >= total || !res.data?.length) break;
    }

    return { data: acc, totalCount: total };
}

async function fetchTestFolders(projectId) {
    let offset = 0;
    let total = 0;
    const acc = [];
    const limit = 2000;

    while (true) {
        const res = await post('/testcase-folder/find', {
            pagination: { offset, limit },
            filter: { project_id: Number(projectId) },
            omitLargeValues: true,
        });

        acc.push(...(res.data || []));
        total = res.meta?.totalCount ?? acc.length;
        offset += res.data?.length ?? 0;

        if (offset >= total || !res.data?.length) break;
    }

    return { data: acc, totalCount: total };
}

async function main() {
    console.log('Syncing projects...');
    const projects = await fetchProjects();

    const outDir = path.join(__dirname, '..', 'docs', 'data');
    fs.mkdirSync(outDir, { recursive: true });

    const projectsPayload = {
        generatedAt: new Date().toISOString(),
        totalCount: projects.meta?.totalCount ?? projects.data?.length ?? 0,
        data: projects.data || [],
    };
    fs.writeFileSync(path.join(outDir, 'projects.json'), JSON.stringify(projectsPayload, null, 2));
    console.log(`Saved projects.json (${projectsPayload.totalCount})`);

    for (const project of projects.data || []) {
        console.log(`Syncing tests for project #${project.id} "${project.name}"...`);
        const folders = await fetchTestFolders(project.id);
        const rootFolders = (folders.data || []).filter((f) => !f.testcase_folder_parent_id);
        const testsById = new Map();
        const mappingsByTestId = new Map();

        for (const folder of rootFolders) {
            const tests = await fetchTestsForFolder(project.id, folder.id);
            (tests.data || []).forEach((test) => {
                testsById.set(test.id, test);
                const folderId = test.testcase_folder?.id;
                if (folderId && !mappingsByTestId.has(test.id)) {
                    mappingsByTestId.set(test.id, folderId);
                }
            });
        }

        const testsList = Array.from(testsById.values());
        const mappings = Array.from(mappingsByTestId.entries()).map(([testcase_id, testcase_folder_id]) => ({
            testcase_id,
            testcase_folder_id,
        }));
        const testsPayload = {
            projectId: project.id,
            projectName: project.name,
            generatedAt: new Date().toISOString(),
            totalCount: testsList.length,
            data: testsList,
            folders: folders.data,
            folderMappings: mappings,
        };
        fs.writeFileSync(path.join(outDir, `tests-${project.id}.json`), JSON.stringify(testsPayload, null, 2));
        console.log(`Saved tests-${project.id}.json (${testsList.length})`);
    }
}

main().catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
});
