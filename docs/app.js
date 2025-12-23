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
    selectionPanel: document.getElementById('selection-panel'),
    btnRunSelected: document.getElementById('btn-run-selected'),
    btnStopSelected: document.getElementById('btn-stop-selected'),
    selectionStatus: document.getElementById('selection-status'),
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
    latestRunByTestId: new Map(),
    pendingRunLookups: new Map(),
    folders: [],
    folderMappings: [],
    testFolderMap: new Map(),
    openFolders: new Set(),
    selectedTests: new Set(),
    searchQuery: '',
    bulkRun: {
        active: false,
        stopRequested: false,
        runId: null,
        discoveryInterval: null,
    },
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function loadStoredState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        Object.assign(state, saved, {
            runs: new Map(),
            latestRunByTestId: new Map(),
            pendingRunLookups: new Map(),
        });
    } catch (e) {
        console.warn('Не удалось прочитать сохраненное состояние', e);
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
    setTimeout(() => els.toast.classList.remove('show'), 5600);
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
        return;
    }
    if (state.projects[0]) {
        state.projectId = state.projects[0].id;
        els.projectSelect.value = state.projectId;
    }
}

function updateTestsMeta(filteredCount) {
    const autoCount = state.tests.filter(isAutomated).length;
    const total = state.totalTests || state.tests.length;
    const visible = filteredCount ?? state.tests.length;
    els.testsMeta.textContent = `tests ${total} automated ${autoCount}`;
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
    const tests = (testsCache || collectFolderTests(folder, [])).filter(isAutomated);
    if (!tests.length) return "none";
    const selected = tests.filter((t) => state.selectedTests.has(t.id)).length;
    if (selected === 0) return "none";
    if (selected === tests.length) return "all";
    return "partial";
}

function renderTestRow(test) {
    const automated = isAutomated(test);
    const runInfo = state.latestRunByTestId.get(test.id) || null;
    const isBusy = Boolean(automated && runInfo && runInfo.status !== "completed");
    const row = document.createElement("div");
    row.className = `test-row ${automated ? "" : "disabled"}`;

    const left = document.createElement("div");
    left.className = "test-row__main";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedTests.has(test.id);
    checkbox.id = `test-${test.id}`;
    checkbox.disabled = !automated;
    if (automated) {
        checkbox.addEventListener("change", (e) => {
            if (e.target.checked) {
                state.selectedTests.add(test.id);
            } else {
                state.selectedTests.delete(test.id);
            }
            renderTests();
        });
    }

    const title = document.createElement("label");
    title.className = "test-row__title";
    title.setAttribute("for", checkbox.id);
    title.textContent = test.title;

    const status = renderTestStatus(test.id);
    left.append(checkbox, title);

    const action = document.createElement("div");
    action.className = "test-row__actions";

    const btn = document.createElement("button");
    if (!automated) {
        btn.textContent = "Not automated";
    } else if (isBusy) {
        btn.textContent = runInfo.status === "queued" ? "Queued" : "Running";
    } else {
        btn.textContent = "Run";
    }
    btn.className = automated ? "primary" : "ghost";
    if (isBusy) {
        btn.classList.add("is-busy");
    }
    btn.disabled = !automated || isBusy;
    btn.addEventListener("click", () => startRun(test));

    if (status) {
        action.append(status);
    }
    action.append(btn);

    row.append(left, action);
    return row;
}

function renderTestStatus(testId) {
    const run = state.latestRunByTestId.get(testId);
    if (!run || run.status !== "completed") return null;
    const wrap = document.createElement("span");
    const icon = document.createElement("ion-icon");
    const conclusion = (run.conclusion || "").toLowerCase();
    const isSuccess = conclusion === "success";
    wrap.className = `status-icon-wrap ${isSuccess ? "status-icon-wrap--ok" : "status-icon-wrap--bad"}`;
    icon.setAttribute("name", isSuccess ? "checkmark-circle" : "close-circle");
    wrap.appendChild(icon);
    return wrap;
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
    const automatedTests = folderTests.filter(isAutomated);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selection = folderSelectionState(folder, automatedTests);
    checkbox.checked = selection === "all";
    checkbox.indeterminate = selection === "partial";
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", (e) => {
        automatedTests.forEach((t) => {
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
    if (isOpen) caret.classList.add("is-open");

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
            caret.classList.toggle("is-open", details.open);
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
            caret.classList.add("is-open");
            return;
        }
        if (details.open) {
            state.openFolders.add(folder.id);
        } else {
            state.openFolders.delete(folder.id);
        }
        caret.classList.toggle("is-open", details.open);
    });

    return details;
}


function renderRootTests(tests) {
    if (!tests.length) return null;
    const block = document.createElement("div");
    block.className = "folder folder--root";

    const automatedTests = tests.filter(isAutomated);

    const header = document.createElement("div");
    header.className = "folder__header folder__header--root";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selected = automatedTests.filter((t) => state.selectedTests.has(t.id)).length;
    checkbox.checked = selected > 0 && selected === automatedTests.length;
    checkbox.indeterminate = selected > 0 && selected < automatedTests.length;
    checkbox.addEventListener("change", (e) => {
        automatedTests.forEach((t) => {
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
        updateSelectionPanel();
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
    updateSelectionPanel();
}

function isAutomated(test) {
    const val = (test.testcase_type || test.automation || '').toString().toLowerCase();
    return val.includes('automated') || val === 'auto';
}

async function fetchCacheJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Не найден кэш ${url}. Запустите workflow Sync Testiny data.`);
    return res.json();
}

async function loadProjects() {
    setLoading(els.btnLoadProjects, true, '...');
    try {
        const cached = await fetchCacheJson(`${DATA_BASE}/projects.json`);
        state.projects = cached?.data || [];
        renderProjects();
        if (state.projectId) {
            loadTests();
        }
        showToast('Проекты загружены');
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
        state.pendingRunLookups.forEach((interval) => clearInterval(interval));
        state.pendingRunLookups.clear();
        state.latestRunByTestId = new Map();
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

    try {
        await dispatchRun(test, true);
    } catch (e) {
        console.error(e);
        showToast(e.message);
    }
}

async function dispatchRun(test, waitForLookup) {
    const startedAt = new Date().toISOString();
    showToast(`Запуск теста: ${test.title}`);
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

    state.latestRunByTestId.set(test.id, {
        status: "queued",
        conclusion: null,
        testTitle: test.title,
        created_at: startedAt,
        testId: test.id,
    });
    renderTests();

    if (waitForLookup) {
        const run = await waitForRun(startedAt, test.title);
        if (run) {
            registerRun(run, test.title, test.id);
        } else {
            showToast('Run запущен, продолжаю искать его в GitHub Actions...');
            startRunDiscovery(startedAt, test);
        }
    } else {
        startRunDiscovery(startedAt, test);
    }
}

async function waitForRun(startedAt, testTitle, workflow = state.workflow) {
    for (let i = 0; i < 30; i += 1) {
        await delay(3000);
        const data = await githubRequest(
            `/repos/${state.repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${state.branch}&per_page=50`
        );
        const run = findRunCandidate(data, startedAt, testTitle);
        if (run) return run;
    }
    return null;
}

function findRunCandidate(data, startedAt, testTitle) {
    const runs = data.workflow_runs || [];
    if (!runs.length) return null;
    const started = new Date(startedAt).getTime();
    const threshold = started - 10 * 60 * 1000;
    const title = (testTitle || '').toLowerCase();
    const filtered = runs.filter((r) => {
        const created = new Date(r.created_at).getTime();
        return (
            r.event === 'workflow_dispatch' &&
            (!state.branch || r.head_branch === state.branch) &&
            created >= threshold
        );
    });
    if (!filtered.length) return null;
    const withTitle = title
        ? filtered.filter((r) =>
              ((r.display_title || r.name || '').toLowerCase().includes(title))
          )
        : filtered;
    const list = withTitle.length ? withTitle : filtered;
    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

function startRunDiscovery(startedAt, test) {
    if (state.pendingRunLookups.has(test.id)) return;
    let tries = 0;
    const interval = setInterval(async () => {
        tries += 1;
        try {
            const data = await githubRequest(
                `/repos/${state.repo}/actions/workflows/${state.workflow}/runs?event=workflow_dispatch&branch=${state.branch}&per_page=50`
            );
            const run = findRunCandidate(data, startedAt, test.title);
            if (run) {
                registerRun(run, test.title, test.id);
                stopPendingLookup(test.id);
                return;
            }
            if (tries >= 30) {
                stopPendingLookup(test.id);
                showToast('Не удалось найти workflow run. Проверьте список запусков в GitHub Actions.');
            }
        } catch (e) {
            console.error(e);
        }
    }, 10000);
    state.pendingRunLookups.set(test.id, interval);
}

function stopPendingLookup(testId) {
    const interval = state.pendingRunLookups.get(testId);
    if (interval) {
        clearInterval(interval);
        state.pendingRunLookups.delete(testId);
    }
}

function registerRun(run, testTitle, testId, extra = {}) {
    const existing = state.runs.get(run.id);
    if (existing?.interval) clearInterval(existing.interval);

    const item = {
        id: run.id,
        html_url: run.html_url,
        status: run.status,
        conclusion: run.conclusion,
        testTitle,
        created_at: run.created_at,
        testId,
        ...extra,
    };

    state.runs.set(run.id, item);
    if (testId) {
        state.latestRunByTestId.set(testId, item);
        stopPendingLookup(testId);
    }
    if (extra.isBulk) {
        stopBulkRunDiscovery();
        state.bulkRun.runId = run.id;
    }
    renderRuns();
    renderTests();
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
        link.textContent = 'Открыть';

        row.append(title, status, link);
        els.runsContainer.appendChild(row);
    });
    updateSelectionPanel();
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
            const updated = {
                ...prev,
                status: data.status,
                conclusion: data.conclusion,
                html_url: data.html_url,
                created_at: data.created_at,
            };
            state.runs.set(runId, updated);
            if (updated.testId) {
                state.latestRunByTestId.set(updated.testId, updated);
            }
            renderRuns();
            renderTests();
            if (data.status === 'completed') {
                const current = state.runs.get(runId);
                clearInterval(current.interval);
                if (updated.isBulk) {
                    state.bulkRun.active = false;
                    state.bulkRun.runId = null;
                    updateSelectionPanelButtons();
                }
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
    state.pendingRunLookups.forEach((interval) => clearInterval(interval));
    state.pendingRunLookups.clear();
    state.latestRunByTestId.clear();
    stopBulkRunDiscovery();
    state.bulkRun.active = false;
    state.bulkRun.runId = null;
    renderRuns();
    renderTests();
}

function getSelectedTests() {
    return state.tests.filter((test) => state.selectedTests.has(test.id));
}

function hasActiveSelectedRuns() {
    for (const testId of state.selectedTests) {
        const run = state.latestRunByTestId.get(testId);
        if (run && run.status !== 'completed') {
            return true;
        }
    }
    return false;
}

function updateSelectionPanelButtons() {
    const hasSelected = state.selectedTests.size > 0;
    const isRunning = state.bulkRun.active || hasActiveSelectedRuns();
    if (isRunning) {
        els.btnRunSelected.disabled = true;
        els.btnRunSelected.textContent = 'Running';
    } else {
        els.btnRunSelected.disabled = !hasSelected;
        els.btnRunSelected.textContent = `Run selected (${state.selectedTests.size})`;
    }
    els.btnStopSelected.disabled = !state.bulkRun.active;
}

function updateSelectionPanel() {
    if (!els.selectionPanel) return;
    const total = state.selectedTests.size;
    if (total === 0) {
        els.selectionPanel.classList.remove('is-visible');
        els.selectionStatus.textContent = '-';
        updateSelectionPanelButtons();
        return;
    }

    let completed = 0;
    let success = 0;
    let failed = 0;
    state.selectedTests.forEach((testId) => {
        const run = state.latestRunByTestId.get(testId);
        if (!run) return;
        if (run.status === 'completed') {
            completed += 1;
            if ((run.conclusion || '').toLowerCase() === 'success') {
                success += 1;
            } else {
                failed += 1;
            }
        }
    });

    els.selectionStatus.innerHTML = `
        <div>Выполнено ${completed} из ${total}</div>
        <div class="status-success">Success ${success}</div>
        <div class="status-failed">Failed ${failed}</div>
    `;
    els.selectionPanel.classList.add('is-visible');
    updateSelectionPanelButtons();
}

async function startSelectedRuns() {
    if (state.bulkRun.active) return;
    const selected = getSelectedTests().filter(isAutomated);
    if (!selected.length) return;

    syncStateFromInputs();
    try {
        requireTokens();
    } catch (e) {
        showToast(e.message);
        return;
    }

    state.bulkRun.active = true;
    state.bulkRun.stopRequested = false;
    updateSelectionPanelButtons();

    try {
        await dispatchBulkRun(selected);
    } catch (e) {
        console.error(e);
        showToast(e.message);
        state.bulkRun.active = false;
        updateSelectionPanelButtons();
    }
}

function stopSelectedRuns() {
    state.bulkRun.stopRequested = true;
}

async function dispatchBulkRun(selectedTests) {
    const startedAt = new Date().toISOString();
    const testsPayload = selectedTests.map((test) => ({
        id: test.id,
        title: test.title,
    }));

    await githubRequest(`/repos/${state.repo}/actions/workflows/testiny-bulk-run.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({
            ref: state.branch || 'main',
            inputs: {
                tests_json: JSON.stringify(testsPayload),
                project_id: String(state.projectId || ''),
                environment: state.environment || 'staging',
                tests_count: String(testsPayload.length),
            },
        }),
    });

    showToast(`Bulk run запущен: ${testsPayload.length} тестов`);

    const run = await waitForRun(startedAt, 'bulk run', 'testiny-bulk-run.yml');
    if (run) {
        registerRun(run, `Bulk run (${testsPayload.length} tests)`, null, { isBulk: true });
        return;
    }

    showToast('Run запущен, продолжаю искать его в GitHub Actions...');
    startBulkRunDiscovery(startedAt, testsPayload.length);
}

function startBulkRunDiscovery(startedAt, testsCount) {
    if (state.bulkRun.discoveryInterval) return;
    let tries = 0;
    const interval = setInterval(async () => {
        tries += 1;
        try {
            const data = await githubRequest(
                `/repos/${state.repo}/actions/workflows/testiny-bulk-run.yml/runs?event=workflow_dispatch&branch=${state.branch}&per_page=50`
            );
            const run = findRunCandidate(data, startedAt, 'bulk run');
            if (run) {
                registerRun(run, `Bulk run (${testsCount} tests)`, null, { isBulk: true });
                stopBulkRunDiscovery();
                return;
            }
            if (tries >= 30) {
                stopBulkRunDiscovery();
                state.bulkRun.active = false;
                updateSelectionPanelButtons();
                showToast('Не удалось найти workflow run. Проверьте список запусков в GitHub Actions.');
            }
        } catch (e) {
            console.error(e);
        }
    }, 10000);
    state.bulkRun.discoveryInterval = interval;
}

function stopBulkRunDiscovery() {
    if (state.bulkRun.discoveryInterval) {
        clearInterval(state.bulkRun.discoveryInterval);
        state.bulkRun.discoveryInterval = null;
    }
}

function bindEvents() {
    els.btnSave.addEventListener('click', () => {
        syncStateFromInputs();
        persistState();
        showToast('Сохранено');
    });

    els.projectSelect.addEventListener('change', (e) => {
        const value = e.target.value;
        state.projectId = value || null;
        if (!state.projectId) {
            state.tests = [];
            state.totalTests = 0;
            renderTests();
            return;
        }
        loadTests();
    });

    if (els.btnLoadProjects) {
        els.btnLoadProjects.addEventListener('click', loadProjects);
    }
    if (els.btnLoadTests) {
        els.btnLoadTests.addEventListener('click', loadTests);
    }
    els.search.addEventListener('input', renderTests);
    els.btnClearRuns.addEventListener('click', clearRuns);

    els.toggleGh.addEventListener('click', () => togglePassword(els.ghToken, els.toggleGh));
    if (els.btnRunSelected) {
        els.btnRunSelected.addEventListener('click', startSelectedRuns);
    }
    if (els.btnStopSelected) {
        els.btnStopSelected.addEventListener('click', stopSelectedRuns);
    }
}

function init() {
    loadStoredState();
    hydrateForm();
    bindEvents();
    loadProjects();
    renderTests();
    renderRuns();
}

init();
