/* ==========================================================================
   TreinoFit — Application Logic (Vanilla JS, 100% Offline & Reactive)
   ========================================================================== */

(function () {
    'use strict';

    // --- State ---
    const state = {
        exercises: [],
        filteredExercises: [],
        presets: [],
        customWorkouts: [],
        favorites: new Set(),
        history: [],
        settings: {
            keepScreen: true,
            vibration: true,
            sound: true
        },
        currentView: 'view-workouts',
        selectedCategory: 'Todos',
        selectedEquipment: '',
        searchQuery: '',
        pageIndex: 0,
        pageSize: 24,
        
        // Active Workout Player
        activeWorkout: null,
        activeExerciseIndex: 0,
        activeWorkoutStartTime: null,
        activeWorkoutInterval: null,
        restTimerRemaining: 0,
        restTimerInterval: null,
        
        // Modal States
        currentModal: null,
        editingWorkout: null
    };

    // --- Audio Synthesis for Timer ---
    const AudioService = {
        ctx: null,
        init() {
            if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            }
        },
        beep(freq = 880, duration = 0.15, type = 'sine') {
            if (!state.settings.sound) return;
            try {
                this.init();
                if (!this.ctx) return;
                if (this.ctx.state === 'suspended') {
                    this.ctx.resume();
                }
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
                gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start();
                osc.stop(this.ctx.currentTime + duration);
            } catch (_) {}
        },
        playTimerDone() {
            this.beep(784, 0.12);
            setTimeout(() => this.beep(1046, 0.25), 140);
        }
    };

    // --- Native Bridge Wrapper ---
    const Native = {
        getDynamicColors() {
            if (window.Android && window.Android.getDynamicColors) {
                try {
                    return JSON.parse(window.Android.getDynamicColors());
                } catch (e) {
                    console.error(e);
                }
            }
            return { supported: false };
        },
        saveData(key, value) {
            if (window.Android && window.Android.saveData) {
                try {
                    window.Android.saveData(key, value);
                } catch (e) {
                    console.error('Android.saveData erro:', e);
                }
            }
        },
        loadData(key) {
            if (window.Android && window.Android.loadData) {
                try {
                    return window.Android.loadData(key);
                } catch (e) {
                    console.error('Android.loadData erro:', e);
                }
            }
            return null;
        },
        removeData(key) {
            if (window.Android && window.Android.removeData) {
                try {
                    window.Android.removeData(key);
                } catch (e) {
                    console.error('Android.removeData erro:', e);
                }
            }
        },
        toast(msg) {
            if (window.Android && window.Android.toast) {
                window.Android.toast(msg);
            } else {
                console.log('[Toast]', msg);
            }
        },
        vibrate(ms) {
            if (!state.settings.vibration) return;
            if (window.Android && window.Android.vibrate) {
                window.Android.vibrate(ms);
            } else if (navigator.vibrate) {
                navigator.vibrate(ms);
            }
        },
        keepScreenOn(enable) {
            if (window.Android && window.Android.keepScreenOn) {
                window.Android.keepScreenOn(enable && state.settings.keepScreen);
            }
        },
        getStorageInfo() {
            if (window.Android && window.Android.getStorageInfo) {
                try {
                    return JSON.parse(window.Android.getStorageInfo());
                } catch (_) {}
            }
            return null;
        }
    };

    // --- Persistent Storage Service (Dual Layer: Native SharedPreferences + localStorage) ---
    const Storage = {
        get(key) {
            const nativeVal = Native.loadData(key);
            if (nativeVal !== null && nativeVal !== undefined && nativeVal !== '') {
                return nativeVal;
            }
            try {
                return localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        set(key, value) {
            const strVal = typeof value === 'string' ? value : JSON.stringify(value);
            try {
                localStorage.setItem(key, strVal);
            } catch (_) {}
            Native.saveData(key, strVal);
        },
        remove(key) {
            try {
                localStorage.removeItem(key);
            } catch (_) {}
            Native.removeData(key);
        }
    };

    // --- Theme & Dynamic Colors Service ---
    const ThemeService = {
        mode: 'dynamic', // 'bw' (Preto e Branco) ou 'dynamic' (Material You)
        dynamicColors: null,

        init() {
            // Consulta cores do Android via Bridge
            this.dynamicColors = Native.getDynamicColors();

            // Lê preferência salva
            const savedMode = Storage.get('treinofit_theme_mode');
            if (savedMode) {
                this.mode = savedMode;
            } else {
                // Padrão: dinâmico se suportado no Android, senão preto e branco puro
                this.mode = (this.dynamicColors && this.dynamicColors.supported) ? 'dynamic' : 'bw';
            }

            this.apply();
            this.setupUI();
        },

        setMode(newMode) {
            this.mode = newMode;
            Storage.set('treinofit_theme_mode', newMode);
            this.apply();
            this.updateDesc();
            Native.toast(newMode === 'dynamic' ? 'Cores dinâmicas do Android ativadas' : 'Paleta Preto e Branco ativada');
        },

        apply() {
            const root = document.documentElement;
            const body = document.body;

            if (this.mode === 'dynamic' && this.dynamicColors && this.dynamicColors.supported) {
                body.classList.add('theme-dynamic');
                body.classList.remove('theme-bw');

                root.style.setProperty('--android-accent-primary', this.dynamicColors.accentPrimary);
                root.style.setProperty('--android-accent-rgb', this.dynamicColors.accentPrimaryRgb);
                root.style.setProperty('--android-accent-contrast', this.dynamicColors.accentContrast || '#000000');
                root.style.setProperty('--android-accent-light', this.dynamicColors.accentLight || this.dynamicColors.accentPrimary);
                root.style.setProperty('--android-accent-surface', this.dynamicColors.accentSurface || 'rgba(255, 255, 255, 0.1)');
                root.style.setProperty('--android-accent-dark', this.dynamicColors.accentDark || this.dynamicColors.accentPrimary);
            } else {
                body.classList.remove('theme-dynamic');
                body.classList.add('theme-bw');

                root.style.removeProperty('--android-accent-primary');
                root.style.removeProperty('--android-accent-rgb');
                root.style.removeProperty('--android-accent-contrast');
                root.style.removeProperty('--android-accent-light');
                root.style.removeProperty('--android-accent-surface');
                root.style.removeProperty('--android-accent-dark');
            }
        },

        receiveFromNative(colors) {
            if (colors && colors.supported) {
                this.dynamicColors = colors;
                if (this.mode === 'dynamic') {
                    this.apply();
                }
                this.updateDesc();
            }
        },

        setupUI() {
            const select = document.getElementById('setting-theme-palette');
            if (select) {
                select.value = this.mode;
                select.addEventListener('change', (e) => {
                    this.setMode(e.target.value);
                });
            }
            this.updateDesc();
        },

        updateDesc() {
            const desc = document.getElementById('setting-theme-desc');
            if (!desc) return;
            if (this.mode === 'dynamic' && this.dynamicColors && this.dynamicColors.supported) {
                desc.innerHTML = `Sincronizado com o Android Material You (Destaque: <strong style="color: ${this.dynamicColors.accentPrimary}">${this.dynamicColors.accentPrimary}</strong>).`;
            } else if (this.mode === 'dynamic') {
                desc.textContent = 'Aguardando detecção do sistema Android 12+...';
            } else {
                desc.textContent = 'Modo monocromático puro de alto contraste (Preto & Branco).';
            }
        }
    };

    window.__receiveAndroidDynamicColors = function(colors) {
        ThemeService.receiveFromNative(colors);
    };

    // --- Data Persistence ---
    function loadPersistedData() {
        try {
            const savedFavs = Storage.get('treinofit_favs');
            if (savedFavs) {
                state.favorites = new Set(JSON.parse(savedFavs));
            }
            const savedWorkouts = Storage.get('treinofit_custom_workouts');
            if (savedWorkouts) {
                state.customWorkouts = JSON.parse(savedWorkouts);
            }
            const savedHistory = Storage.get('treinofit_history');
            if (savedHistory) {
                state.history = JSON.parse(savedHistory);
            }
            const savedSettings = Storage.get('treinofit_settings');
            if (savedSettings) {
                state.settings = { ...state.settings, ...JSON.parse(savedSettings) };
            }
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
        updateFavoritesBadges();
    }

    function saveHistory() {
        Storage.set('treinofit_history', state.history);
        renderHistory();
    }

    function saveSettings() {
        Storage.set('treinofit_settings', state.settings);
    }

    // --- Initialization ---
    async function init() {
        ThemeService.init();
        loadPersistedData();
        setupNavigation();
        setupCollapsibleSections();
        setupSearchAndFilters();
        setupSettingsControls();
        setupModals();
        setupAndroidBackHandler();

        try {
            // Load exercises and presets
            const [exRes, preRes] = await Promise.all([
                fetch('exercises.json'),
                fetch('presets.json')
            ]);
            state.exercises = await exRes.json();
            state.presets = await preRes.json();

            // Sincroniza treinos existentes com gif_file e category se estiverem faltando
            if (state.customWorkouts && state.customWorkouts.length > 0) {
                let updated = false;
                state.customWorkouts.forEach(w => {
                    (w.exercises || []).forEach(item => {
                        if (!item.gif_file) {
                            const match = state.exercises.find(ex => ex.name.toLowerCase() === item.name.toLowerCase());
                            if (match) {
                                item.gif_file = match.gif_file;
                                item.category = match.category;
                                updated = true;
                            } else {
                                item.gif_file = item.name + '.gif';
                                updated = true;
                            }
                        }
                    });
                });
                if (updated) saveCustomWorkouts();
            }
            
            setupCategoryChips();
            applyExerciseFilters();
            renderPresetWorkouts();
            renderCustomWorkouts();
            renderFavorites();
            renderHistory();
            checkOfflineStatus();
        } catch (err) {
            console.error('Erro ao carregar dados iniciais:', err);
            Native.toast('Erro ao carregar banco de exercícios');
        }
    }

    // --- Navigation ---
    function setupNavigation() {
        const navButtons = document.querySelectorAll('.bottom-nav .nav-item');
        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetViewId = btn.dataset.view;
                switchView(targetViewId);
            });
        });

        // Hero button
        const btnHero = document.getElementById('btn-create-workout-hero');
        if (btnHero) {
            btnHero.addEventListener('click', () => openWorkoutEditor());
        }
    }

    function setupCollapsibleSections() {
        const toggleCustom = document.getElementById('toggle-custom-workouts');
        const secCustom = document.getElementById('section-custom-workouts');
        if (toggleCustom && secCustom) {
            toggleCustom.addEventListener('click', () => {
                secCustom.classList.toggle('collapsed');
            });
        }

        const togglePreset = document.getElementById('toggle-preset-workouts');
        const secPreset = document.getElementById('section-preset-workouts');
        if (togglePreset && secPreset) {
            togglePreset.addEventListener('click', () => {
                secPreset.classList.toggle('collapsed');
            });
        }
    }

    function switchView(viewId) {
        state.currentView = viewId;
        
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const activeView = document.getElementById(viewId);
        if (activeView) activeView.classList.add('active');

        document.querySelectorAll('.bottom-nav .nav-item').forEach(b => {
            b.classList.toggle('active', b.dataset.view === viewId);
        });

        window.scrollTo({ top: 0, behavior: 'smooth' });

        if (viewId === 'view-favorites') renderFavorites();
        if (viewId === 'view-history') renderHistory();
        if (viewId === 'view-settings') checkOfflineStatus();
    }

    // --- Android Back Button ---
    function setupAndroidBackHandler() {
        window.__onBack = function () {
            // 1. Se estiver no player de treino ativo, confirma saída ou minimiza
            const player = document.getElementById('modal-workout-player');
            if (player && player.classList.contains('active')) {
                if (confirm('Deseja sair do treino em andamento? O progresso da sessão será cancelado.')) {
                    stopActiveWorkout();
                }
                return true;
            }

            // 2. Se houver modal aberto, fecha o modal
            if (state.currentModal) {
                closeModal(state.currentModal);
                return true;
            }

            // 3. Se não estiver na tela principal de treinos, volta para ela
            if (state.currentView !== 'view-workouts') {
                switchView('view-workouts');
                return true;
            }

            // Deixa o Android fechar o app
            return false;
        };
    }

    // --- Category Chips & Filters ---
    function setupCategoryChips() {
        const categories = [
            'Todos', 'Peitoral', 'Costas', 'Pernas', 'Glúteos', 'Ombros', 
            'Bíceps', 'Tríceps', 'Trapézio', 'Panturrilhas', 'Antebraços', 
            'Eretor Lombar', 'Calistenia', 'Cardio', 'Funcional e HIT', 'Mobilidade', 'Crossfit'
        ];

        const container = document.getElementById('category-chips');
        container.innerHTML = '';

        categories.forEach(cat => {
            const chip = document.createElement('button');
            chip.className = `chip ${cat === state.selectedCategory ? 'active' : ''}`;
            chip.textContent = cat;
            chip.addEventListener('click', () => {
                container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                state.selectedCategory = cat;
                applyExerciseFilters();
            });
            container.appendChild(chip);
        });
    }

    function setupSearchAndFilters() {
        const searchInput = document.getElementById('exercise-search-input');
        const clearBtn = document.getElementById('clear-search-btn');
        const equipmentSelect = document.getElementById('equipment-select');

        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim().toLowerCase();
            clearBtn.style.display = state.searchQuery ? 'block' : 'none';
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                applyExerciseFilters();
            }, 180);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            state.searchQuery = '';
            clearBtn.style.display = 'none';
            applyExerciseFilters();
        });

        equipmentSelect.addEventListener('change', (e) => {
            state.selectedEquipment = e.target.value;
            applyExerciseFilters();
        });

        // Infinite Scroll
        window.addEventListener('scroll', () => {
            if (state.currentView !== 'view-exercises') return;
            const sentinel = document.getElementById('infinite-scroll-sentinel');
            if (!sentinel) return;
            const rect = sentinel.getBoundingClientRect();
            if (rect.top <= window.innerHeight + 300) {
                appendNextExercisesPage();
            }
        });
    }

    function applyExerciseFilters() {
        let result = state.exercises;

        // Category
        if (state.selectedCategory !== 'Todos') {
            result = result.filter(ex => ex.category === state.selectedCategory);
        }

        // Equipment
        if (state.selectedEquipment) {
            result = result.filter(ex => ex.equipments && ex.equipments.includes(state.selectedEquipment));
        }

        // Search Query
        if (state.searchQuery) {
            result = result.filter(ex => 
                ex.name.toLowerCase().includes(state.searchQuery) ||
                ex.category.toLowerCase().includes(state.searchQuery)
            );
        }

        state.filteredExercises = result;
        state.pageIndex = 0;

        document.getElementById('filter-result-count').textContent = result.length;

        const grid = document.getElementById('exercises-grid');
        grid.innerHTML = '';
        appendNextExercisesPage();
    }

    function appendNextExercisesPage() {
        const start = state.pageIndex * state.pageSize;
        if (start >= state.filteredExercises.length) {
            document.getElementById('infinite-scroll-sentinel').style.display = 'none';
            return;
        }

        document.getElementById('infinite-scroll-sentinel').style.display = 'block';
        const batch = state.filteredExercises.slice(start, start + state.pageSize);
        const grid = document.getElementById('exercises-grid');

        const fragment = document.createDocumentFragment();
        batch.forEach(ex => {
            fragment.appendChild(createExerciseCard(ex));
        });
        grid.appendChild(fragment);

        state.pageIndex++;

        if (state.pageIndex * state.pageSize >= state.filteredExercises.length) {
            document.getElementById('infinite-scroll-sentinel').style.display = 'none';
        }
    }

    function createExerciseCard(exercise) {
        const card = document.createElement('div');
        card.className = 'exercise-card';
        
        const isFav = state.favorites.has(exercise.id);
        const gifSrc = `/gifs/${encodeURIComponent(exercise.gif_file)}`;

        card.innerHTML = `
            <div class="exercise-thumb-wrap">
                <img src="${gifSrc}" alt="${exercise.name}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\' fill=\'%23222\'><rect width=\'100\' height=\'100\'/><text x=\'50%\' y=\'50%\' fill=\'%23666\' font-size=\'12\' text-anchor=\'middle\' dy=\'.3em\'>GIF</text></svg>'">
                <button class="exercise-card-favorite-btn ${isFav ? 'active' : ''}" title="Favoritar">
                    ${isFav ? Icons.starFilled : Icons.star}
                </button>
            </div>
            <div class="exercise-card-info">
                <span class="exercise-card-cat">${exercise.category}</span>
                <div class="exercise-card-name">${exercise.name}</div>
            </div>
        `;

        // Card Click opens Detail Modal
        card.addEventListener('click', (e) => {
            if (e.target.closest('.exercise-card-favorite-btn')) return;
            openExerciseDetail(exercise);
        });

        // Favorite Toggle
        const favBtn = card.querySelector('.exercise-card-favorite-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(exercise.id, favBtn);
        });

        return card;
    }

    function toggleFavorite(id, btnElement) {
        if (state.favorites.has(id)) {
            state.favorites.delete(id);
            if (btnElement) {
                btnElement.classList.remove('active');
                btnElement.innerHTML = Icons.star;
            }
            Native.toast('Removido dos favoritos');
        } else {
            state.favorites.add(id);
            if (btnElement) {
                btnElement.classList.add('active');
                btnElement.innerHTML = Icons.starFilled;
            }
            Native.vibrate(30);
            Native.toast('Adicionado aos favoritos!');
        }
        saveFavorites();
    }

    function updateFavoritesBadges() {
        const count = state.favorites.size;
        const badge = document.getElementById('favorites-count-badge');
        if (badge) badge.textContent = `${count} ${count === 1 ? 'exercício' : 'exercícios'}`;
    }

    function renderFavorites() {
        const grid = document.getElementById('favorites-grid');
        const emptyState = document.getElementById('favorites-empty-state');
        grid.innerHTML = '';

        const favExercises = state.exercises.filter(ex => state.favorites.has(ex.id));
        updateFavoritesBadges();

        if (favExercises.length === 0) {
            emptyState.style.display = 'flex';
            return;
        }

        emptyState.style.display = 'none';
        favExercises.forEach(ex => {
            grid.appendChild(createExerciseCard(ex));
        });
    }

    // --- Workouts List (Presets & Custom) ---
    function renderPresetWorkouts() {
        const container = document.getElementById('preset-workouts-list');
        const presetBadge = document.getElementById('preset-count-badge');
        if (presetBadge) {
            presetBadge.textContent = `${state.presets.length} ${state.presets.length === 1 ? 'rotina' : 'rotinas'}`;
        }
        container.innerHTML = '';

        state.presets.forEach(preset => {
            const card = document.createElement('div');
            card.className = 'workout-card';
            card.innerHTML = `
                <div class="workout-card-top">
                    <div class="workout-badge-group">
                        ${getWorkoutBadgeHtml(preset.icon, preset.category)}
                        <div>
                            <div class="workout-title">${preset.title}</div>
                            <span class="badge-pill" style="margin-top: 4px;">
                                ${preset.category}
                            </span>
                        </div>
                    </div>
                </div>
                <p class="workout-desc">${preset.description}</p>
                <div class="workout-meta-row">
                    <span>${preset.exercises.length} exercícios</span>
                    <span>~45-60 min</span>
                </div>
                <div class="workout-actions-row">
                    <button class="btn btn-sm btn-primary btn-block btn-start-preset">
                        <span class="btn-icon">${Icons.play}</span> Iniciar Treino
                    </button>
                    <button class="btn btn-sm btn-ghost btn-copy-preset" title="Duplicar para personalizar">
                        <span class="btn-icon">${Icons.copy}</span> Copiar
                    </button>
                </div>
            `;

            card.querySelector('.btn-start-preset').addEventListener('click', (e) => {
                e.stopPropagation();
                startWorkout(preset);
            });

            card.querySelector('.btn-copy-preset').addEventListener('click', (e) => {
                e.stopPropagation();
                clonePresetToCustom(preset);
            });

            container.appendChild(card);
        });
    }

    function clonePresetToCustom(preset) {
        const cloned = {
            id: 'custom_' + Date.now(),
            title: `${preset.title} (Cópia)`,
            category: 'Personalizado',
            icon: preset.icon || 'push',
            description: preset.description || '',
            exercises: JSON.parse(JSON.stringify(preset.exercises))
        };
        state.customWorkouts.unshift(cloned);
        saveCustomWorkouts();
        Native.toast('Treino copiado para suas rotinas!');
        switchView('view-workouts');
    }

    function renderCustomWorkouts() {
        const container = document.getElementById('custom-workouts-list');
        const badge = document.getElementById('custom-count-badge');
        badge.textContent = `${state.customWorkouts.length} ${state.customWorkouts.length === 1 ? 'rotina' : 'rotinas'}`;
        container.innerHTML = '';

        if (state.customWorkouts.length === 0) {
            container.innerHTML = `
                <div class="empty-state small" style="padding: 24px;">
                    <p>Nenhuma rotina personalizada criada ainda.</p>
                    <button class="btn btn-sm btn-accent" id="btn-create-first-workout" style="margin-top: 8px;">
                        <span class="btn-icon">${Icons.plus}</span> Criar Minha Primeira Rotina
                    </button>
                </div>
            `;
            const btnFirst = container.querySelector('#btn-create-first-workout');
            if (btnFirst) btnFirst.addEventListener('click', () => openWorkoutEditor());
            return;
        }

        state.customWorkouts.forEach((w, index) => {
            const card = document.createElement('div');
            card.className = 'workout-card';
            card.innerHTML = `
                <div class="workout-card-top">
                    <div class="workout-badge-group">
                        ${getWorkoutBadgeHtml(w.icon, w.category)}
                        <div>
                            <div class="workout-title">${w.title}</div>
                            <span class="workout-desc">${w.description || 'Rotina personalizada'}</span>
                        </div>
                    </div>
                </div>
                <div class="workout-meta-row">
                    <span>${w.exercises.length} exercícios</span>
                    <span>Personalizado</span>
                </div>
                <div class="workout-actions-row">
                    <button class="btn btn-sm btn-primary btn-start-custom" style="flex: 2;">
                        <span class="btn-icon">${Icons.play}</span> Iniciar
                    </button>
                    <button class="btn btn-sm btn-accent btn-edit-custom" style="flex: 1;">
                        <span class="btn-icon">${Icons.edit}</span> Editar
                    </button>
                    <button class="btn btn-sm btn-ghost btn-delete-custom" title="Excluir">
                        ${Icons.trash}
                    </button>
                </div>
            `;

            card.querySelector('.btn-start-custom').addEventListener('click', () => startWorkout(w));
            card.querySelector('.btn-edit-custom').addEventListener('click', () => openWorkoutEditor(w));
            card.querySelector('.btn-delete-custom').addEventListener('click', () => {
                if (confirm(`Deseja excluir a rotina "${w.title}"?`)) {
                    state.customWorkouts.splice(index, 1);
                    saveCustomWorkouts();
                    Native.toast('Treino removido');
                }
            });

            container.appendChild(card);
        });
    }

    // --- Workout Editor Modal ---
    function openWorkoutEditor(workoutToEdit = null) {
        state.editingWorkout = workoutToEdit ? JSON.parse(JSON.stringify(workoutToEdit)) : {
            id: 'custom_' + Date.now(),
            title: '',
            description: '',
            exercises: []
        };

        const titleEl = document.getElementById('workout-editor-title');
        const nameInput = document.getElementById('editor-workout-name');
        const descInput = document.getElementById('editor-workout-desc');

        titleEl.textContent = workoutToEdit ? 'Editar Treino' : 'Novo Treino';
        nameInput.value = state.editingWorkout.title || '';
        descInput.value = state.editingWorkout.description || '';

        renderEditorExerciseList();
        openModal('modal-workout-editor');
    }

    function renderEditorExerciseList() {
        const container = document.getElementById('editor-exercises-list');
        const emptyState = document.getElementById('editor-empty-state');
        container.innerHTML = '';

        if (!state.editingWorkout.exercises || state.editingWorkout.exercises.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        state.editingWorkout.exercises.forEach((item, idx) => {
            // Resolver nome do arquivo de GIF para o thumbnail
            const matchEx = state.exercises.find(ex => ex.name.toLowerCase() === item.name.toLowerCase());
            const gifFilename = item.gif_file || (matchEx ? matchEx.gif_file : `${item.name}.gif`);
            const categoryName = item.category || (matchEx ? matchEx.category : 'Geral');
            const gifSrc = `/gifs/${encodeURIComponent(gifFilename)}`;

            const el = document.createElement('div');
            el.className = 'editor-exercise-item';
            el.innerHTML = `
                <div class="editor-item-top">
                    <div class="editor-item-left">
                        <div class="editor-item-thumb">
                            <img src="${gifSrc}" alt="${item.name}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'44\\' height=\\'44\\' fill=\\'%23111\\'><rect width=\\'44\\' height=\\'44\\'/><text x=\\'50%\\' y=\\'50%\\' fill=\\'%23555\\' font-size=\\'8\\' text-anchor=\\'middle\\' dy=\\'.3em\\'>GIF</text></svg>'">
                        </div>
                        <div class="editor-item-info">
                            <span class="editor-item-cat">${categoryName}</span>
                            <div class="editor-item-title">${idx + 1}. ${item.name}</div>
                        </div>
                    </div>
                    <div class="editor-item-actions">
                        <button class="btn btn-sm btn-ghost btn-move-up" ${idx === 0 ? 'disabled style="opacity:0.3"' : ''} title="Mover para cima">${Icons.chevronUp}</button>
                        <button class="btn btn-sm btn-ghost btn-move-down" ${idx === state.editingWorkout.exercises.length - 1 ? 'disabled style="opacity:0.3"' : ''} title="Mover para baixo">${Icons.chevronDown}</button>
                        <button class="btn btn-sm btn-ghost btn-remove-item" style="color: #ff5252;" title="Remover exercício">${Icons.trash}</button>
                    </div>
                </div>
                <div class="editor-item-inputs">
                    <div class="input-mini-box">
                        <span>SÉRIES</span>
                        <input type="number" class="input-series" value="${item.series || 3}" min="1" max="20">
                    </div>
                    <div class="input-mini-box">
                        <span>REPS</span>
                        <input type="text" class="input-reps" value="${item.reps || '10-12'}">
                    </div>
                    <div class="input-mini-box">
                        <span>CARGA KG</span>
                        <input type="text" class="input-weight" value="${item.weight || '0'}">
                    </div>
                    <div class="input-mini-box">
                        <span>PAUSA (S)</span>
                        <input type="number" class="input-rest" value="${item.rest || 60}" min="10" step="5">
                    </div>
                </div>
            `;

            const sInput = el.querySelector('.input-series');
            const rInput = el.querySelector('.input-reps');
            const wInput = el.querySelector('.input-weight');
            const pInput = el.querySelector('.input-rest');

            const syncInputs = () => {
                item.series = parseInt(sInput.value) || 3;
                item.reps = rInput.value || '10-12';
                item.weight = wInput.value || '0';
                item.rest = parseInt(pInput.value) || 60;
            };

            sInput.addEventListener('input', syncInputs);
            sInput.addEventListener('change', syncInputs);
            rInput.addEventListener('input', syncInputs);
            rInput.addEventListener('change', syncInputs);
            wInput.addEventListener('input', syncInputs);
            wInput.addEventListener('change', syncInputs);
            pInput.addEventListener('input', syncInputs);
            pInput.addEventListener('change', syncInputs);

            el.querySelector('.btn-move-up').addEventListener('click', () => {
                if (idx > 0) {
                    const temp = state.editingWorkout.exercises[idx];
                    state.editingWorkout.exercises[idx] = state.editingWorkout.exercises[idx - 1];
                    state.editingWorkout.exercises[idx - 1] = temp;
                    renderEditorExerciseList();
                }
            });

            el.querySelector('.btn-move-down').addEventListener('click', () => {
                if (idx < state.editingWorkout.exercises.length - 1) {
                    const temp = state.editingWorkout.exercises[idx];
                    state.editingWorkout.exercises[idx] = state.editingWorkout.exercises[idx + 1];
                    state.editingWorkout.exercises[idx + 1] = temp;
                    renderEditorExerciseList();
                }
            });

            el.querySelector('.btn-remove-item').addEventListener('click', () => {
                state.editingWorkout.exercises.splice(idx, 1);
                renderEditorExerciseList();
            });

            container.appendChild(el);
        });
    }

    // --- Exercise Picker inside Editor (com GIFs animados e Categorias Oficiais) ---
    let pickerCategory = 'Todos';
    let pickerSearch = '';

    function openExercisePicker() {
        const pickerInput = document.getElementById('picker-search-input');
        pickerInput.value = '';
        pickerSearch = '';
        pickerCategory = 'Todos';

        setupPickerCategoryChips();
        renderPickerList();
        openModal('modal-exercise-picker');

        pickerInput.oninput = (e) => {
            pickerSearch = e.target.value.trim().toLowerCase();
            renderPickerList();
        };
    }

    function setupPickerCategoryChips() {
        const categories = [
            'Todos', 'Peitoral', 'Costas', 'Pernas', 'Glúteos', 'Ombros', 
            'Bíeps', 'Tríceps', 'Trapézio', 'Panturrilhas', 'Antebraços', 
            'Eretor Lombar', 'Calistenia', 'Cardio', 'Funcional e HIT', 'Mobilidade', 'Crossfit'
        ];

        const container = document.getElementById('picker-category-chips');
        if (!container) return;
        container.innerHTML = '';

        categories.forEach(cat => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `chip ${cat === pickerCategory ? 'active' : ''}`;
            chip.textContent = cat;
            chip.addEventListener('click', () => {
                container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                pickerCategory = cat;
                renderPickerList();
            });
            container.appendChild(chip);
        });
    }

    function renderPickerList() {
        const container = document.getElementById('picker-exercises-list');
        const emptyState = document.getElementById('picker-empty-state');
        const badge = document.getElementById('picker-count-badge');
        container.innerHTML = '';

        const filtered = state.exercises.filter(ex => {
            const matchCat = (pickerCategory === 'Todos') || (ex.category === pickerCategory);
            const matchText = !pickerSearch || 
                ex.name.toLowerCase().includes(pickerSearch) || 
                (ex.category && ex.category.toLowerCase().includes(pickerSearch)) ||
                (ex.equipments && ex.equipments.some(eq => eq.toLowerCase().includes(pickerSearch)));
            return matchCat && matchText;
        });

        const catLabel = document.getElementById('picker-category-label');
        if (catLabel) {
            if (pickerSearch) {
                catLabel.textContent = `Busca: "${pickerSearch}"`;
            } else if (pickerCategory === 'Todos') {
                catLabel.textContent = 'Todos os exercícios';
            } else {
                catLabel.textContent = `Categoria: ${pickerCategory}`;
            }
        }

        if (badge) badge.textContent = `${filtered.length} encontrados`;

        if (filtered.length === 0) {
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        // Renderiza até 60 exercícios com GIFs rodando
        const displayBatch = filtered.slice(0, 60);

        displayBatch.forEach(ex => {
            const card = document.createElement('div');
            card.className = 'picker-card';
            const gifFilename = ex.gif_file || `${ex.name}.gif`;
            const gifSrc = `/gifs/${encodeURIComponent(gifFilename)}`;

            card.innerHTML = `
                <div class="picker-card-thumb">
                    <img src="${gifSrc}" alt="${ex.name}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'68\\' height=\\'68\\' fill=\\'%23111\\'><rect width=\\'68\\' height=\\'68\\'/><text x=\\'50%\\' y=\\'50%\\' fill=\\'%23555\\' font-size=\\'10\\' text-anchor=\\'middle\\' dy=\\'.3em\\'>GIF</text></svg>'">
                </div>
                <div class="picker-card-info">
                    <span class="picker-card-cat">${ex.category}</span>
                    <div class="picker-card-title">${ex.name}</div>
                    <div class="picker-card-equip">${(ex.equipments || []).join(', ') || 'Peso Corporal'}</div>
                </div>
                <button class="picker-card-btn"><span class="btn-icon">${Icons.plus}</span> Adicionar</button>
            `;

            card.addEventListener('click', () => {
                state.editingWorkout.exercises.push({
                    name: ex.name,
                    gif_file: ex.gif_file || `${ex.name}.gif`,
                    category: ex.category,
                    series: 3,
                    reps: '10-12',
                    weight: '0',
                    rest: 60,
                    notes: ''
                });
                renderEditorExerciseList();
                closeModal('modal-exercise-picker');
                Native.toast(`"${ex.name}" adicionado ao treino!`);
            });

            container.appendChild(card);
        });
    }

    // --- Exercise Detail Modal ---
    function openExerciseDetail(exercise) {
        const modal = document.getElementById('modal-exercise-detail');
        const img = document.getElementById('detail-gif-img');
        const title = document.getElementById('detail-title');
        const tags = document.getElementById('detail-tags');
        const equip = document.getElementById('detail-equipment');
        const desc = document.getElementById('detail-description');
        const addBtn = document.getElementById('btn-add-to-workout-modal');

        title.textContent = exercise.name;
        desc.textContent = exercise.description;
        
        tags.innerHTML = `<span class="tag" style="color: var(--primary)">${exercise.category}</span>`;
        equip.innerHTML = (exercise.equipments || []).map(eq => `<span class="tag"><span class="tag-icon">${Icons.wrench}</span> ${eq}</span>`).join(' ');

        img.src = `/gifs/${encodeURIComponent(exercise.gif_file)}`;

        addBtn.onclick = () => {
            closeModal('modal-exercise-detail');
            promptAddExerciseToWorkout(exercise);
        };

        openModal('modal-exercise-detail');
    }

    function promptAddExerciseToWorkout(exercise) {
        if (state.customWorkouts.length === 0) {
            if (confirm('Você ainda não tem uma rotina personalizada. Deseja criar uma nova agora com este exercício?')) {
                openWorkoutEditor({
                    id: 'custom_' + Date.now(),
                    title: 'Meu Treino',
                    description: '',
                    exercises: [{
                        name: exercise.name,
                        series: 3,
                        reps: '10-12',
                        weight: '0',
                        rest: 60,
                        notes: ''
                    }]
                });
            }
            return;
        }

        const workoutNames = state.customWorkouts.map((w, i) => `${i + 1}. ${w.title}`).join('\n');
        const choice = prompt(`Em qual rotina deseja adicionar "${exercise.name}"?\n\n${workoutNames}\n\nDigite o número da rotina:`);
        const idx = parseInt(choice) - 1;
        if (!isNaN(idx) && state.customWorkouts[idx]) {
            state.customWorkouts[idx].exercises.push({
                name: exercise.name,
                series: 3,
                reps: '10-12',
                weight: '0',
                rest: 60,
                notes: ''
            });
            saveCustomWorkouts();
            Native.toast(`Adicionado a "${state.customWorkouts[idx].title}"!`);
        }
    }

    // --- Modals Management ---
    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            state.currentModal = modalId;
        }
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
            if (state.currentModal === modalId) {
                state.currentModal = null;
            }
        }
    }

    function setupModals() {
        // Exercise detail close
        document.getElementById('btn-close-exercise-detail').addEventListener('click', () => closeModal('modal-exercise-detail'));

        // Workout editor controls
        document.getElementById('btn-cancel-workout-edit').addEventListener('click', () => closeModal('modal-workout-editor'));
        document.getElementById('btn-open-exercise-picker').addEventListener('click', () => openExercisePicker());
        document.getElementById('btn-close-exercise-picker').addEventListener('click', () => closeModal('modal-exercise-picker'));

        document.getElementById('btn-save-workout').addEventListener('click', () => {
            const nameInput = document.getElementById('editor-workout-name');
            const descInput = document.getElementById('editor-workout-desc');
            const title = nameInput.value.trim();

            if (!title) {
                Native.toast('Por favor, informe o nome do treino.');
                nameInput.focus();
                return;
            }

            // Garante que todas as edições visíveis nos inputs sejam sincronizadas
            const container = document.getElementById('editor-exercises-list');
            if (container && state.editingWorkout.exercises) {
                const itemEls = container.querySelectorAll('.editor-exercise-item');
                itemEls.forEach((itemEl, idx) => {
                    if (state.editingWorkout.exercises[idx]) {
                        const s = itemEl.querySelector('.input-series');
                        const r = itemEl.querySelector('.input-reps');
                        const w = itemEl.querySelector('.input-weight');
                        const rest = itemEl.querySelector('.input-rest');
                        if (s) state.editingWorkout.exercises[idx].series = parseInt(s.value) || 3;
                        if (r) state.editingWorkout.exercises[idx].reps = r.value || '10-12';
                        if (w) state.editingWorkout.exercises[idx].weight = w.value || '0';
                        if (rest) state.editingWorkout.exercises[idx].rest = parseInt(rest.value) || 60;
                    }
                });
            }

            if (!state.editingWorkout.exercises || state.editingWorkout.exercises.length === 0) {
                Native.toast('Adicione pelo menos 1 exercício ao treino.');
                return;
            }

            state.editingWorkout.title = title;
            state.editingWorkout.description = descInput.value.trim();

            const existingIndex = state.customWorkouts.findIndex(w => w.id === state.editingWorkout.id);
            if (existingIndex !== -1) {
                state.customWorkouts[existingIndex] = state.editingWorkout;
            } else {
                state.customWorkouts.push(state.editingWorkout);
            }

            saveCustomWorkouts();
            closeModal('modal-workout-editor');
            Native.toast('Treino salvo com sucesso!');
        });

        // Summary close
        document.getElementById('btn-close-summary').addEventListener('click', () => closeModal('modal-workout-summary'));
    }

    // ==========================================================================
    // ACTIVE WORKOUT PLAYER (EXECUÇÃO DE TREINO)
    // ==========================================================================
    function startWorkout(workout) {
        if (!workout.exercises || workout.exercises.length === 0) {
            Native.toast('Este treino não possui exercícios cadastrados.');
            return;
        }

        state.activeWorkout = JSON.parse(JSON.stringify(workout));
        state.activeExerciseIndex = 0;
        state.activeWorkoutStartTime = Date.now();

        // Enriquecer com dados de GIF do banco completo
        state.activeWorkout.exercises.forEach(item => {
            if (!item.gif_file) {
                const match = state.exercises.find(ex => ex.name.toLowerCase() === item.name.toLowerCase());
                if (match) {
                    item.gif_file = match.gif_file;
                    item.category = match.category;
                } else {
                    item.gif_file = item.name + '.gif';
                }
            }
            // Inicializar array de séries concluídas
            const sCount = parseInt(item.series) || 3;
            item.setsData = Array.from({ length: sCount }, (_, i) => ({
                setIndex: i + 1,
                weight: item.weight || '0',
                reps: item.reps || '10',
                completed: false
            }));
        });

        Native.keepScreenOn(true);
        Native.vibrate(50);
        AudioService.init();

        const player = document.getElementById('modal-workout-player');
        player.classList.add('active');

        // Timer de sessão
        clearInterval(state.activeWorkoutInterval);
        state.activeWorkoutInterval = setInterval(updateWorkoutDurationDisplay, 1000);
        updateWorkoutDurationDisplay();

        renderActiveExercise();
    }

    function updateWorkoutDurationDisplay() {
        if (!state.activeWorkoutStartTime) return;
        const elapsed = Math.floor((Date.now() - state.activeWorkoutStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        document.getElementById('player-timer-elapsed').textContent = `${mins}:${secs}`;
    }

    function renderActiveExercise() {
        const total = state.activeWorkout.exercises.length;
        const curIdx = state.activeExerciseIndex;
        const current = state.activeWorkout.exercises[curIdx];

        document.getElementById('player-workout-name').textContent = state.activeWorkout.title;
        document.getElementById('player-progress-fill').style.width = `${((curIdx + 1) / total) * 100}%`;
        document.getElementById('player-step-counter').textContent = `${curIdx + 1} de ${total}`;

        document.getElementById('player-current-name').textContent = current.name;
        document.getElementById('player-current-notes').textContent = current.notes || `Foco em ${current.category || 'execução controlada'}`;

        const gifImg = document.getElementById('player-current-gif');
        const filename = current.gif_file || `${current.name}.gif`;
        gifImg.alt = current.name;
        gifImg.dataset.retry = '';
        gifImg.src = `/gifs/${encodeURIComponent(filename)}`;
        gifImg.onerror = function() {
            if (!this.dataset.retry) {
                this.dataset.retry = '1';
                this.src = `/gifs/${filename}`;
            }
        };

        // Render Sets Table
        const list = document.getElementById('player-sets-list');
        list.innerHTML = '';

        current.setsData.forEach(set => {
            const row = document.createElement('div');
            row.className = `set-row ${set.completed ? 'completed' : ''}`;
            row.innerHTML = `
                <span class="set-idx">${set.setIndex}</span>
                <input type="text" class="set-weight-input" value="${set.weight}">
                <input type="text" class="set-reps-input" value="${set.reps}">
                <button class="btn-check-set">${set.completed ? Icons.check : ''}</button>
            `;

            row.querySelector('.set-weight-input').addEventListener('change', (e) => set.weight = e.target.value);
            row.querySelector('.set-reps-input').addEventListener('change', (e) => set.reps = e.target.value);

            const checkBtn = row.querySelector('.btn-check-set');
            checkBtn.addEventListener('click', () => {
                set.completed = !set.completed;
                row.classList.toggle('completed', set.completed);
                checkBtn.innerHTML = set.completed ? Icons.check : '';

                if (set.completed) {
                    Native.vibrate(40);
                    AudioService.beep(600, 0.08);
                    // Dispara cronômetro de descanso
                    const restSeconds = parseInt(current.rest) || 60;
                    startRestCountdown(restSeconds);
                }
            });

            list.appendChild(row);
        });

        // Update Prev / Next buttons state
        document.getElementById('btn-player-prev').disabled = curIdx === 0;
        document.getElementById('btn-player-prev').style.opacity = curIdx === 0 ? '0.3' : '1';

        const isLast = curIdx === total - 1;
        const nextBtn = document.getElementById('btn-player-next');
        if (isLast) {
            nextBtn.textContent = 'Concluir';
            nextBtn.classList.remove('btn-icon-only');
            nextBtn.style.padding = '0 16px';
        } else {
            nextBtn.innerHTML = Icons.skipForward;
            nextBtn.classList.add('btn-icon-only');
            nextBtn.style.padding = '';
        }
    }

    // Navigation in Player
    document.getElementById('btn-player-prev').addEventListener('click', () => {
        if (!state.activeWorkout || !state.activeWorkout.exercises) return;
        if (state.activeExerciseIndex > 0) {
            state.activeExerciseIndex--;
            renderActiveExercise();
        }
    });

    document.getElementById('btn-player-next').addEventListener('click', () => {
        if (!state.activeWorkout || !state.activeWorkout.exercises) return;
        if (state.activeExerciseIndex < state.activeWorkout.exercises.length - 1) {
            state.activeExerciseIndex++;
            renderActiveExercise();
        } else {
            finishWorkoutSession();
        }
    });

    document.getElementById('btn-player-finish').addEventListener('click', () => {
        if (confirm('Deseja finalizar o treino agora?')) {
            finishWorkoutSession();
        }
    });

    document.getElementById('btn-minimize-player').addEventListener('click', () => {
        if (confirm('Deseja cancelar a sessão de treino atual?')) {
            stopActiveWorkout();
        }
    });

    // --- Rest Timer ---
    function startRestCountdown(seconds) {
        clearInterval(state.restTimerInterval);
        state.restTimerRemaining = seconds;

        const box = document.getElementById('player-rest-timer-box');
        const display = document.getElementById('rest-timer-seconds');
        box.style.display = 'flex';

        function updateTimerText() {
            const m = String(Math.floor(state.restTimerRemaining / 60)).padStart(2, '0');
            const s = String(state.restTimerRemaining % 60).padStart(2, '0');
            display.textContent = `${m}:${s}`;
        }

        updateTimerText();

        state.restTimerInterval = setInterval(() => {
            state.restTimerRemaining--;
            if (state.restTimerRemaining <= 0) {
                clearInterval(state.restTimerInterval);
                box.style.display = 'none';
                Native.vibrate(450);
                AudioService.playTimerDone();
                Native.toast('Descanso concluído! Hora da próxima série.');
            } else {
                updateTimerText();
            }
        }, 1000);
    }

    document.getElementById('btn-timer-add30').addEventListener('click', () => {
        state.restTimerRemaining += 30;
    });

    document.getElementById('btn-timer-sub10').addEventListener('click', () => {
        state.restTimerRemaining = Math.max(0, state.restTimerRemaining - 10);
    });

    document.getElementById('btn-timer-skip').addEventListener('click', () => {
        clearInterval(state.restTimerInterval);
        document.getElementById('player-rest-timer-box').style.display = 'none';
    });

    function finishWorkoutSession() {
        clearInterval(state.activeWorkoutInterval);
        clearInterval(state.restTimerInterval);
        document.getElementById('player-rest-timer-box').style.display = 'none';

        const elapsedSecs = Math.floor((Date.now() - state.activeWorkoutStartTime) / 1000);
        const durationMins = Math.max(1, Math.round(elapsedSecs / 60));

        let completedSetsCount = 0;
        state.activeWorkout.exercises.forEach(ex => {
            if (ex.setsData) {
                completedSetsCount += ex.setsData.filter(s => s.completed).length;
            }
        });

        // Registrar no histórico
        const historyEntry = {
            id: 'hist_' + Date.now(),
            date: new Date().toISOString(),
            workoutTitle: state.activeWorkout.title,
            durationMins: durationMins,
            exercisesCount: state.activeWorkout.exercises.length,
            completedSets: completedSetsCount
        };

        state.history.unshift(historyEntry);
        saveHistory();

        // Fechar player e exibir resumo
        document.getElementById('modal-workout-player').classList.remove('active');
        Native.keepScreenOn(false);
        Native.vibrate(200);
        AudioService.playTimerDone();

        document.getElementById('summary-duration').textContent = `${durationMins}m`;
        document.getElementById('summary-exercises').textContent = state.activeWorkout.exercises.length;
        document.getElementById('summary-sets').textContent = completedSetsCount;

        openModal('modal-workout-summary');
    }

    function stopActiveWorkout() {
        clearInterval(state.activeWorkoutInterval);
        clearInterval(state.restTimerInterval);
        document.getElementById('modal-workout-player').classList.remove('active');
        document.getElementById('player-rest-timer-box').style.display = 'none';
        Native.keepScreenOn(false);
        state.activeWorkout = null;
    }

    // --- History View ---
    function renderHistory() {
        const list = document.getElementById('history-list');
        const empty = document.getElementById('history-empty-state');
        list.innerHTML = '';

        if (state.history.length === 0) {
            empty.style.display = 'flex';
            document.getElementById('stat-total-workouts').textContent = '0';
            document.getElementById('stat-total-sets').textContent = '0';
            document.getElementById('stat-total-minutes').textContent = '0h';
            return;
        }

        empty.style.display = 'none';

        let totalSets = 0;
        let totalMinutes = 0;

        state.history.forEach(item => {
            totalSets += item.completedSets || 0;
            totalMinutes += item.durationMins || 0;

            const date = new Date(item.date);
            const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

            const row = document.createElement('div');
            row.className = 'workout-card';
            row.style.padding = '12px 16px';
            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong>${item.workoutTitle}</strong>
                    <span style="font-size: 11px; color: var(--text-muted);">${dateStr}</span>
                </div>
                <div class="workout-meta-row" style="margin-top: 6px;">
                    <span class="meta-item">${Icons.clock} ${item.durationMins} min</span>
                    <span class="meta-item">${Icons.check} ${item.completedSets} séries</span>
                    <span class="meta-item">${Icons.dumbbellMini} ${item.exercisesCount} exercícios</span>
                </div>
            `;
            list.appendChild(row);
        });

        document.getElementById('stat-total-workouts').textContent = state.history.length;
        document.getElementById('stat-total-sets').textContent = totalSets;
        document.getElementById('stat-total-minutes').textContent = `${(totalMinutes / 60).toFixed(1)}h`;
    }

    document.getElementById('btn-clear-history').addEventListener('click', () => {
        if (confirm('Deseja apagar todo o histórico de treinos?')) {
            state.history = [];
            saveHistory();
            Native.toast('Histórico apagado');
        }
    });

    // --- Settings Controls & Offline Status ---
    function setupSettingsControls() {
        const toggleScreen = document.getElementById('toggle-keep-screen');
        const toggleVib = document.getElementById('toggle-vibration');
        const toggleSnd = document.getElementById('toggle-sound');

        toggleScreen.checked = state.settings.keepScreen;
        toggleVib.checked = state.settings.vibration;
        toggleSnd.checked = state.settings.sound;

        toggleScreen.addEventListener('change', (e) => {
            state.settings.keepScreen = e.target.checked;
            saveSettings();
        });
        toggleVib.addEventListener('change', (e) => {
            state.settings.vibration = e.target.checked;
            saveSettings();
        });
        toggleSnd.addEventListener('change', (e) => {
            state.settings.sound = e.target.checked;
            saveSettings();
        });
    }

    async function checkOfflineStatus() {
        const badge = document.getElementById('settings-gif-badge');
        const desc = document.getElementById('settings-storage-desc');
        const pathEl = document.getElementById('settings-storage-path');

        // Check Native Bridge or local HTTP endpoint
        const info = Native.getStorageInfo();
        if (info) {
            pathEl.textContent = info.gifsPath;
            desc.textContent = `${info.localGifsCount} de ${info.totalExpected} GIFs sincronizados localmente`;
            badge.textContent = `${info.localGifsCount} / ${info.totalExpected} offline`;
            return;
        }

        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (data && data.status === 'ok') {
                desc.textContent = `${data.localGifsCount} de 963 GIFs prontos no aparelho`;
                pathEl.textContent = data.path;
                badge.textContent = `${data.localGifsCount} / 963 offline`;
            }
        } catch (_) {
            badge.textContent = 'Modo Navegador';
        }
    }

    // Start App
    window.addEventListener('DOMContentLoaded', init);

    // Expose for inspection and devtools
    window.state = state;
    window.startWorkout = startWorkout;

})();
