/* TreinoFit — lógica do app (JS puro, 100% offline) */

(function () {
    'use strict';

    const CATEGORIES = [
        'Todos', 'Peitoral', 'Costas', 'Pernas', 'Glúteos', 'Ombros',
        'Bíceps', 'Tríceps', 'Trapézio', 'Panturrilhas', 'Antebraços',
        'Eretor Lombar', 'Calistenia', 'Cardio', 'Funcional e HIT', 'Mobilidade', 'Crossfit'
    ];
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
        pageSize: 24,

        activeWorkout: null,
        activeExerciseIndex: 0,
        activeWorkoutStartTime: null,
        restEndsAt: 0,
        tickInterval: null,

        currentModal: null,
        editingWorkout: null
    };

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const gifUrl = (file) => `/gifs/${encodeURIComponent(file)}`;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const clock = (secs) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    const newExerciseItem = (ex) => ({
        name: ex.name,
        gif_file: ex.gif_file || `${ex.name}.gif`,
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
        toast(msg) { if (call('toast', msg) === null && !A) console.log('[Toast]', msg); },
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

    // --- Tema (claro/escuro/sistema) e cor de destaque ---
    const ThemeService = {
        scheme: 'system', // system | dark | light
        palette: 'bw',    // bw | dynamic
        systemDark: true,
        dynamicColors: null,

        init() {
            this.dynamicColors = Native.json('getDynamicColors');
            const sys = call('isSystemDark');
            this.systemDark = sys === null ? !matchMedia('(prefers-color-scheme: light)').matches : !!sys;
            this.scheme = Storage.get('treinofit_theme_scheme') || 'system';
            this.palette = Storage.get('treinofit_theme_mode') || (this.dynamicSupported() ? 'dynamic' : 'bw');

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
            root.dataset.palette = dynamic ? 'dynamic' : 'bw';
            if (dynamic) {
                root.style.setProperty('--dyn-light', this.dynamicColors.accentLight);
                root.style.setProperty('--dyn-dark', this.dynamicColors.accentDark);
            }
            call('setBars', dark);

            document.querySelectorAll('#setting-theme-scheme button').forEach(b => b.classList.toggle('active', b.dataset.value === this.scheme));
            document.querySelectorAll('#setting-theme-palette button').forEach(b => b.classList.toggle('active', b.dataset.value === this.palette));
            $('setting-theme-desc').textContent = this.palette === 'bw'
                ? 'Monocromático, alto contraste.'
                : (dynamic ? 'Acompanha a cor do seu Android.' : 'Disponível a partir do Android 12.');
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
        try {
            const favs = Storage.get('treinofit_favs');
            if (favs) state.favorites = new Set(JSON.parse(favs));
            const workouts = Storage.get('treinofit_custom_workouts');
            if (workouts) state.customWorkouts = JSON.parse(workouts);
            const history = Storage.get('treinofit_history');
            if (history) state.history = JSON.parse(history);
            const settings = Storage.get('treinofit_settings');
            if (settings) state.settings = { ...state.settings, ...JSON.parse(settings) };
        } catch (e) {
            console.error('Erro ao ler persistência', e);
        }
    }

    function saveCustomWorkouts() {
        Storage.set('treinofit_custom_workouts', state.customWorkouts);
        renderCustomWorkouts();
    }
    function saveFavorites() {
        Storage.set('treinofit_favs', [...state.favorites]);
        updateFavoritesBadge();
    }
    function saveHistory() {
        Storage.set('treinofit_history', state.history);
        renderHistory();
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

        try {
            const [exRes, preRes] = await Promise.all([fetch('exercises.json'), fetch('presets.json')]);
            state.exercises = await exRes.json();
            state.presets = await preRes.json();

            // Treinos antigos sem gif_file/categoria ganham os dados do catálogo
            let updated = false;
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
            updateFavoritesBadge();
            restoreActiveWorkout();
        } catch (err) {
            console.error('Erro ao carregar dados iniciais:', err);
            Native.toast('Erro ao carregar o banco de exercícios');
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
        ['custom', 'preset'].forEach(kind => {
            $(`toggle-${kind}-workouts`).addEventListener('click', () => $(`section-${kind}-workouts`).classList.toggle('collapsed'));
        });
    }

    function switchView(viewId) {
        state.currentView = viewId;
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
        document.querySelectorAll('.bottom-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));
        $('main-scroll').scrollTop = 0;

        if (viewId === 'view-favorites') renderFavorites();
        if (viewId === 'view-history') renderHistory();
        if (viewId === 'view-settings') checkOfflineStatus();
    }

    function setupAndroidBackHandler() {
        window.__onBack = function () {
            if ($('modal-workout-player').classList.contains('active')) {
                confirmCancelWorkout();
                return true;
            }
            if (state.currentModal) {
                closeModal(state.currentModal);
                return true;
            }
            if (state.currentView !== 'view-workouts') {
                switchView('view-workouts');
                return true;
            }
            return false;
        };
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
            clearBtn.style.display = state.searchQuery ? 'block' : 'none';
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(applyExerciseFilters, 180);
        });
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            state.searchQuery = '';
            clearBtn.style.display = 'none';
            applyExerciseFilters();
        });
        $('equipment-select').addEventListener('change', (e) => {
            state.selectedEquipment = e.target.value;
            applyExerciseFilters();
        });

        // Rolagem infinita: quem rola é o miolo, não a página
        const scroller = $('main-scroll');
        scroller.addEventListener('scroll', () => {
            if (state.currentView !== 'view-exercises') return;
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 400) appendNextExercisesPage();
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
        $('infinite-scroll-sentinel').style.display = state.pageIndex * state.pageSize >= state.filteredExercises.length ? 'none' : 'block';
    }

    function createExerciseCard(exercise) {
        const card = document.createElement('div');
        card.className = 'exercise-card';
        const isFav = state.favorites.has(exercise.id);
        card.innerHTML = `
            <div class="gif-frame"><img src="${gifUrl(exercise.gif_file)}" alt="${esc(exercise.name)}" loading="lazy"></div>
            <button class="fav-btn ${isFav ? 'active' : ''}">${isFav ? 'Salvo' : 'Salvar'}</button>
            <div class="exercise-card-info">
                <span class="eyebrow">${esc(exercise.category)}</span>
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
        $('favorites-count-badge').textContent = plural(state.favorites.size, 'exercício', 'exercícios');
    }

    function renderFavorites() {
        const grid = $('favorites-grid');
        grid.innerHTML = '';
        const favs = state.exercises.filter(ex => state.favorites.has(ex.id));
        updateFavoritesBadge();
        $('favorites-empty-state').style.display = favs.length ? 'none' : 'flex';
        favs.forEach(ex => grid.appendChild(createExerciseCard(ex)));
    }

    // --- Listas de treinos ---
    function renderPresetWorkouts() {
        const container = $('preset-workouts-list');
        $('preset-count-badge').textContent = plural(state.presets.length, 'rotina', 'rotinas');
        container.innerHTML = '';

        state.presets.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <span class="eyebrow">${esc(preset.category)}</span>
                <div class="card-title">${esc(preset.title)}</div>
                <p class="card-desc">${esc(preset.description)}</p>
                <div class="card-meta"><span>${plural(preset.exercises.length, 'exercício', 'exercícios')}</span></div>
                <div class="card-actions">
                    <button class="btn btn-primary grow" data-act="start">Iniciar treino</button>
                    <button class="btn btn-ghost" data-act="copy">Copiar</button>
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
        $('section-custom-workouts').classList.remove('collapsed');
        $('main-scroll').scrollTop = 0;
        Native.toast('Treino copiado para as suas rotinas');
    }

    function renderCustomWorkouts() {
        const container = $('custom-workouts-list');
        $('custom-count-badge').textContent = plural(state.customWorkouts.length, 'rotina', 'rotinas');
        container.innerHTML = '';

        if (state.customWorkouts.length === 0) {
            container.innerHTML = `<div class="empty-state small"><p>Nenhuma rotina criada ainda. Toque em "Novo treino" ou copie uma predefinida.</p></div>`;
            return;
        }

        state.customWorkouts.forEach((w, index) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-title">${esc(w.title)}</div>
                ${w.description ? `<p class="card-desc">${esc(w.description)}</p>` : ''}
                <div class="card-meta"><span>${plural(w.exercises.length, 'exercício', 'exercícios')}</span></div>
                <div class="card-actions">
                    <button class="btn btn-primary grow" data-act="start">Iniciar</button>
                    <button class="btn btn-accent" data-act="edit">Editar</button>
                    <button class="btn btn-danger" data-act="delete">Excluir</button>
                </div>
            `;
            card.querySelector('[data-act="start"]').addEventListener('click', () => startWorkout(w));
            card.querySelector('[data-act="edit"]').addEventListener('click', () => openWorkoutEditor(w));
            card.querySelector('[data-act="delete"]').addEventListener('click', () => {
                if (confirm(`Excluir a rotina "${w.title}"?`)) {
                    state.customWorkouts.splice(index, 1);
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
        $('workout-editor-title').textContent = state.customWorkouts.some(w => w.id === state.editingWorkout.id) ? 'Editar treino' : 'Novo treino';
        $('editor-workout-name').value = state.editingWorkout.title || '';
        $('editor-workout-desc').value = state.editingWorkout.description || '';
        renderEditorExerciseList();
        openModal('modal-workout-editor');
    }

    function renderEditorExerciseList() {
        const container = $('editor-exercises-list');
        const list = state.editingWorkout.exercises;
        container.innerHTML = '';
        $('editor-empty-state').style.display = list.length ? 'none' : 'flex';

        list.forEach((item, idx) => {
            if (!item.gif_file) fillFromCatalog(item);
            const el = document.createElement('div');
            el.className = 'card';
            el.innerHTML = `
                <div class="editor-item-top">
                    <div class="gif-frame thumb"><img src="${gifUrl(item.gif_file)}" alt="" loading="lazy"></div>
                    <div class="row-item-info">
                        <span class="eyebrow">${esc(item.category || 'Geral')}</span>
                        <div class="row-item-title">${idx + 1}. ${esc(item.name)}</div>
                    </div>
                </div>
                <div class="editor-item-inputs">
                    <label>Séries<input type="number" inputmode="numeric" class="form-input" data-f="series" value="${esc(item.series || 3)}" min="1" max="20"></label>
                    <label>Repetições<input type="text" class="form-input" data-f="reps" value="${esc(item.reps || '10-12')}"></label>
                    <label>Descanso (s)<input type="number" inputmode="numeric" class="form-input" data-f="rest" value="${esc(item.rest ?? 60)}" min="0" step="5"></label>
                </div>
                <div class="card-actions">
                    <button class="btn btn-sm btn-ghost grow" data-act="up" ${idx === 0 ? 'disabled' : ''}>Subir</button>
                    <button class="btn btn-sm btn-ghost grow" data-act="down" ${idx === list.length - 1 ? 'disabled' : ''}>Descer</button>
                    <button class="btn btn-sm btn-danger grow" data-act="remove">Remover</button>
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
            Native.toast('Informe o nome do treino.');
            nameInput.focus();
            return;
        }
        if (state.editingWorkout.exercises.length === 0) {
            Native.toast('Adicione pelo menos 1 exercício.');
            return;
        }
        state.editingWorkout.title = title;
        state.editingWorkout.description = $('editor-workout-desc').value.trim();

        const i = state.customWorkouts.findIndex(w => w.id === state.editingWorkout.id);
        if (i !== -1) state.customWorkouts[i] = state.editingWorkout;
        else state.customWorkouts.push(state.editingWorkout);

        saveCustomWorkouts();
        $('section-custom-workouts').classList.remove('collapsed');
        closeModal('modal-workout-editor');
        Native.toast('Treino salvo');
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
        $('picker-empty-state').style.display = filtered.length ? 'none' : 'flex';

        // shortcut: mostra só os 60 primeiros (GIFs pesam); refine pela busca. Paginar se incomodar.
        filtered.slice(0, 60).forEach(ex => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'card row-item';
            card.innerHTML = `
                <div class="gif-frame thumb"><img src="${gifUrl(ex.gif_file || ex.name + '.gif')}" alt="" loading="lazy"></div>
                <div class="row-item-info" style="text-align:left">
                    <span class="eyebrow">${esc(ex.category)}</span>
                    <div class="row-item-title">${esc(ex.name)}</div>
                    <span class="muted-small">${esc((ex.equipments || []).join(', ') || 'Peso corporal')}</span>
                </div>
            `;
            card.addEventListener('click', () => {
                state.editingWorkout.exercises.push(newExerciseItem(ex));
                renderEditorExerciseList();
                closeModal('modal-exercise-picker');
            });
            container.appendChild(card);
        });
    }

    // --- Detalhe do exercício ---
    function openExerciseDetail(exercise) {
        $('detail-title').textContent = exercise.name;
        $('detail-description').textContent = exercise.description || '';
        $('detail-tags').textContent = exercise.category;
        $('detail-equipment').innerHTML = (exercise.equipments || []).map(eq => `<span class="pill">${esc(eq)}</span>`).join('');
        const img = $('detail-gif-img');
        img.src = gifUrl(exercise.gif_file);
        img.alt = exercise.name;
        $('btn-add-to-workout-modal').onclick = () => {
            closeModal('modal-exercise-detail');
            promptAddExerciseToWorkout(exercise);
        };
        openModal('modal-exercise-detail');
    }

    function promptAddExerciseToWorkout(exercise) {
        const container = $('choose-workout-list');
        container.innerHTML = '';

        const addRow = (label, sub, onClick) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'card';
            btn.style.textAlign = 'left';
            btn.innerHTML = `<div class="card-title">${esc(label)}</div><span class="muted-small">${esc(sub)}</span>`;
            btn.addEventListener('click', () => {
                closeModal('modal-choose-workout');
                onClick();
            });
            container.appendChild(btn);
        };

        state.customWorkouts.forEach(w => addRow(w.title, plural(w.exercises.length, 'exercício', 'exercícios'), () => {
            w.exercises.push(newExerciseItem(exercise));
            saveCustomWorkouts();
            Native.toast(`Adicionado a "${w.title}"`);
        }));
        addRow('Criar novo treino', 'Começa já com este exercício', () => openWorkoutEditor({
            id: 'custom_' + Date.now(),
            title: '',
            description: '',
            exercises: [newExerciseItem(exercise)]
        }));
        openModal('modal-choose-workout');
    }

    // --- Janelas ---
    function openModal(modalId) {
        $(modalId).classList.add('active');
        state.currentModal = modalId;
    }

    function closeModal(modalId) {
        $(modalId).classList.remove('active');
        const open = document.querySelectorAll('.modal-overlay.active');
        state.currentModal = open.length ? open[open.length - 1].id : null;
    }

    function setupModals() {
        $('btn-close-exercise-detail').addEventListener('click', () => closeModal('modal-exercise-detail'));
        $('btn-close-choose-workout').addEventListener('click', () => closeModal('modal-choose-workout'));
        $('btn-cancel-workout-edit').addEventListener('click', () => closeModal('modal-workout-editor'));
        $('btn-open-exercise-picker').addEventListener('click', openExercisePicker);
        $('btn-close-exercise-picker').addEventListener('click', () => closeModal('modal-exercise-picker'));
        $('picker-search-input').addEventListener('input', (e) => {
            pickerSearch = e.target.value.trim().toLowerCase();
            renderPickerList();
        });
        $('btn-save-workout').addEventListener('click', saveEditingWorkout);
        $('btn-close-summary').addEventListener('click', () => closeModal('modal-workout-summary'));
        $('btn-clear-history').addEventListener('click', () => {
            if (confirm('Apagar todo o histórico de treinos?')) {
                state.history = [];
                saveHistory();
            }
        });
    }

    // ======================================================================
    // TREINO EM ANDAMENTO
    // Uma linha por exercício: "+" conta a série feita e dispara o descanso.
    // Tudo é salvo a cada toque: se o Android matar o app, o treino volta igual.
    // ======================================================================
    function startWorkout(workout) {
        if (!workout.exercises || workout.exercises.length === 0) {
            Native.toast('Este treino não tem exercícios.');
            return;
        }
        if (state.activeWorkout && !confirm('Já existe um treino em andamento. Começar outro?')) return;

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
            restEndsAt: state.restEndsAt
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
        const left = Math.ceil((state.restEndsAt - Date.now()) / 1000);
        if (resting && left <= 0) {
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
        if (showTimer) $('rest-timer-seconds').textContent = clock(left);
    }

    function setRest(endsAt) {
        state.restEndsAt = endsAt > Date.now() ? endsAt : 0;
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
            img.src = src;
            img.alt = current.name;
        }

        $('player-reps-target').textContent = `${current.reps || '10'} reps`;
        $('player-sets-done').textContent = current.done;
        $('player-sets-total').textContent = current.series;
        $('btn-set-minus').disabled = current.done === 0;
        $('btn-set-plus').disabled = doneAll;
        document.querySelector('.set-counter').classList.toggle('complete', doneAll);

        $('player-rest-hint').textContent = doneAll
            ? (isLast ? 'Último exercício concluído.' : 'Exercício concluído. Toque em Próximo.')
            : 'Terminou a série? Toque em + para contar e descansar.';

        $('btn-player-prev').disabled = idx === 0;
        const nextBtn = $('btn-player-next');
        nextBtn.textContent = isLast ? 'Concluir' : 'Próximo';
        nextBtn.classList.toggle('btn-primary', doneAll);
        nextBtn.classList.toggle('btn-accent', !doneAll);
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
        setRest(delta > 0 && rest > 0 && !lastSetOfWorkout ? Date.now() + rest * 1000 : 0);
        renderActiveExercise();
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

    function confirmCancelWorkout() {
        if (confirm('Sair do treino? O progresso desta sessão não será salvo no histórico.')) closePlayer();
    }

    function setupPlayer() {
        $('btn-set-plus').addEventListener('click', () => changeSets(1));
        $('btn-set-minus').addEventListener('click', () => changeSets(-1));
        $('btn-player-prev').addEventListener('click', () => goToExercise(-1));
        $('btn-player-next').addEventListener('click', () => goToExercise(1));
        $('btn-player-finish').addEventListener('click', () => {
            if (confirm('Finalizar o treino agora?')) finishWorkoutSession();
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
        $('history-empty-state').style.display = state.history.length ? 'none' : 'flex';

        let totalSets = 0;
        let totalMinutes = 0;
        state.history.forEach(item => {
            totalSets += item.completedSets || 0;
            totalMinutes += item.durationMins || 0;
            const dateStr = new Date(item.date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            const row = document.createElement('div');
            row.className = 'card';
            row.innerHTML = `
                <div class="card-head">
                    <div class="card-title">${esc(item.workoutTitle)}</div>
                    <span class="muted-small">${esc(dateStr)}</span>
                </div>
                <div class="card-meta">
                    <span>${item.durationMins} min</span>
                    <span>${plural(item.completedSets || 0, 'série', 'séries')}</span>
                    <span>${plural(item.exercisesCount || 0, 'exercício', 'exercícios')}</span>
                </div>
            `;
            list.appendChild(row);
        });

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
    }

    function checkOfflineStatus() {
        const info = Native.json('getStorageInfo');
        if (!info) {
            $('settings-storage-desc').textContent = 'Disponível só no aparelho.';
            return;
        }
        $('settings-storage-path').textContent = info.gifsPath;
        $('settings-storage-desc').textContent = `${info.localGifsCount} GIFs na pasta local; os demais vêm embutidos no app.`;
        $('settings-gif-badge').textContent = 'Offline';
    }

    window.addEventListener('DOMContentLoaded', init);

    // Para inspeção e testes
    window.state = state;
    window.startWorkout = startWorkout;
})();
