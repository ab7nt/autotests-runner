const DATA_BASE = 'data';
const STORAGE_KEY = 'testiny-gh-launcher-v1';
const DEFAULTS = {
    repo: 'ab7nt/HelloPrintAutotests',
    branch: 'main',
    workflow: 'testiny-run.yml',
    environment: 'staging',
};

const els = {
    ghToken: document.getElementById('gh-token'),
    repo: document.getElementById('repo'),
    branch: document.getElementById('branch'),
    workflow: document.getElementById('workflow'),
    environment: document.getElementById('environment'),
    remember: document.getElementById('remember'),
    btnSave: document.getElementById('btn-save'),
    btnLoadProjects: document.getElementById('btn-load-projects'),
    btnLoadTests: document.getElementById('btn-load-tests'),
    projectSelect: document.getElementById('project-select'),
    testsContainer: document.getElementById('tests'),
    testsEmpty: document.getElementById('tests-empty'),
    runsContainer: document.getElementById('runs'),
    runsEmpty: document.getElementById('runs-empty'),
    toast: document.getElementById('toast'),
    search: document.getElementById('search'),
    testsMeta: document.getElementById('tests-meta'),
    btnClearRuns: document.getElementById('btn-clear-runs'),
    toggleGh: document.getElementById('toggle-gh-visibility'),
};

const state = {
    ghToken: '',
    repo: DEFAULTS.repo,
    branch: DEFAULTS.branch,
    workflow: DEFAULTS.workflow,
    environment: DEFAULTS.environment,
    remember: false,
    projectId: null,
    projects: [],
    tests: [],
    totalTests: 0,
    runs: new Map(),
    folders: [],
    folderMappings: [],
    testFolderMap: new Map(),
    openFolders: new Set(),
    selectedTests: new Set(),
    searchQuery: '',
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function loadStoredState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        Object.assign(state, saved, { runs: new Map() });
    } catch (e) {
        console.warn('Не удалось прочитать сохранённое состояние', e);
    }
}

function persistState() {
    const payload = {
        repo: state.repo,
        branch: state.branch,
        workflow: state.workflow,
        environment: state.environment,
        remember: state.remember,
    };

    if (state.remember) {
        payload.ghToken = state.ghToken;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function hydrateForm() {
    els.ghToken.value = state.ghToken;
    els.repo.value = state.repo;
    els.branch.value = state.branch;
    els.workflow.value = state.workflow;
    els.environment.value = state.environment;
    els.remember.checked = state.remember;
}

function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function setLoading(button, loading, label) {
    if (!button) return;
    if (!button.dataset.text) {
        button.dataset.text = button.textContent;
    }
    button.disabled = loading;
    button.textContent = loading ? label : button.dataset.text;
}

function togglePassword(input, btn) {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? 'Скрыть' : 'Показать';
}

function syncStateFromInputs() {
    state.ghToken = els.ghToken.value.trim();
    state.repo = els.repo.value.trim() || DEFAULTS.repo;
    state.branch = els.branch.value.trim() || DEFAULTS.branch;
    state.workflow = els.workflow.value.trim() || DEFAULTS.workflow;
    state.environment = els.environment.value.trim() || DEFAULTS.environment;
    state.remember = els.remember.checked;
}

function requireTokens() {
    if (!state.ghToken) throw new Error('Добавьте GitHub token.');
    if (!state.repo) throw new Error('Укажите репозиторий owner/repo.');
}

async function githubRequest(path, { method = 'GET', body } = {}) {
    if (!state.ghToken) throw new Error('Сначала введите GitHub token.');

    const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${state.ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers,
        body,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub ${res.status}: ${text}`);
    }

    if (res.status === 204) return null;
    return res.json();
}

function renderProjects() {
    els.projectSelect.innerHTML = '';
    state.projects.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (#${p.id})`;
        els.projectSelect.appendChild(opt);
    });
    if (state.projectId) {
        els.projectSelect.value = state.projectId;
    } else if (state.projects[0]) {
        state.projectId = state.projects[0].id;
        els.projectSelect.value = state.projectId;
    }
}

function updateTestsMeta(filteredCount) {
    const autoCount = state.tests.filter(isAutomated).length;
    const total = state.totalTests || state.tests.length;
    const visible = filteredCount ?? state.tests.length;
    els.testsMeta.textContent = `Tests ${visible} / automated ${autoCount}/${total}`;
}

function buildTestFolderMap() {
    const map = new Map();
    (state.folderMappings || []).forEach((m) => {
        const testId = m.testcase_id ?? m.testcaseId ?? m.test_id ?? m.testcaseId;
        const folderId = m.testcase_folder_id ?? m.testcaseFolderId ?? m.folder_id ?? m.folderId;
        if (testId) {
            map.set(testId, folderId ?? null);
        }
    });
    return map;
}

function getFolderParentId(folder) {
    return (
        folder.testcase_folder_parent_id ??
        folder.parent_id ??
        folder.parentId ??
        folder.folder_parent_id ??
        null
    );
}

function getFolderName(folder) {
    return folder.name || folder.title || folder.folder_name || 'Без папки';
}

function getTestFolderId(test) {
    return (
        test.testcase_folder_id ??
        test.testcase_folder?.id ??
        test.folder_id ??
        test.testcaseFolderId ??
        state.testFolderMap.get(test.id) ??
        null
    );
}

function buildFolderTree(tests) {
    const folders = (state.folders || []).map((f) => ({
        id: f.id,
        name: getFolderName(f),
        parentId: getFolderParentId(f),
        children: [],
        tests: [],
    }));

    const foldersById = new Map();
    folders.forEach((f) => foldersById.set(f.id, f));

    folders.forEach((folder) => {
        const parent = folder.parentId ? foldersById.get(folder.parentId) : null;
        if (parent) {
            parent.children.push(folder);
        }
    });

    const roots = folders.filter((f) => !f.parentId || !foldersById.has(f.parentId));
    const rootTests = [];

    tests.forEach((test) => {
        const folderId = getTestFolderId(test);
        if (folderId && foldersById.has(folderId)) {
            foldersById.get(folderId).tests.push(test);
        } else {
            rootTests.push(test);
        }
    });

    function prune(folder) {
        folder.children = folder.children.map(prune).filter(Boolean);
        if (folder.tests.length || folder.children.length) {
            return folder;
        }
        return null;
    }

    const prunedRoots = roots.map(prune).filter(Boolean);
    return { roots: prunedRoots, rootTests };
}

function collectFolderTests(folder, acc = []) {
    acc.push(...folder.tests);
    folder.children.forEach((child) => collectFolderTests(child, acc));
    return acc;
}

function folderSelectionState(folder, testsCache) {
    const tests = testsCache || collectFolderTests(folder, []);
    if (!tests.length) return "none";
    const selected = tests.filter((t) => state.selectedTests.has(t.id)).length;
    if (selected === 0) return "none";
    if (selected === tests.length) return "all";
    return "partial";
}

function renderTestRow(test) {
    const automated = isAutomated(test);
    const row = document.createElement("div");
    row.className = `test-row ${automated ? "" : "disabled"}`;

    const left = document.createElement("div");
    left.className = "test-row__main";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedTests.has(test.id);
    checkbox.addEventListener("change", (e) => {
        if (e.target.checked) {
            state.selectedTests.add(test.id);
        } else {
            state.selectedTests.delete(test.id);
        }
        renderTests();
    });

    const title = document.createElement("span");
    title.className = "test-row__title";
    title.textContent = test.title;

    const badge = document.createElement("span");
    badge.className = `pill ${automated ? "ok" : "neutral"}`;
    badge.textContent = automated ? "automated" : "manual";

    left.append(checkbox, title, badge);

    const action = document.createElement("div");
    action.className = "test-row__actions";

    const btn = document.createElement("button");
    btn.textContent = automated ? "Run" : "Not automated";
    btn.className = automated ? "primary" : "ghost";
    btn.disabled = !automated;
    btn.addEventListener("click", () => startRun(test));

    action.appendChild(btn);

    row.append(left, action);
    return row;
}

function renderFolderNode(folder) {
    const details = document.createElement("details");
    details.className = "folder";
    const forceOpen = Boolean(state.searchQuery);
    const isOpen = forceOpen || state.openFolders.has(folder.id);
    details.open = isOpen;

    const summary = document.createElement("summary");
    summary.className = "folder__header";

    const folderTests = collectFolderTests(folder, []);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selection = folderSelectionState(folder, folderTests);
    checkbox.checked = selection === "all";
    checkbox.indeterminate = selection === "partial";
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", (e) => {
        folderTests.forEach((t) => {
            if (e.target.checked) {
                state.selectedTests.add(t.id);
            } else {
                state.selectedTests.delete(t.id);
            }
        });
        renderTests();
    });

    const caret = document.createElement("span");
    caret.className = "folder__caret";
    caret.textContent = isOpen ? "?" : "?";

    const title = document.createElement("span");
    title.className = "folder__title";
    title.textContent = folder.name;

    const meta = document.createElement("span");
    meta.className = "folder__meta";
    meta.textContent = `${folderTests.length} items`;

    summary.append(checkbox, caret, title, meta);
    summary.addEventListener("click", () => {
        if (forceOpen) return;
        setTimeout(() => {
            caret.textContent = details.open ? "?" : "?";
        }, 0);
    });
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "folder__body";

    folder.tests.forEach((test) => body.appendChild(renderTestRow(test)));
    folder.children.forEach((child) => body.appendChild(renderFolderNode(child)));

    details.appendChild(body);

    details.addEventListener("toggle", () => {
        if (forceOpen) {
            details.open = true;
            caret.textContent = "?";
            return;
        }
        if (details.open) {
            state.openFolders.add(folder.id);
        } else {
            state.openFolders.delete(folder.id);
        }
        caret.textContent = details.open ? "?" : "?";
    });

    return details;
}


function renderRootTests(tests) {
    if (!tests.length) return null;
    const block = document.createElement("div");
    block.className = "folder folder--root";

    const header = document.createElement("div");
    header.className = "folder__header folder__header--root";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selected = tests.filter((t) => state.selectedTests.has(t.id)).length;
    checkbox.checked = selected > 0 && selected === tests.length;
    checkbox.indeterminate = selected > 0 && selected < tests.length;
    checkbox.addEventListener("change", (e) => {
        tests.forEach((t) => {
            if (e.target.checked) {
                state.selectedTests.add(t.id);
            } else {
                state.selectedTests.delete(t.id);
            }
        });
        renderTests();
    });

    const title = document.createElement("span");
    title.className = "folder__title";
    title.textContent = "Без папки";

    const meta = document.createElement("span");
    meta.className = "folder__meta";
    meta.textContent = `${tests.length} items`;

    header.append(checkbox, title, meta);
    block.appendChild(header);

    const body = document.createElement("div");
    body.className = "folder__body folder__body--open";
    tests.forEach((t) => body.appendChild(renderTestRow(t)));

    block.appendChild(body);
    return block;
}
function renderTests() {
    const query = els.search.value.trim().toLowerCase();
    state.searchQuery = query;
    els.testsContainer.innerHTML = "";
    let items = state.tests;

    if (query) {
        items = items.filter((t) => t.title.toLowerCase().includes(query));
    }

    if (!items.length) {
        els.testsEmpty.style.display = "block";
        updateTestsMeta(0);
        return;
    }
    els.testsEmpty.style.display = "none";

    const { roots, rootTests } = buildFolderTree(items);
    const fragment = document.createDocumentFragment();

    const rootBlock = renderRootTests(rootTests);
    if (rootBlock) fragment.appendChild(rootBlock);
    roots.forEach((folder) => fragment.appendChild(renderFolderNode(folder)));

    els.testsContainer.appendChild(fragment);

    updateTestsMeta(items.length);
}

function isAutomated(test) {
    const val = (test.testcase_type || test.automation || '').toString().toLowerCase();
    return val.includes('automated') || val === 'auto';
}

async function fetchCacheJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Не найден кеш ${url}. Запустите workflow Sync Testiny data.`);
    return res.json();
}

async function loadProjects() {
    setLoading(els.btnLoadProjects, true, '...');
    try {
        const cached = await fetchCacheJson(`${DATA_BASE}/projects.json`);
        state.projects = cached?.data || [];
        renderProjects();
        showToast('Проекты из кеша');
    } catch (e) {
        console.error(e);
        showToast(e.message);
    } finally {
        setLoading(els.btnLoadProjects, false);
    }
}

async function loadTests() {
    if (!state.projectId) {
        showToast('Не выбран проект.');
        return;
    }
    setLoading(els.btnLoadTests, true, "...");
    try {
        const cached = await fetchCacheJson(`${DATA_BASE}/tests-${state.projectId}.json`);
        state.tests = cached?.data || [];
        state.totalTests = cached?.totalCount || state.tests.length;
        state.folders = cached?.folders || [];
        state.folderMappings = cached?.folderMappings || [];
        state.testFolderMap = buildTestFolderMap();
        state.selectedTests = new Set();
        const rootFolderIds = (state.folders || [])
            .filter((f) => !getFolderParentId(f))
            .map((f) => f.id);
        state.openFolders = new Set(rootFolderIds);
        renderTests();
        showToast('Тесты загружены');
    } catch (e) {
        console.error(e);
        showToast(e.message);
    } finally {
        setLoading(els.btnLoadTests, false);
    }
}

async function startRun(test) {
    syncStateFromInputs();
    try {
        requireTokens();
    } catch (e) {
        showToast(e.message);
        return;
    }

    const startedAt = new Date().toISOString();
    showToast(`Стартуем: ${test.title}`);
    try {
        await githubRequest(`/repos/${state.repo}/actions/workflows/${state.workflow}/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
                ref: state.branch || 'main',
                inputs: {
                    test_name: test.title,
                    environment: state.environment || 'staging',
                },
            }),
        });

        const run = await waitForRun(startedAt);
        registerRun(run, test.title);
    } catch (e) {
        console.error(e);
        showToast(e.message);
    }
}

async function waitForRun(startedAt) {
    const started = new Date(startedAt).getTime();
    for (let i = 0; i < 10; i += 1) {
        await delay(2000);
        const data = await githubRequest(
            `/repos/${state.repo}/actions/workflows/${state.workflow}/runs?event=workflow_dispatch&branch=${state.branch}&per_page=20`
        );
        const run = (data.workflow_runs || []).find((r) => new Date(r.created_at).getTime() >= started - 1500);
        if (run) return run;
    }
    throw new Error('Не удалось найти созданный workflow run.');
}

function registerRun(run, testTitle) {
    const existing = state.runs.get(run.id);
    if (existing?.interval) clearInterval(existing.interval);

    const item = {
        id: run.id,
        html_url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
        testTitle,
        created_at: run.created_at,
    };

    state.runs.set(run.id, item);
    renderRuns();
    startPolling(run.id);
}

function renderRuns() {
    els.runsContainer.innerHTML = '';
    const runs = Array.from(state.runs.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    if (!runs.length) {
        els.runsEmpty.style.display = 'block';
        return;
    }
    els.runsEmpty.style.display = 'none';

    runs.forEach((run) => {
        const row = document.createElement('div');
        row.className = 'run';

        const title = document.createElement('p');
        title.className = 'run__title';
        title.textContent = run.testTitle;

        const status = document.createElement('span');
        status.className = `status ${statusClass(run)}`;
        status.textContent = statusLabel(run);

        const link = document.createElement('a');
        link.href = run.html_url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'Открыть run';

        row.append(title, status, link);
        els.runsContainer.appendChild(row);
    });
}

function statusClass(run) {
    if (run.status === 'queued') return 'queued';
    if (run.status === 'in_progress') return 'running';
    if (run.status === 'completed' && run.conclusion === 'success') return 'success';
    return 'failure';
}

function statusLabel(run) {
    if (run.status === 'queued') return 'queued';
    if (run.status === 'in_progress') return 'in progress';
    if (run.status === 'completed') return run.conclusion || 'completed';
    return run.status;
}

function startPolling(runId) {
    const tick = async () => {
        try {
            const data = await githubRequest(`/repos/${state.repo}/actions/runs/${runId}`);
            const prev = state.runs.get(runId);
            state.runs.set(runId, {
                ...prev,
                status: data.status,
                conclusion: data.conclusion,
                html_url: data.html_url,
                created_at: data.created_at,
            });
            renderRuns();
            if (data.status === 'completed') {
                const current = state.runs.get(runId);
                clearInterval(current.interval);
                showToast(`Run #${runId}: ${data.conclusion || 'completed'}`);
            }
        } catch (e) {
            console.error(e);
            showToast(e.message);
        }
    };

    const interval = setInterval(tick, 5000);
    const stored = state.runs.get(runId);
    if (stored) {
        stored.interval = interval;
        state.runs.set(runId, stored);
    }
    tick();
}

function clearRuns() {
    state.runs.forEach((r) => {
        if (r.interval) clearInterval(r.interval);
    });
    state.runs.clear();
    renderRuns();
}

function bindEvents() {
    els.btnSave.addEventListener('click', () => {
        syncStateFromInputs();
        persistState();
        showToast('Сохранено');
    });

    els.projectSelect.addEventListener('change', (e) => {
        state.projectId = e.target.value;
    });

    els.btnLoadProjects.addEventListener('click', loadProjects);
    els.btnLoadTests.addEventListener('click', loadTests);
    els.search.addEventListener('input', renderTests);
    els.btnClearRuns.addEventListener('click', clearRuns);

    els.toggleGh.addEventListener('click', () => togglePassword(els.ghToken, els.toggleGh));
}

function init() {
    loadStoredState();
    hydrateForm();
    bindEvents();
    renderProjects();
    renderTests();
    renderRuns();
}

init();
