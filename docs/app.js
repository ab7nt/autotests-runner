const API_BASE = 'https://app.testiny.io/api/v1';
const STORAGE_KEY = 'testiny-gh-launcher-v1';
const DEFAULTS = {
    repo: 'ab7nt/HelloPrintAutotests',
    branch: 'main',
    workflow: 'testiny-run.yml',
    environment: 'staging',
};

const els = {
    testinyKey: document.getElementById('testiny-key'),
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
    toggleTestiny: document.getElementById('toggle-testiny-visibility'),
    toggleGh: document.getElementById('toggle-gh-visibility'),
};

const state = {
    testinyKey: '',
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
        payload.testinyKey = state.testinyKey;
        payload.ghToken = state.ghToken;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function hydrateForm() {
    els.testinyKey.value = state.testinyKey;
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

function requireTokens() {
    if (!state.testinyKey) throw new Error('Добавьте Testiny API key.');
    if (!state.ghToken) throw new Error('Добавьте GitHub token.');
    if (!state.repo) throw new Error('Укажите репозиторий owner/repo.');
}

async function testinyRequest(path, body) {
    if (!state.testinyKey) throw new Error('Сначала введите Testiny API key.');
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': state.testinyKey,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Testiny ${res.status}: ${text}`);
    }

    return res.json();
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
    els.testsMeta.textContent = `Показано ${visible} • Авто ${autoCount}/${total}`;
}

function renderTests() {
    const query = els.search.value.trim().toLowerCase();
    els.testsContainer.innerHTML = '';
    let items = state.tests;

    if (query) {
        items = items.filter((t) => t.title.toLowerCase().includes(query));
    }

    if (!items.length) {
        els.testsEmpty.style.display = 'block';
        updateTestsMeta(0);
        return;
    }
    els.testsEmpty.style.display = 'none';

    items.forEach((test) => {
        const automated = isAutomated(test);
        const card = document.createElement('div');
        card.className = `test ${automated ? '' : 'disabled'}`;

        const title = document.createElement('p');
        title.className = `test__title ${automated ? '' : 'muted'}`;
        title.textContent = test.title;

        const footer = document.createElement('div');
        footer.className = 'test__footer';

        const badge = document.createElement('span');
        badge.className = `pill ${automated ? 'ok' : 'neutral'}`;
        badge.textContent = automated ? 'automated' : 'muted';

        const btn = document.createElement('button');
        btn.textContent = automated ? 'Запустить' : 'Нет автотеста';
        btn.className = automated ? 'primary' : 'ghost';
        btn.disabled = !automated;
        btn.addEventListener('click', () => startRun(test));

        footer.append(badge, btn);
        card.append(title, footer);
        els.testsContainer.appendChild(card);
    });

    updateTestsMeta(items.length);
}

function isAutomated(test) {
    const val = (test.automation || '').toString().toLowerCase();
    return val.includes('automated') || val === 'auto';
}

async function loadProjects() {
    setLoading(els.btnLoadProjects, true, '...'); // loading state
    try {
        const body = {
            pagination: { limit: 200 },
            order: [{ col: 'name', dir: 'asc' }],
            includeDeleted: false,
            includeTotalCount: true,
        };
        const data = await testinyRequest('/project/find', body);
        state.projects = data.data || [];
        renderProjects();
        showToast('Проекты обновлены');
    } catch (e) {
        console.error(e);
        showToast(e.message);
    } finally {
        setLoading(els.btnLoadProjects, false);
    }
}

async function loadTests() {
    if (!state.projectId) {
        showToast('Выберите проект.');
        return;
    }
    setLoading(els.btnLoadTests, true, '...');
    try {
        const body = {
            filter: { project_id: Number(state.projectId) },
            pagination: { limit: 500 },
            order: [{ col: 'title', dir: 'asc' }],
            includeDeleted: false,
            includeTotalCount: true,
        };

        const data = await testinyRequest('/testcase/find', body);
        state.tests = data.data || [];
        state.totalTests = data.meta?.totalCount || state.tests.length;
        renderTests();
        if (state.totalTests > state.tests.length) {
            showToast(`Показаны первые ${state.tests.length} из ${state.totalTests}`);
        } else {
            showToast('Тесты загружены');
        }
    } catch (e) {
        console.error(e);
        showToast(e.message);
    } finally {
        setLoading(els.btnLoadTests, false);
    }
}

async function startRun(test) {
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
        state.testinyKey = els.testinyKey.value.trim();
        state.ghToken = els.ghToken.value.trim();
        state.repo = els.repo.value.trim() || DEFAULTS.repo;
        state.branch = els.branch.value.trim() || DEFAULTS.branch;
        state.workflow = els.workflow.value.trim() || DEFAULTS.workflow;
        state.environment = els.environment.value.trim() || DEFAULTS.environment;
        state.remember = els.remember.checked;
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

    els.toggleTestiny.addEventListener('click', () => togglePassword(els.testinyKey, els.toggleTestiny));
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
