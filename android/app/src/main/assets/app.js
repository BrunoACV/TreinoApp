/* TreinoFit — lógica do app (JS puro, 100% offline) */

(function () {
    'use strict';

    const CATEGORIES = [
        'Todos', 'Peitoral', 'Costas', 'Pernas', 'Glúteos', 'Ombros',
        'Bíceps', 'Tríceps', 'Trapézio', 'Panturrilhas', 'Antebraços',
        'Eretor Lombar', 'Calistenia', 'Cardio', 'Funcional e HIT', 'Mobilidade', 'Crossfit'
    ];
    const EQUIPMENTS = ['Barra', 'Halteres', 'Cabo / Polia', 'Máquina', 'Peso Corporal', 'Elástico / Faixa', 'Smith', 'Kettlebell', 'Rolo de Espuma'];
    const ACTIVE_KEY = 'treinofit_active';
    const ACTIVE_MAX_AGE_MS = 12 * 3600 * 1000; // treino esquecido aberto não volta no dia seguinte

    const state = {
        exercises: [],
        filteredExercises: [],
        presets: [],
        customWorkouts: [],
        favorites: new Set(),
        history: [],
        settings: { keepScreen: true, vibration: true, sound: true },
        currentView: 'view-workouts',
        selectedCategory: 'Todos',
        selectedEquipment: '',
        searchQuery: '',
        pageIndex: 0,
        pageSize: 30,

        activeWorkout: null,
        activeExerciseIndex: 0,
        activeWorkoutStartTime: null,
        restEndsAt: 0,
        restTotalMs: 0,
        tickInterval: null,

        editingWorkout: null
    };

    // Versão do app no endereço de tudo que é buscado: depois de atualizar, nada vem do cache antigo
    const V = new URL(document.currentScript.src).searchParams.get('v') || '0';
    const asset = (name) => `${name}?v=${V}`;

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const gifUrl = (file) => `/gifs/${encodeURIComponent(file)}`;
    // Miniatura estática (poucos KB): as listas não carregam GIF animado de 2-3 MB
    const thumbUrl = (file) => `/thumbs/${encodeURIComponent(String(file).replace(/\.gif$/i, '.webp'))}?v=${V}`;
    const thumbImg = (file, alt = '') => `<img src="${thumbUrl(file)}" alt="${esc(alt)}" loading="lazy" onerror="this.style.visibility='hidden'">`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const clock = (secs) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    const gifOf = (item) => item.gif_file || `${item.name}.gif`;
    const newExerciseItem = (ex) => ({
        name: ex.name,
        gif_file: gifOf(ex),
        category: ex.category,
        series: 3,
        reps: '10-12',
        rest: 60,
        notes: ''
    });

    // --- Som (só fora do Android; no aparelho quem avisa é o serviço nativo) ---
    const AudioService = {
        ctx: null,
        beep(freq = 880, duration = 0.15) {
            if (!state.settings.sound) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!this.ctx && Ctx) this.ctx = new Ctx();
                if (!this.ctx) return;
                if (this.ctx.state === 'suspended') this.ctx.resume();
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
                gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start();
                osc.stop(this.ctx.currentTime + duration);
            } catch (_) {}
        }
    };

    // --- Ponte nativa ---
    const A = window.Android;
    const call = (name, ...args) => {
        if (A && A[name]) {
            try { return A[name](...args); } catch (e) { console.error(`Android.${name}:`, e); }
        }
        return null;
    };
    const Native = {
        has: !!A,
        vibrate(ms) {
            if (!state.settings.vibration) return;
            if (A) call('vibrate', ms); else if (navigator.vibrate) navigator.vibrate(ms);
        },
        keepScreenOn(enable) { call('keepScreenOn', !!(enable && state.settings.keepScreen)); },
        json(name) { try { return JSON.parse(call(name)); } catch (_) { return null; } },
        // Tempos vão como texto: epoch em ms não cabe em int na ponte
        workoutStart(title, startedAt) { call('workoutStart', title, String(startedAt)); },
        workoutRest(endsAt) { call('workoutRest', String(endsAt), state.settings.vibration, state.settings.sound); },
        workoutStop() { call('workoutStop'); }
    };

    // --- Persistência em duas camadas (SharedPreferences nativo + localStorage) ---
    const Storage = {
        get(key) {
            const nativeVal = call('loadData', key);
            if (nativeVal) return nativeVal;
            try { return localStorage.getItem(key); } catch (_) { return null; }
        },
        set(key, value) {
            const str = typeof value === 'string' ? value : JSON.stringify(value);
            try { localStorage.setItem(key, str); } catch (_) {}
            call('saveData', key, str);
        },
        remove(key) {
            try { localStorage.removeItem(key); } catch (_) {}
            call('removeData', key);
        }
    };

    // --- Avisos e confirmações do próprio app (nada de caixa padrão do Android) ---
    let toastTimer;
    function toast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    }

    const modalStack = [];
    function openModal(id) {
        const el = $(id);
        clearTimeout(el._closeTimer);
        el.classList.remove('closing');
        el.classList.add('active');
        if (!modalStack.includes(id)) modalStack.push(id);
    }
    function closeModal(id) {
        const i = modalStack.indexOf(id);
        if (i < 0) return;
        modalStack.splice(i, 1);
        const el = $(id);
        el.classList.add('closing');
        el._closeTimer = setTimeout(() => el.classList.remove('active', 'closing'), 180);
    }

    let confirmResolve = null;
    function ask(title, text = '', okLabel = 'Confirmar', danger = false) {
        return new Promise(resolve => {
            $('confirm-title').textContent = title;
            $('confirm-text').textContent = text;
            $('confirm-text').hidden = !text;
            const ok = $('confirm-ok');
            ok.textContent = okLabel;
            ok.className = `btn grow ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
            confirmResolve = resolve;
            openModal('modal-confirm');
        });
    }
    function settleConfirm(value) {
        if (!confirmResolve) return;
        const resolve = confirmResolve;
        confirmResolve = null;
        closeModal('modal-confirm');
        resolve(value);
    }

    // Folha com lista de opções; devolve o valor escolhido (ou undefined se fechar)
    let optionsResolve = null;
    function pickOption(title, options, current) {
        return new Promise(resolve => {
            $('options-title').textContent = title;
            const list = $('options-list');
            list.innerHTML = '';
            options.forEach(opt => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `option ${opt.value === current ? 'active' : ''}`;
                btn.innerHTML = `<span>${esc(opt.label)}</span>${opt.hint ? `<small>${esc(opt.hint)}</small>` : ''}`;
                btn.addEventListener('click', () => settleOptions(opt.value));
                list.appendChild(btn);
            });
            optionsResolve = resolve;
            openModal('modal-options');
        });
    }
    function settleOptions(value) {
        if (!optionsResolve) return;
        const resolve = optionsResolve;
        optionsResolve = null;
        closeModal('modal-options');
        resolve(value);
    }

    // --- Tema (claro/escuro/sistema) e cor de destaque ---
    const ThemeService = {
        scheme: 'system', // system | dark | light
        palette: 'brand', // brand | dynamic | bw
        systemDark: true,
        dynamicColors: null,

        init() {
            this.dynamicColors = Native.json('getDynamicColors');
            const sys = call('isSystemDark');
            this.systemDark = sys === null ? !matchMedia('(prefers-color-scheme: light)').matches : !!sys;
            this.scheme = Storage.get('treinofit_theme_scheme') || 'system';
            this.palette = Storage.get('treinofit_theme_mode') || 'brand';

            this.bindSegmented('setting-theme-scheme', 'scheme', 'treinofit_theme_scheme');
            this.bindSegmented('setting-theme-palette', 'palette', 'treinofit_theme_mode');
            this.apply();
        },

        dynamicSupported() { return !!(this.dynamicColors && this.dynamicColors.supported); },

        bindSegmented(id, prop, key) {
            $(id).addEventListener('click', (e) => {
                const value = e.target.dataset.value;
                if (!value) return;
                this[prop] = value;
                Storage.set(key, value);
                this.apply();
            });
        },

        apply() {
            const root = document.documentElement;
            const dark = this.scheme === 'system' ? this.systemDark : this.scheme === 'dark';
            const dynamic = this.palette === 'dynamic' && this.dynamicSupported();
            root.dataset.theme = dark ? 'dark' : 'light';
            root.dataset.palette = dynamic ? 'dynamic' : (this.palette === 'bw' ? 'bw' : 'brand');
            if (dynamic) {
                root.style.setProperty('--dyn-light', this.dynamicColors.accentLight);
                root.style.setProperty('--dyn-dark', this.dynamicColors.accentDark);
            }
            call('setBars', dark);

            document.querySelectorAll('#setting-theme-scheme button').forEach(b => b.classList.toggle('active', b.dataset.value === this.scheme));
            document.querySelectorAll('#setting-theme-palette button').forEach(b => b.classList.toggle('active', b.dataset.value === this.palette));
            $('setting-theme-desc').textContent = {
                brand: 'Laranja do TreinoFit.',
                bw: 'Preto e branco, alto contraste.',
                dynamic: dynamic ? 'Acompanha a cor do seu Android.' : 'Disponível a partir do Android 12.'
            }[this.palette];
        }
    };

    window.__receiveAndroidDynamicColors = function (colors) {
        if (colors && colors.supported) {
            ThemeService.dynamicColors = colors;
            ThemeService.apply();
        }
    };
    window.__systemTheme = function (dark) {
        ThemeService.systemDark = !!dark;
        ThemeService.apply();
    };

    // --- Dados salvos ---
    function loadPersistedData() {
        const read = (key, apply) => {
            try {
                const raw = Storage.get(key);
                if (raw) apply(JSON.parse(raw));
            } catch (e) {
                console.error('Erro ao ler', key, e); // um dado ruim não derruba os outros
            }
        };
        read('treinofit_favs', v => { state.favorites = new Set(v); });
        read('treinofit_custom_workouts', v => { if (Array.isArray(v)) state.customWorkouts = v; });
        read('treinofit_history', v => { if (Array.isArray(v)) state.history = v; });
        read('treinofit_settings', v => { state.settings = { ...state.settings, ...v }; });
    }

    function saveCustomWorkouts() {
        Storage.set('treinofit_custom_workouts', state.customWorkouts);
        renderCustomWorkouts();
        scheduleBackup();
    }
    function saveFavorites() {
        Storage.set('treinofit_favs', [...state.favorites]);
        updateFavoritesBadge();
        scheduleBackup();
    }
    function saveHistory() {
        Storage.set('treinofit_history', state.history);
        renderHistory();
        renderHomeStats();
        scheduleBackup();
    }

    // --- Cópia de segurança fora do app (Downloads/TreinoFit): sobrevive a reinstalação ---
    const backupPayload = () => JSON.stringify({
        app: 'TreinoFit',
        version: 1,
        exportedAt: new Date().toISOString(),
        customWorkouts: state.customWorkouts,
        history: state.history,
        favorites: [...state.favorites],
        settings: state.settings
    });

    let backupTimer;
    function scheduleBackup() {
        clearTimeout(backupTimer);
        backupTimer = setTimeout(() => call('exportBackup', backupPayload()), 1500);
    }

    // União por id; o que vem do arquivo vence (é a cópia que a pessoa escolheu restaurar)
    function mergeById(current, incoming) {
        const map = new Map(current.map(x => [x.id, x]));
        (incoming || []).forEach(x => { if (x && x.id) map.set(x.id, x); });
        return [...map.values()];
    }

    window.__importBackup = function (text) {
        try {
            const b = JSON.parse(text);
            if (!b || (!Array.isArray(b.customWorkouts) && !Array.isArray(b.history))) throw new Error('formato');
            state.customWorkouts = mergeById(state.customWorkouts, b.customWorkouts).filter(w => Array.isArray(w.exercises));
            state.history = mergeById(state.history, b.history).sort((x, y) => String(y.date).localeCompare(String(x.date)));
            (b.favorites || []).forEach(f => state.favorites.add(f));
            saveCustomWorkouts();
            saveHistory();
            saveFavorites();
            renderFavorites();
            toast(`Importado: ${plural(state.customWorkouts.length, 'treino', 'treinos')} e ${plural(state.history.length, 'registro', 'registros')}`);
        } catch (e) {
            console.error('Backup inválido', e);
            toast('Esse arquivo não é um backup do TreinoFit.');
        }
    };

    // Treinos que vêm embutidos no app: entram só os que ainda não existem (por id)
    async function addDefaultWorkouts() {
        const defaults = await (await fetch(asset('default_custom_workouts.json'))).json();
        const have = new Set(state.customWorkouts.map(w => w.id));
        const missing = defaults.filter(w => !have.has(w.id));
        state.customWorkouts.push(...missing);
        return missing.length;
    }

    // --- Início ---
    async function init() {
        loadPersistedData();
        ThemeService.init();
        setupNavigation();
        setupSearchAndFilters();
        setupSettingsControls();
        setupModals();
        setupPlayer();
        setupAndroidBackHandler();
        renderHomeHeader();

        try {
            const [exRes, preRes] = await Promise.all([fetch(asset('exercises.json')), fetch(asset('presets.json'))]);
            state.exercises = await exRes.json();
            state.presets = await preRes.json();

            let updated = false;
            if (!Storage.get('treinofit_defaults_seeded')) {
                try {
                    if (await addDefaultWorkouts()) updated = true;
                    Storage.set('treinofit_defaults_seeded', '1');
                } catch (e) {
                    console.error('Treinos embutidos indisponíveis', e);
                }
            }
            // Treinos antigos sem gif_file/categoria ganham os dados do catálogo
            state.customWorkouts.forEach(w => (w.exercises || []).forEach(item => {
                if (!item.gif_file) { fillFromCatalog(item); updated = true; }
            }));
            if (updated) saveCustomWorkouts();

            setupCategoryChips('category-chips', () => state.selectedCategory, (cat) => {
                state.selectedCategory = cat;
                applyExerciseFilters();
            });
            applyExerciseFilters();
            renderPresetWorkouts();
            renderCustomWorkouts();
            renderHistory();
            renderHomeStats();
            updateFavoritesBadge();
            restoreActiveWorkout();
            scheduleBackup(); // já na primeira abertura fica uma cópia fora do app
        } catch (err) {
            console.error('Erro ao carregar dados iniciais:', err);
            toast('Erro ao carregar o banco de exercícios');
        }
    }

    function fillFromCatalog(item) {
        const match = state.exercises.find(ex => ex.name.toLowerCase() === item.name.toLowerCase());
        item.gif_file = match ? match.gif_file : `${item.name}.gif`;
        if (match) item.category = match.category;
    }

    // --- Navegação ---
    function setupNavigation() {
        document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });
        $('btn-create-workout-hero').addEventListener('click', () => openWorkoutEditor());
    }

    function switchView(viewId) {
        if (viewId === state.currentView) {
            $('main-scroll').scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        state.currentView = viewId;
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
        document.querySelectorAll('.bottom-nav .nav-item').forEach((b, i) => {
            const on = b.dataset.view === viewId;
            b.classList.toggle('active', on);
            if (on) $('nav-pill').style.setProperty('--i', i);
        });
        $('main-scroll').scrollTop = 0;

        if (viewId === 'view-workouts') { renderHomeHeader(); renderHomeStats(); }
        if (viewId === 'view-favorites') renderFavorites();
        if (viewId === 'view-history') renderHistory();
    }

    function setupAndroidBackHandler() {
        window.__onBack = function () {
            const top = modalStack[modalStack.length - 1];
            if (top === 'modal-confirm') { settleConfirm(false); return true; }
            if (top === 'modal-options') { settleOptions(undefined); return true; }
            if (top) { closeModal(top); return true; }
            if ($('modal-workout-player').classList.contains('active')) {
                confirmCancelWorkout();
                return true;
            }
            if (state.currentView !== 'view-workouts') {
                switchView('view-workouts');
                return true;
            }
            return false;
        };
    }

    // --- Início: saudação e números ---
    function renderHomeHeader() {
        const now = new Date();
        const h = now.getHours();
        $('home-greeting').textContent = h < 12 ? 'Bom dia.' : h < 18 ? 'Boa tarde.' : 'Boa noite.';
        $('home-date').textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' }).replace('.', '');
    }

    function renderHomeStats() {
        const now = new Date();
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
        $('home-stat-week').textContent = state.history.filter(hh => new Date(hh.date) >= monday).length;
        $('home-stat-total').textContent = state.history.length;
        const last = state.history[0];
        if (!last) { $('home-stat-last').textContent = '—'; return; }
        const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(new Date(last.date).toDateString())) / 86400000);
        $('home-stat-last').textContent = days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `${days} dias`;
    }

    // --- Filtros de exercício ---
    function setupCategoryChips(containerId, getCurrent, onPick) {
        const container = $(containerId);
        container.innerHTML = '';
        CATEGORIES.forEach(cat => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `chip ${cat === getCurrent() ? 'active' : ''}`;
            chip.textContent = cat;
            chip.addEventListener('click', () => {
                container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                onPick(cat);
            });
            container.appendChild(chip);
        });
    }

    function setupSearchAndFilters() {
        const searchInput = $('exercise-search-input');
        const clearBtn = $('clear-search-btn');

        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim().toLowerCase();
            clearBtn.hidden = !state.searchQuery;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(applyExerciseFilters, 160);
        });
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            state.searchQuery = '';
            clearBtn.hidden = true;
            applyExerciseFilters();
        });
        $('btn-equipment').addEventListener('click', async () => {
            const options = [{ value: '', label: 'Todos os equipamentos' }, ...EQUIPMENTS.map(e => ({ value: e, label: e }))];
            const picked = await pickOption('Equipamento', options, state.selectedEquipment);
            if (picked === undefined) return;
            state.selectedEquipment = picked;
            $('btn-equipment').textContent = `Equipamento: ${picked ? picked.toLowerCase() : 'todos'}`;
            applyExerciseFilters();
        });

        // Rolagem infinita: quem rola é o miolo, não a página
        const scroller = $('main-scroll');
        scroller.addEventListener('scroll', () => {
            if (state.currentView !== 'view-exercises') return;
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 600) appendNextExercisesPage();
        }, { passive: true });
    }

    function applyExerciseFilters() {
        let result = state.exercises;
        if (state.selectedCategory !== 'Todos') result = result.filter(ex => ex.category === state.selectedCategory);
        if (state.selectedEquipment) result = result.filter(ex => ex.equipments && ex.equipments.includes(state.selectedEquipment));
        if (state.searchQuery) {
            result = result.filter(ex => ex.name.toLowerCase().includes(state.searchQuery) || ex.category.toLowerCase().includes(state.searchQuery));
        }

        state.filteredExercises = result;
        state.pageIndex = 0;
        $('filter-result-count').textContent = result.length;
        $('exercises-grid').innerHTML = '';
        appendNextExercisesPage();
    }

    function appendNextExercisesPage() {
        const start = state.pageIndex * state.pageSize;
        const batch = state.filteredExercises.slice(start, start + state.pageSize);
        const fragment = document.createDocumentFragment();
        batch.forEach(ex => fragment.appendChild(createExerciseCard(ex)));
        $('exercises-grid').appendChild(fragment);
        if (batch.length) state.pageIndex++;
        $('infinite-scroll-sentinel').hidden = state.pageIndex * state.pageSize >= state.filteredExercises.length;
    }

    function createExerciseCard(exercise) {
        const card = document.createElement('div');
        card.className = 'exercise-card';
        const isFav = state.favorites.has(exercise.id);
        card.innerHTML = `
            <div class="media">${thumbImg(gifOf(exercise), exercise.name)}</div>
            <button class="fav-btn ${isFav ? 'active' : ''}">${isFav ? 'Salvo' : 'Salvar'}</button>
            <div class="exercise-card-info">
                <span class="eyebrow accent">${esc(exercise.category)}</span>
                <div class="exercise-card-name">${esc(exercise.name)}</div>
            </div>
        `;
        const favBtn = card.querySelector('.fav-btn');
        card.addEventListener('click', (e) => {
            if (e.target === favBtn) toggleFavorite(exercise.id, favBtn);
            else openExerciseDetail(exercise);
        });
        return card;
    }

    function toggleFavorite(id, btn) {
        const nowFav = !state.favorites.has(id);
        if (nowFav) state.favorites.add(id); else state.favorites.delete(id);
        btn.classList.toggle('active', nowFav);
        btn.textContent = nowFav ? 'Salvo' : 'Salvar';
        if (nowFav) Native.vibrate(30);
        saveFavorites();
    }

    function updateFavoritesBadge() {
        $('favorites-count-badge').textContent = plural(state.favorites.size, 'exercício salvo', 'exercícios salvos');
    }

    function renderFavorites() {
        const grid = $('favorites-grid');
        grid.innerHTML = '';
        const favs = state.exercises.filter(ex => state.favorites.has(ex.id));
        updateFavoritesBadge();
        $('favorites-empty-state').hidden = favs.length > 0;
        favs.forEach(ex => grid.appendChild(createExerciseCard(ex)));
    }

    // --- Listas de treinos ---
    function workoutSummaryHtml(w) {
        const list = w.exercises || [];
        const sets = list.reduce((n, e) => n + (parseInt(e.series) || 3), 0);
        // estimativa: ~40 s por série + o descanso combinado
        const mins = Math.round(list.reduce((n, e) => n + (parseInt(e.series) || 3) * (40 + (parseInt(e.rest) || 0)), 0) / 60);
        const thumbs = list.slice(0, 4).map(e => `<div class="media">${thumbImg(gifOf(e))}</div>`).join('');
        const more = list.length > 4 ? `<span class="more">+${list.length - 4}</span>` : '';
        return `
            <div class="thumb-strip">${thumbs}${more}</div>
            <div class="card-title">${esc(w.title)}</div>
            ${w.description ? `<p class="card-desc">${esc(w.description)}</p>` : ''}
            <div class="card-meta">
                <span class="pill">${plural(list.length, 'exercício', 'exercícios')}</span>
                <span class="pill">${plural(sets, 'série', 'séries')}</span>
                <span class="pill">~${mins} min</span>
            </div>
        `;
    }

    function renderPresetWorkouts() {
        const container = $('preset-workouts-list');
        $('preset-count-badge').textContent = plural(state.presets.length, 'modelo', 'modelos');
        container.innerHTML = '';

        state.presets.forEach(preset => {
            const card = document.createElement('article');
            card.className = 'card';
            card.innerHTML = `
                ${workoutSummaryHtml(preset)}
                <div class="card-actions">
                    <button class="btn btn-primary grow" data-act="start">Iniciar</button>
                    <button class="btn btn-outline" data-act="copy">Copiar</button>
                </div>
            `;
            card.querySelector('[data-act="start"]').addEventListener('click', () => startWorkout(preset));
            card.querySelector('[data-act="copy"]').addEventListener('click', () => clonePresetToCustom(preset));
            container.appendChild(card);
        });
    }

    function clonePresetToCustom(preset) {
        state.customWorkouts.unshift({
            id: 'custom_' + Date.now(),
            title: `${preset.title} (cópia)`,
            category: 'Personalizado',
            description: preset.description || '',
            exercises: JSON.parse(JSON.stringify(preset.exercises))
        });
        saveCustomWorkouts();
        $('main-scroll').scrollTo({ top: 0, behavior: 'smooth' });
        toast('Copiado para os seus treinos');
    }

    function renderCustomWorkouts() {
        const container = $('custom-workouts-list');
        container.innerHTML = '';

        if (state.customWorkouts.length === 0) {
            container.innerHTML = `<div class="empty-state small"><h3>Nenhum treino seu ainda</h3><p>Crie um em "Novo treino" ou copie um modelo pronto.</p></div>`;
            return;
        }

        state.customWorkouts.forEach((w) => {
            const card = document.createElement('article');
            card.className = 'card';
            card.innerHTML = `
                ${workoutSummaryHtml(w)}
                <div class="card-actions">
                    <button class="btn btn-primary grow" data-act="start">Iniciar treino</button>
                    <button class="btn btn-quiet" data-act="edit">Editar</button>
                    <button class="btn btn-quiet danger" data-act="delete">Excluir</button>
                </div>
            `;
            card.querySelector('[data-act="start"]').addEventListener('click', () => startWorkout(w));
            card.querySelector('[data-act="edit"]').addEventListener('click', () => openWorkoutEditor(w));
            card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
                if (await ask('Excluir este treino?', `"${w.title}" sai da sua lista. O histórico continua.`, 'Excluir', true)) {
                    state.customWorkouts = state.customWorkouts.filter(x => x !== w);
                    saveCustomWorkouts();
                }
            });
            container.appendChild(card);
        });
    }

    // --- Editor de treino ---
    function openWorkoutEditor(workoutToEdit = null) {
        state.editingWorkout = workoutToEdit ? JSON.parse(JSON.stringify(workoutToEdit)) : {
            id: 'custom_' + Date.now(),
            title: '',
            description: '',
            exercises: []
        };
        const exists = state.customWorkouts.some(w => w.id === state.editingWorkout.id);
        $('workout-editor-title').textContent = exists ? 'Editar treino' : 'Novo treino';
        $('editor-workout-name').value = state.editingWorkout.title || '';
        $('editor-workout-desc').value = state.editingWorkout.description || '';
        renderEditorExerciseList();
        openModal('modal-workout-editor');
    }

    function renderEditorExerciseList() {
        const container = $('editor-exercises-list');
        const list = state.editingWorkout.exercises;
        container.innerHTML = '';
        $('editor-empty-state').hidden = list.length > 0;

        list.forEach((item, idx) => {
            if (!item.gif_file) fillFromCatalog(item);
            const el = document.createElement('div');
            el.className = 'card';
            el.innerHTML = `
                <div class="editor-item-top">
                    <div class="media thumb">${thumbImg(item.gif_file)}</div>
                    <div class="row-item-info">
                        <span class="eyebrow accent">${esc(item.category || 'Geral')}</span>
                        <div class="row-item-title">${idx + 1}. ${esc(item.name)}</div>
                    </div>
                </div>
                <div class="editor-item-inputs">
                    <label>Séries<input type="number" inputmode="numeric" class="form-input" data-f="series" value="${esc(item.series || 3)}" min="1" max="20"></label>
                    <label>Repetições<input type="text" class="form-input" data-f="reps" value="${esc(item.reps || '10-12')}"></label>
                    <label>Descanso (s)<input type="number" inputmode="numeric" class="form-input" data-f="rest" value="${esc(item.rest ?? 60)}" min="0" step="5"></label>
                </div>
                <div class="card-actions">
                    <button class="btn btn-sm btn-outline grow" data-act="up" ${idx === 0 ? 'disabled' : ''}>Subir</button>
                    <button class="btn btn-sm btn-outline grow" data-act="down" ${idx === list.length - 1 ? 'disabled' : ''}>Descer</button>
                    <button class="btn btn-sm btn-quiet danger" data-act="remove">Remover</button>
                </div>
            `;

            el.querySelectorAll('[data-f]').forEach(input => input.addEventListener('input', () => {
                const f = input.dataset.f;
                if (f === 'series') item.series = Math.min(20, Math.max(1, parseInt(input.value) || 3));
                if (f === 'reps') item.reps = input.value.trim() || '10-12';
                if (f === 'rest') item.rest = Math.max(0, parseInt(input.value) || 0);
            }));

            const move = (delta) => {
                [list[idx], list[idx + delta]] = [list[idx + delta], list[idx]];
                renderEditorExerciseList();
            };
            el.querySelector('[data-act="up"]').addEventListener('click', () => move(-1));
            el.querySelector('[data-act="down"]').addEventListener('click', () => move(1));
            el.querySelector('[data-act="remove"]').addEventListener('click', () => {
                list.splice(idx, 1);
                renderEditorExerciseList();
            });
            container.appendChild(el);
        });
    }

    function saveEditingWorkout() {
        const nameInput = $('editor-workout-name');
        const title = nameInput.value.trim();
        if (!title) {
            toast('Dê um nome ao treino.');
            nameInput.focus();
            return;
        }
        if (state.editingWorkout.exercises.length === 0) {
            toast('Adicione pelo menos 1 exercício.');
            return;
        }
        state.editingWorkout.title = title;
        state.editingWorkout.description = $('editor-workout-desc').value.trim();

        const i = state.customWorkouts.findIndex(w => w.id === state.editingWorkout.id);
        if (i !== -1) state.customWorkouts[i] = state.editingWorkout;
        else state.customWorkouts.push(state.editingWorkout);

        saveCustomWorkouts();
        closeModal('modal-workout-editor');
        toast('Treino salvo');
    }

    // --- Seletor de exercício (dentro do editor) ---
    let pickerCategory = 'Todos';
    let pickerSearch = '';

    function openExercisePicker() {
        $('picker-search-input').value = '';
        pickerSearch = '';
        pickerCategory = 'Todos';
        setupCategoryChips('picker-category-chips', () => pickerCategory, (cat) => {
            pickerCategory = cat;
            renderPickerList();
        });
        renderPickerList();
        openModal('modal-exercise-picker');
    }

    function renderPickerList() {
        const container = $('picker-exercises-list');
        container.innerHTML = '';

        const filtered = state.exercises.filter(ex => {
            const matchCat = pickerCategory === 'Todos' || ex.category === pickerCategory;
            const matchText = !pickerSearch ||
                ex.name.toLowerCase().includes(pickerSearch) ||
                (ex.category && ex.category.toLowerCase().includes(pickerSearch)) ||
                (ex.equipments && ex.equipments.some(eq => eq.toLowerCase().includes(pickerSearch)));
            return matchCat && matchText;
        });

        $('picker-count-badge').textContent = filtered.length;
        $('picker-empty-state').hidden = filtered.length > 0;

        // shortcut: mostra os 80 primeiros; refine pela busca ou categoria. Paginar se incomodar.
        const fragment = document.createDocumentFragment();
        filtered.slice(0, 80).forEach(ex => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'card row-item';
            card.innerHTML = `
                <div class="media thumb">${thumbImg(gifOf(ex))}</div>
                <div class="row-item-info">
                    <span class="eyebrow accent">${esc(ex.category)}</span>
                    <div class="row-item-title">${esc(ex.name)}</div>
                    <span class="muted-small">${esc((ex.equipments || []).join(', ') || 'Peso corporal')}</span>
                </div>
            `;
            card.addEventListener('click', () => {
                state.editingWorkout.exercises.push(newExerciseItem(ex));
                renderEditorExerciseList();
                closeModal('modal-exercise-picker');
                toast('Exercício adicionado');
            });
            fragment.appendChild(card);
        });
        container.appendChild(fragment);
    }

    // --- Detalhe do exercício ---
    function openExerciseDetail(exercise) {
        $('detail-title').textContent = exercise.name;
        $('detail-description').textContent = exercise.description || '';
        $('detail-tags').textContent = exercise.category;
        $('detail-equipment').innerHTML = (exercise.equipments || []).map(eq => `<span class="pill">${esc(eq)}</span>`).join('');
        const img = $('detail-gif-img');
        img.src = thumbUrl(gifOf(exercise)); // aparece na hora; o GIF entra por cima quando carregar
        img.alt = exercise.name;
        const gif = new Image();
        gif.onload = () => { if (img.alt === exercise.name) img.src = gif.src; };
        gif.src = gifUrl(gifOf(exercise));
        $('btn-add-to-workout-modal').onclick = () => {
            closeModal('modal-exercise-detail');
            promptAddExerciseToWorkout(exercise);
        };
        openModal('modal-exercise-detail');
    }

    async function promptAddExerciseToWorkout(exercise) {
        const NEW = '__novo__';
        const options = state.customWorkouts.map(w => ({ value: w.id, label: w.title, hint: plural(w.exercises.length, 'exercício', 'exercícios') }));
        options.push({ value: NEW, label: 'Criar novo treino', hint: 'começa com este exercício' });
        const picked = await pickOption('Adicionar a qual treino?', options);
        if (picked === undefined) return;
        if (picked === NEW) {
            openWorkoutEditor({ id: 'custom_' + Date.now(), title: '', description: '', exercises: [newExerciseItem(exercise)] });
            return;
        }
        const w = state.customWorkouts.find(x => x.id === picked);
        w.exercises.push(newExerciseItem(exercise));
        saveCustomWorkouts();
        toast(`Adicionado a "${w.title}"`);
    }

    function setupModals() {
        $('btn-close-exercise-detail').addEventListener('click', () => closeModal('modal-exercise-detail'));
        $('btn-close-options').addEventListener('click', () => settleOptions(undefined));
        $('btn-cancel-workout-edit').addEventListener('click', () => closeModal('modal-workout-editor'));
        $('btn-open-exercise-picker').addEventListener('click', openExercisePicker);
        $('btn-close-exercise-picker').addEventListener('click', () => closeModal('modal-exercise-picker'));
        $('picker-search-input').addEventListener('input', (e) => {
            pickerSearch = e.target.value.trim().toLowerCase();
            renderPickerList();
        });
        $('btn-save-workout').addEventListener('click', saveEditingWorkout);
        $('btn-close-summary').addEventListener('click', () => closeModal('modal-workout-summary'));
        $('confirm-ok').addEventListener('click', () => settleConfirm(true));
        $('confirm-cancel').addEventListener('click', () => settleConfirm(false));
        $('btn-clear-history').addEventListener('click', async () => {
            if (await ask('Apagar todo o histórico?', 'Os registros de treinos concluídos somem. Seus treinos ficam.', 'Apagar', true)) {
                state.history = [];
                saveHistory();
            }
        });
        // Tocar fora fecha as folhas (não as telas cheias nem a confirmação)
        ['modal-exercise-detail', 'modal-options'].forEach(id => $(id).addEventListener('click', (e) => {
            if (e.target.id !== id) return;
            if (id === 'modal-options') settleOptions(undefined); else closeModal(id);
        }));
    }

    // ======================================================================
    // TREINO EM ANDAMENTO
    // Uma linha por exercício: "+" conta a série feita e dispara o descanso.
    // Tudo é salvo a cada toque: se o Android matar o app, o treino volta igual.
    // ======================================================================
    async function startWorkout(workout) {
        if (!workout.exercises || workout.exercises.length === 0) {
            toast('Este treino não tem exercícios.');
            return;
        }
        if (state.activeWorkout && !(await ask('Já existe um treino em andamento', 'Começar outro descarta o atual.', 'Começar outro'))) return;

        state.activeWorkout = JSON.parse(JSON.stringify(workout));
        state.activeExerciseIndex = 0;
        state.activeWorkoutStartTime = Date.now();
        state.restEndsAt = 0;
        state.activeWorkout.exercises.forEach(item => {
            if (!item.gif_file) fillFromCatalog(item);
            item.series = Math.max(1, parseInt(item.series) || 3);
            item.done = 0;
        });
        Native.vibrate(50);
        showPlayer();
        persistActive();
    }

    function restoreActiveWorkout() {
        try {
            const saved = JSON.parse(Storage.get(ACTIVE_KEY) || 'null');
            if (!saved || !saved.workout || Date.now() - saved.startTime > ACTIVE_MAX_AGE_MS) {
                if (saved) Storage.remove(ACTIVE_KEY);
                call('workoutStop');
                return;
            }
            saved.workout.exercises.forEach(item => {
                item.series = Math.max(1, parseInt(item.series) || 3);
                item.done = Math.min(item.series, Math.max(0, parseInt(item.done) || 0));
            });
            if (!saved.workout.exercises.length) throw new Error('treino salvo sem exercícios');
            state.activeWorkout = saved.workout;
            state.activeExerciseIndex = Math.min(saved.index || 0, saved.workout.exercises.length - 1);
            state.activeWorkoutStartTime = saved.startTime;
            state.restEndsAt = saved.restEndsAt > Date.now() ? saved.restEndsAt : 0;
            state.restTotalMs = saved.restTotalMs || 0;
            showPlayer();
        } catch (e) {
            console.error('Erro ao restaurar treino', e);
            closePlayer();
        }
    }

    function persistActive() {
        Storage.set(ACTIVE_KEY, {
            workout: state.activeWorkout,
            index: state.activeExerciseIndex,
            startTime: state.activeWorkoutStartTime,
            restEndsAt: state.restEndsAt,
            restTotalMs: state.restTotalMs
        });
    }

    function showPlayer() {
        Native.keepScreenOn(true);
        Native.workoutStart(state.activeWorkout.title, state.activeWorkoutStartTime);
        if (state.restEndsAt) Native.workoutRest(state.restEndsAt);
        $('modal-workout-player').classList.add('active');
        clearInterval(state.tickInterval);
        state.tickInterval = setInterval(tick, 500);
        renderActiveExercise();
    }

    // Os dois relógios saem do horário real: o app pode ficar parado em segundo plano sem atrasar
    function tick() {
        if (!state.activeWorkout) return;
        $('player-timer-elapsed').textContent = clock(Math.floor((Date.now() - state.activeWorkoutStartTime) / 1000));

        const resting = state.restEndsAt > 0;
        const leftMs = state.restEndsAt - Date.now();
        if (resting && leftMs <= 0) {
            state.restEndsAt = 0;
            persistActive();
            if (!Native.has) { // no aparelho o serviço nativo já vibrou e tocou
                Native.vibrate(450);
                AudioService.beep(1046, 0.25);
            }
        }
        const showTimer = state.restEndsAt > 0;
        $('player-rest-timer-box').hidden = !showTimer;
        $('player-rest-hint').hidden = showTimer;
        if (showTimer) {
            $('rest-timer-seconds').textContent = clock(Math.ceil(leftMs / 1000));
            $('rest-bar-fill').style.transform = `scaleX(${Math.max(0, Math.min(1, leftMs / (state.restTotalMs || leftMs)))})`;
        }
    }

    function setRest(endsAt) {
        state.restEndsAt = endsAt > Date.now() ? endsAt : 0;
        state.restTotalMs = Math.max(state.restTotalMs, state.restEndsAt - Date.now());
        if (!state.restEndsAt) state.restTotalMs = 0;
        Native.workoutRest(state.restEndsAt);
        persistActive();
        tick();
    }

    function renderActiveExercise() {
        const list = state.activeWorkout.exercises;
        const total = list.length;
        const idx = state.activeExerciseIndex;
        const current = list[idx];
        const doneAll = current.done >= current.series;
        const isLast = idx === total - 1;

        $('player-workout-name').textContent = state.activeWorkout.title;
        const setsTotal = list.reduce((n, e) => n + e.series, 0);
        const setsDone = list.reduce((n, e) => n + e.done, 0);
        $('player-progress-fill').style.width = `${(setsDone / setsTotal) * 100}%`;
        $('player-step-counter').textContent = `${idx + 1} de ${total}`;

        $('player-current-name').textContent = current.name;
        $('player-current-notes').textContent = current.notes || current.category || '';

        const img = $('player-current-gif');
        const src = gifUrl(current.gif_file);
        if (img.dataset.src !== src) { // não reinicia o GIF a cada toque no contador
            img.dataset.src = src;
            img.classList.remove('loaded');
            $('player-poster').src = thumbUrl(current.gif_file); // quadro parado na hora; o GIF entra quando carregar
            img.onload = () => img.classList.add('loaded');
            img.src = src;
            img.alt = current.name;
        }

        $('player-reps-target').textContent = `${current.reps || '10'} reps`;
        $('player-sets-done').textContent = current.done;
        $('player-sets-total').textContent = current.series;
        $('btn-set-minus').disabled = current.done === 0;
        $('btn-set-plus').disabled = doneAll;
        $('set-counter').classList.toggle('complete', doneAll);

        $('player-rest-hint').textContent = doneAll
            ? (isLast ? 'Último exercício concluído.' : 'Exercício concluído. Toque em Próximo.')
            : 'Terminou a série? Toque em + para contar e descansar.';

        $('btn-player-prev').disabled = idx === 0;
        const nextBtn = $('btn-player-next');
        nextBtn.textContent = isLast ? 'Concluir' : 'Próximo';
        nextBtn.classList.toggle('btn-primary', doneAll);
        nextBtn.classList.toggle('btn-outline', !doneAll);
        tick();
    }

    function changeSets(delta) {
        const list = state.activeWorkout.exercises;
        const current = list[state.activeExerciseIndex];
        const next = current.done + delta;
        if (next < 0 || next > current.series) return;
        current.done = next;
        Native.vibrate(40);

        const lastSetOfWorkout = state.activeExerciseIndex === list.length - 1 && next === current.series;
        const rest = parseInt(current.rest) || 0;
        // "+" inicia o descanso; "−" (toque errado) cancela
        state.restTotalMs = 0;
        setRest(delta > 0 && rest > 0 && !lastSetOfWorkout ? Date.now() + rest * 1000 : 0);
        renderActiveExercise();

        const value = document.querySelector('.set-counter-value');
        value.classList.remove('bump');
        void value.offsetWidth; // reinicia a animação
        value.classList.add('bump');
    }

    function goToExercise(delta) {
        const idx = state.activeExerciseIndex + delta;
        if (idx < 0) return;
        if (idx >= state.activeWorkout.exercises.length) {
            finishWorkoutSession();
            return;
        }
        state.activeExerciseIndex = idx;
        persistActive();
        renderActiveExercise();
    }

    async function confirmCancelWorkout() {
        if (await ask('Sair do treino?', 'O progresso desta sessão não vai para o histórico.', 'Sair', true)) closePlayer();
    }

    function setupPlayer() {
        $('btn-set-plus').addEventListener('click', () => changeSets(1));
        $('btn-set-minus').addEventListener('click', () => changeSets(-1));
        $('btn-player-prev').addEventListener('click', () => goToExercise(-1));
        $('btn-player-next').addEventListener('click', () => goToExercise(1));
        $('btn-player-finish').addEventListener('click', async () => {
            if (await ask('Finalizar o treino agora?', 'Ele entra no histórico com as séries feitas até aqui.', 'Finalizar')) finishWorkoutSession();
        });
        $('btn-minimize-player').addEventListener('click', confirmCancelWorkout);
        $('btn-timer-add30').addEventListener('click', () => setRest(state.restEndsAt + 30000));
        $('btn-timer-sub10').addEventListener('click', () => setRest(state.restEndsAt - 10000));
        $('btn-timer-skip').addEventListener('click', () => setRest(0));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    }

    function closePlayer() {
        clearInterval(state.tickInterval);
        $('modal-workout-player').classList.remove('active');
        Native.keepScreenOn(false);
        Native.workoutStop();
        Storage.remove(ACTIVE_KEY);
        state.activeWorkout = null;
        state.restEndsAt = 0;
        state.restTotalMs = 0;
    }

    function finishWorkoutSession() {
        const w = state.activeWorkout;
        const durationMins = Math.max(1, Math.round((Date.now() - state.activeWorkoutStartTime) / 60000));
        const completedSets = w.exercises.reduce((n, e) => n + (e.done || 0), 0);

        state.history.unshift({
            id: 'hist_' + Date.now(),
            date: new Date().toISOString(),
            workoutTitle: w.title,
            durationMins,
            exercisesCount: w.exercises.length,
            completedSets
        });
        saveHistory();
        closePlayer();
        Native.vibrate(200);

        $('summary-duration').textContent = `${durationMins}m`;
        $('summary-exercises').textContent = w.exercises.length;
        $('summary-sets').textContent = completedSets;
        openModal('modal-workout-summary');
    }

    // --- Histórico ---
    function renderHistory() {
        const list = $('history-list');
        list.innerHTML = '';
        $('history-empty-state').hidden = state.history.length > 0;
        $('btn-clear-history').hidden = state.history.length === 0;

        let totalSets = 0;
        let totalMinutes = 0;
        const fragment = document.createDocumentFragment();
        state.history.forEach(item => {
            totalSets += item.completedSets || 0;
            totalMinutes += item.durationMins || 0;
            const d = new Date(item.date);
            const row = document.createElement('div');
            row.className = 'card history-item';
            row.innerHTML = `
                <div class="date-block"><strong>${d.getDate()}</strong><span>${esc(d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''))}</span></div>
                <div class="grow">
                    <div class="card-title">${esc(item.workoutTitle)}</div>
                    <span class="muted-small">${item.durationMins || 0} min · ${plural(item.completedSets || 0, 'série', 'séries')} · ${plural(item.exercisesCount || 0, 'exercício', 'exercícios')}</span>
                </div>
            `;
            fragment.appendChild(row);
        });
        list.appendChild(fragment);

        $('stat-total-workouts').textContent = state.history.length;
        $('stat-total-sets').textContent = totalSets;
        $('stat-total-minutes').textContent = `${(totalMinutes / 60).toFixed(1)}h`;
    }

    // --- Ajustes ---
    function setupSettingsControls() {
        [['toggle-keep-screen', 'keepScreen'], ['toggle-vibration', 'vibration'], ['toggle-sound', 'sound']].forEach(([id, key]) => {
            const el = $(id);
            el.checked = state.settings[key];
            el.addEventListener('change', () => {
                state.settings[key] = el.checked;
                Storage.set('treinofit_settings', state.settings);
            });
        });

        $('btn-export-backup').addEventListener('click', () => {
            const where = call('exportBackup', backupPayload());
            toast(where ? `Backup salvo em ${where}` : (where === null ? 'Backup disponível só no aparelho.' : 'Não foi possível salvar o backup.'));
        });
        $('btn-import-backup').addEventListener('click', () => {
            if (call('pickBackup') === null) toast('Importação disponível só no aparelho.');
        });
        $('btn-restore-defaults').addEventListener('click', async () => {
            if (!(await ask('Restaurar treinos originais?', 'Os treinos que vieram com o app voltam para a sua lista. Nada seu é apagado.', 'Restaurar'))) return;
            try {
                const added = await addDefaultWorkouts();
                if (added) saveCustomWorkouts();
                toast(added ? `${plural(added, 'treino restaurado', 'treinos restaurados')}` : 'Todos os treinos originais já estão na lista.');
            } catch (e) {
                toast('Não foi possível restaurar.');
            }
        });
    }

    window.addEventListener('DOMContentLoaded', init);

    // Para inspeção e testes
    window.state = state;
    window.startWorkout = startWorkout;
})();
