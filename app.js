(function() {
    'use strict';

    // Emergency Error Display for Debugging
    window.onerror = function(msg, url, line, col, error) {
        const div = document.createElement('div');
        div.style.position = 'fixed';
        div.style.top = '0';
        div.style.left = '0';
        div.style.width = '100%';
        div.style.backgroundColor = 'red';
        div.style.color = 'white';
        div.style.zIndex = '9999';
        div.style.padding = '10px';
        div.style.fontSize = '12px';
        div.innerText = 'ERROR: ' + msg + ' at ' + line + ':' + col + '\nStack: ' + (error ? error.stack : 'N/A');
        document.body.appendChild(div);
        return false;
    };

    // --- Configuration & Constants ---
    // Patch for legacy filters in PixiJS v8
    if (typeof PIXI !== 'undefined') {
        PIXI.settings = PIXI.settings || {};
        PIXI.settings.FILTER_RESOLUTION = 1;
    }
    const MASS_ALPHA = 3727;
    const MASS_BETA = 0.511;
    const MASS_MUON = 105.6;

    // --- DOM Elements ---
    const canvas = document.getElementById('chamberCanvas');
    let pixiApp = null;
    let particleContainer = null;
    let glowTexture = null;
    const alphaToggle = document.getElementById('showAlpha');
    const betaToggle = document.getElementById('showBeta');
    
    // View switching elements
    const liveView = document.getElementById('live-chamber');
    const morphologyView = document.getElementById('morphology-view');
    const energyView = document.getElementById('energy-view');
    const momentumView = document.getElementById('momentum-view');
    const btnPrev = document.getElementById('nav-prev');
    const btnNext = document.getElementById('nav-next');
    const haltAlertPulse = document.getElementById('halt-alert-pulse');

    // --- Simulation State ---
    class RingBuffer {
        constructor(capacity) {
            this.capacity = capacity;
            this.buffer = new Array(capacity);
            this.head = 0;
            this.size = 0;
            this.totalPushed = 0; // Global sequence counter
        }

        push(item) {
            const oldItem = this.buffer[this.head];
            this.buffer[this.head] = item;
            this.head = (this.head + 1) % this.capacity;
            this.size = Math.min(this.size + 1, this.capacity);
            this.totalPushed++;
            return oldItem;
        }

        /**
         * Returns all items pushed since the provided sequence number.
         * Only returns items still present in the buffer.
         */
        getSince(startSeq) {
            const count = this.totalPushed - startSeq;
            if (count <= 0) return [];
            
            const result = [];
            const available = Math.min(count, this.size);
            for (let i = 0; i < available; i++) {
                // Calculate index relative to current head
                const idx = (this.head - available + i + this.capacity) % this.capacity;
                result.push(this.buffer[idx]);
            }
            return result;
        }

        toArray() {
            if (this.size < this.capacity) {
                return this.buffer.slice(0, this.size);
            }
            return this.buffer.slice(this.head).concat(this.buffer.slice(0, this.head));
        }

        forEach(callback) {
            const available = this.size;
            for (let i = 0; i < available; i++) {
                const idx = (this.head - available + i + this.capacity) % this.capacity;
                callback(this.buffer[idx], i);
            }
        }
    }

    const state = {
        magneticField: false,
        showAlpha: alphaToggle.checked,
        showBeta: betaToggle.checked,
        audioEnabled: false,
        glowEnabled: true,
        halted: false,
        width: 0,
        height: 0,
        spawnMinX: 0,
        spawnMaxX: 0,
        activeView: 'live', // 'live', 'morphology', or 'energy'
        isTransitioning: false,
        touchStartX: 0,
        trails: [],
        buffers: {
            density: null,
            densityCtx: null,
            scale: 0.25
        },
        charts: {
            scatter: null,
            histogram: null,
            momentum: null
        },
        dashboard: {
            dirty: false,
            scatterMag: false
        },
        stats: {
            alpha: { meanX: 0, meanY: 0, sdX: 0, sdY: 0, sumX: 0, sumX2: 0, sumY: 0, sumY2: 0, count: 0 },
            beta: { meanX: 0, meanY: 0, sdX: 0, sdY: 0, sumX: 0, sumX2: 0, sumY: 0, sumY2: 0, count: 0 }
        },
        playing: false,
        liveAlphaData: new RingBuffer(3000),
        liveBetaData: new RingBuffer(3000),
        liveMuonData: new RingBuffer(1000)
    };

    const particles = [];
    const SPAWN_RATE = 20; // Approximately 20 new events per second
    let lastTime = 0;
    let spawnAccumulator = 0;
    let animationId = null;
    
    // Verification counters (Task 3)
    let totalSpawned = 0;
    let alphaCount = 0;
    let betaCount = 0;
    let lifetimeAlphaCount = 0;
    let lifetimeBetaCount = 0;
    let lastLogTime = 0;
    let lastHUDUpdateTime = 0;

    /**
     * Map histogram bins to Chart.js Error Bar format.
     */
    const mapBins = (bins) => bins.map(v => ({
        y: v,
        yMin: v - Math.sqrt(v),
        yMax: v + Math.sqrt(v)
    }));

    /**
     * Compute mean and standard deviation for Alpha and Beta populations using O(1) sums.
     */
    function calculateStats() {
        const update = (s) => {
            if (s.count === 0) return;
            s.meanX = s.sumX / s.count;
            s.meanY = s.sumY / s.count;
            
            // Variance = (SumX2 / N) - MeanX^2
            const varX = Math.max(0, (s.sumX2 / s.count) - (s.meanX ** 2));
            const varY = Math.max(0, (s.sumY2 / s.count) - (s.meanY ** 2));
            
            s.sdX = Math.sqrt(varX);
            s.sdY = Math.sqrt(varY);
        };

        update(state.stats.alpha);
        update(state.stats.beta);
    }

    /**
     * Throttled haptic engine for mobile UX
     */
    function vibrate(duration) {
        if (navigator.vibrate && state.audioEnabled) {
            try { navigator.vibrate(duration); } catch(e) {}
        }
    }

    const Haptics = {
        lastPulseTime: 0,
        pulse(type) {
            const now = performance.now();
            if (now - this.lastPulseTime < 100) return;
            
            if (type === 'alpha') vibrate(15);
            else if (type === 'beta') vibrate(5);
            this.lastPulseTime = now;
        }
    };

    /**
     * Synthesized Geiger counter audio engine.
     */
    const Geiger = {
        ctx: null,
        init() {
            if (this.ctx) return;
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        },
        playClick(type) {
            if (!state.audioEnabled) return;
            this.init();
            if (this.ctx.state === 'suspended') this.ctx.resume();

            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            // Synthesis settings
            const freq = type === 'alpha' ? 800 : 400;
            const vol = type === 'alpha' ? 0.1 : 0.05;
            const duration = 0.005;

            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(10, this.ctx.currentTime + duration);

            gain.gain.setValueAtTime(vol, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        }
    };

    /**
     * Represents a radiation particle track.
     * Task 4: Particle Rendering Algorithms.
     */
    class Particle {
        constructor(x, y, type, metadata) {
            this.x = x;
            this.y = y;
            this.lastDrawX = x;
            this.lastDrawY = y;
            this.type = type;
            this.active = true;
            this.distanceTravelled = 0;
            this.lastTrailDistance = 0;

            // Task 4: Vector Initialization (Head sprite removed)
            if (this.type === 'beta') {
                this.dashPattern = [2, 2];
            }

            // Task 2: Sync visuals with metadata
            if (metadata) {
                this.angle = metadata.angle;
                this.speed = 2; // Base speed
                // Scaling metadata.length to maintain visible track lengths (~40-200px)
                const scale = (type === 'alpha' || type === 'beta') ? 20 : 1;
                this.lifespan = metadata.length * scale;

                if (this.type === 'muon') {
                    this.speed = 15 + Math.random() * 10;
                    this.lifespan = metadata.length; 
                    this.colour = 'rgba(255, 255, 255, 0.3)';
                    this.lineWidth = 1;
                    this.magneticTurnRate = 0;
                } else if (this.type === 'alpha') {
                    this.magneticTurnRate = 0.015;
                    this.colour = 'rgba(255, 255, 255, 1.0)';
                    this.lineWidth = 3 + Math.random() * 2;
                } else {
                    this.magneticTurnRate = -0.08;
                    this.colour = 'rgba(255, 255, 255, 0.5)';
                    this.lineWidth = 1;
                }
            } else {
                this.angle = Math.random() * Math.PI * 2;
                if (this.type === 'muon') {
                    this.speed = 15 + Math.random() * 10;
                    this.lifespan = 30;
                    this.colour = 'rgba(255, 255, 255, 0.3)';
                    this.lineWidth = 1;
                    this.magneticTurnRate = 0;
                } else if (this.type === 'alpha') {
                    this.magneticTurnRate = 0.015;
                    this.speed = 2 + Math.random() * 2;
                    this.lifespan = 30 + Math.random() * 50;
                    this.colour = 'rgba(255, 255, 255, 1.0)';
                    this.lineWidth = 3 + Math.random() * 2;
                } else {
                    this.magneticTurnRate = -0.08;
                    this.speed = 2 + Math.random() * 2;
                    this.lifespan = 150 + Math.random() * 150;
                    this.colour = 'rgba(255, 255, 255, 0.5)';
                    this.lineWidth = 1;
                }
            }
        }

        /**
         * Update particle position and lifespan.
         */
        update() {
            if (!this.active) {
                return;
            }

            // Trajectory updates
            if (this.type === 'beta') {
                const progress = this.distanceTravelled / this.lifespan;
                const jitterFactor = progress > 0.7 ? 1.5 : 1.0;
                // Random Walk: alter angle slightly per frame
                this.angle += (Math.random() - 0.5) * 0.5 * jitterFactor;
            }

            // Apply Lorentz Force if field is active
            if (state.magneticField) {
                this.angle += this.magneticTurnRate;
            }

            // Move particle
            const progress = this.distanceTravelled / this.lifespan;
            let currentSpeed = this.speed;
            
            // Task 8: Physics Accuracy (Bragg Curve)
            // Particles (especially Alphas) lose energy and slow down more rapidly at the end
            if (this.type === 'alpha' || this.type === 'beta') {
                if (progress > 0.8) {
                    // Decelerate near end
                    currentSpeed *= (1 - (progress - 0.8) * 4);
                    currentSpeed = Math.max(currentSpeed, 0.2);
                }
            }

            this.x += Math.cos(this.angle) * currentSpeed;
            this.y += Math.sin(this.angle) * currentSpeed;

            this.distanceTravelled += currentSpeed;

            // Task 5: Spawn Trail Graphics (Vector Implementation)
            // For Bragg Peak: Increase trail density near the end of Alpha tracks
            const trailThreshold = (this.type === 'alpha' && progress > 0.9) ? 1.0 : (this.type === 'alpha' ? 2.5 : 4);

            if (this.distanceTravelled - this.lastTrailDistance > trailThreshold) {
                this.lastTrailDistance = this.distanceTravelled;
                
                const segment = new PIXI.Graphics();
                
                // Map colors: Alpha -> 0x0096c8, Beta -> 0xa1a1aa, Muon -> 0x71717a
                let segmentColor = 0x71717a;
                if (this.type === 'alpha') segmentColor = 0x0096c8;
                else if (this.type === 'beta') segmentColor = 0xa1a1aa;
                
                // Map width: Alpha thicker, especially at Bragg Peak
                let baseWidth = (this.type === 'alpha') ? 3 : 1.5;
                if (this.type === 'alpha' && progress > 0.9) {
                    baseWidth *= 1.8;
                }
                
                segment.moveTo(this.lastDrawX, this.lastDrawY)
                       .lineTo(this.x, this.y)
                       .stroke({ color: segmentColor, width: baseWidth, cap: 'round' });
                
                this.lastDrawX = this.x;
                this.lastDrawY = this.y;
                
                const initialAlpha = this.type === 'muon' ? 0.15 : 0.4;
                state.trails.push({ graphics: segment, alpha: initialAlpha });
                
                if (particleContainer) {
                    particleContainer.addChild(segment);
                }
            }
            if (this.distanceTravelled >= this.lifespan) {
                this.active = false;
            }
        }

        /**
         * Clean up PixiJS resources.
         */
        destroy() {
            // No sprite to destroy; graphics segments cleaned up by render loop.
        }
    }

    /**
     * Toggle the magnetic field simulation for the scatter chart.
     */
    window.setScatterMag = function(on) {
        state.dashboard.scatterMag = on;
        refreshScatterData();
        state.dashboard.dirty = true;
    };

    /**
     * Re-populates the scatter chart from ring buffers, applying Lorentz physics
     * if the dashboard B-Field is active.
     */
    function refreshScatterData() {
        if (!state.charts.scatter) return;
        
        const getObserved = (p, type) => {
            if (!state.dashboard.scatterMag) return p.tortuosity;
            if (type === 'alpha') return Math.max(0, p.tortuosity - 0.035);
            if (type === 'beta') {
                const noise = (p.energy % 0.3); 
                return 0.2 + noise;
            }
            return p.tortuosity; // Muons unchanged
        };

        const alphaData = [];
        state.liveAlphaData.forEach(p => alphaData.push({ x: p.length, y: getObserved(p, 'alpha') }));
        state.charts.scatter.data.datasets[0].data = alphaData;

        const betaData = [];
        state.liveBetaData.forEach(p => betaData.push({ x: p.length, y: getObserved(p, 'beta') }));
        state.charts.scatter.data.datasets[1].data = betaData;

        const muonData = [];
        state.liveMuonData.forEach(p => muonData.push({ x: p.length, y: getObserved(p, 'muon') }));
        state.charts.scatter.data.datasets[2].data = muonData;

        state.charts.scatter.data.datasets[0].label = `Alpha Particles [${state.liveAlphaData.size}]`;
        state.charts.scatter.data.datasets[1].label = `Beta Particles [${state.liveBetaData.size}]`;
        state.charts.scatter.data.datasets[2].label = `Cosmic Muons [${state.liveMuonData.size}]`;
        
        // Update Y axis min
        state.charts.scatter.options.scales.y.min = state.dashboard.scatterMag ? 0.0 : 0.5;

        state.charts.scatter.update('none');
        }
    /**
     * Render the dashboard components incrementally per-frame.
     */
    function refreshDashboards() {
        if (!state.dashboard.dirty) return;

        calculateStats();

        // Update other charts if they exist
        if (state.charts.scatter) {
            refreshScatterData();
        }

        if (state.charts.histogram) {
            const alphaEnergyBins = new Array(10).fill(0);
            const betaEnergyBins = new Array(10).fill(0);

            state.liveAlphaData.forEach(p => {
                const newBin = Math.floor(p.energy);
                if (!isNaN(newBin) && newBin >= 0 && newBin <= 9) {
                    alphaEnergyBins[newBin]++;
                }
            });

            state.liveBetaData.forEach(p => {
                const newBin = Math.floor(p.energy);
                if (!isNaN(newBin) && newBin >= 0 && newBin <= 9) {
                    betaEnergyBins[newBin]++;
                }
            });

            // Initialize previous bins state if missing
            if (!state.prevAlphaBins) state.prevAlphaBins = new Array(10).fill(0);
            if (!state.prevBetaBins) state.prevBetaBins = new Array(10).fill(0);

            // Re-create gradients since we need them here
            const ctx = document.getElementById('histogramChart').getContext('2d');
            const gradientBlue = ctx.createLinearGradient(0, 0, 0, 400);
            gradientBlue.addColorStop(0, 'rgba(0, 150, 200, 0.8)');
            gradientBlue.addColorStop(1, 'rgba(0, 150, 200, 0.1)');
            
            const gradientGrey = ctx.createLinearGradient(0, 0, 0, 400);
            gradientGrey.addColorStop(0, 'rgba(161, 161, 170, 0.8)');
            gradientGrey.addColorStop(1, 'rgba(161, 161, 170, 0.1)');

            // Assign static gradients for constant smoothness
            state.charts.histogram.data.datasets[0].backgroundColor = gradientBlue;
            state.charts.histogram.data.datasets[1].backgroundColor = gradientGrey;

            state.charts.histogram.data.datasets[0].data = mapBins(alphaEnergyBins);
            state.charts.histogram.data.datasets[1].data = mapBins(betaEnergyBins);
            
            state.charts.histogram.data.datasets[0].label = `Alpha (MeV) [${state.liveAlphaData.size}]`;
            state.charts.histogram.data.datasets[1].label = `Beta (MeV) [${state.liveBetaData.size}]`;
            state.charts.histogram.update('none');
        }

        if (state.charts.momentum) {
            const alphaMass = MASS_ALPHA;
            const betaMass = MASS_BETA;
            const muonMass = MASS_MUON;
            
            // Create logarithmic bins from 0.1 to 2000. 
            // High resolution (1000 bins) ensures high-momentum discrete events (Alphas, Muons) 
            // render as sharp spikes rather than wide multi-bin blocks.
            const numBins = 1000;
            const minLog = -1; // log10(0.1)
            const maxLog = Math.log10(2000);  // log10(2000)
            
            let alphaBins = new Array(numBins).fill(0);
            let betaBins = new Array(numBins).fill(0);
            let muonBins = new Array(numBins).fill(0);

            const addToLogBin = (mom, binsArray) => {
                if (mom <= 0) return;
                const logMom = Math.log10(mom);
                if (logMom < minLog || logMom >= maxLog) return;
                const binIdx = Math.floor(((logMom - minLog) / (maxLog - minLog)) * numBins);
                binsArray[binIdx]++;
            };

            state.liveAlphaData.forEach(p => {
                const mom = Math.sqrt(p.energy ** 2 + 2 * alphaMass * p.energy); // Relativistic
                addToLogBin(mom, alphaBins);
            });

            state.liveBetaData.forEach(p => {
                const mom = Math.sqrt(p.energy ** 2 + 2 * betaMass * p.energy); // Relativistic
                addToLogBin(mom, betaBins);
            });

            state.liveMuonData.forEach(p => {
                const mom = Math.sqrt(p.energy ** 2 + 2 * muonMass * p.energy); // Relativistic
                addToLogBin(mom, muonBins);
            });

            // Map arrays to {x, y} format for Chart.js using bin centers
            const mapToDataset = (binsArray) => {
                return binsArray.map((count, i) => {
                    const logCenter = minLog + ((i + 0.5) / numBins) * (maxLog - minLog);
                    return { 
                        x: Math.pow(10, logCenter), 
                        y: count,
                        yMin: count > 0 ? count - Math.sqrt(count) : 0,
                        yMax: count > 0 ? count + Math.sqrt(count) : 0
                    };
                });
            };

            state.charts.momentum.data.datasets[0].data = mapToDataset(alphaBins);
            state.charts.momentum.data.datasets[1].data = mapToDataset(betaBins);
            state.charts.momentum.data.datasets[2].data = mapToDataset(muonBins);
            
            state.charts.momentum.data.datasets[0].label = `Alpha (MeV/c) [${state.liveAlphaData.size}]`;
            state.charts.momentum.data.datasets[1].label = `Beta (MeV/c) [${state.liveBetaData.size}]`;
            state.charts.momentum.data.datasets[2].label = `Cosmic Muons (MeV/c) [${state.liveMuonData.size}]`;
            
            state.charts.momentum.update('none');
        }

        state.dashboard.dirty = false;
    }

    /**
     * Switch between Live Chamber and Analytics Dashboard.
     */
    function switchView(view, direction = 'next') {
        if (state.activeView === view || state.isTransitioning) return;

        state.isTransitioning = true;
        const slideClass = direction === 'next' ? 'slide-left' : 'slide-right';

        // 0. Update Nav Arrow Theme & Force Repaint Immediately
        const navArrows = document.querySelectorAll('.side-nav-arrow');
        navArrows.forEach(btn => {
            if (view === 'live') {
                btn.classList.add('theme-dark');
                btn.classList.remove('theme-light');
            } else {
                btn.classList.add('theme-light');
                btn.classList.remove('theme-dark');
            }
            void btn.offsetHeight; // Force immediate repaint
        });

        const viewMap = {
            'live': { el: liveView, display: 'flex' },
            'morphology': { el: morphologyView, display: 'block' },
            'energy': { el: energyView, display: 'block' },
            'momentum': { el: momentumView, display: 'block' }
        };

        const currentView = viewMap[state.activeView];
        const nextView = viewMap[view];

        // 1. Mark current view as exiting
        if (currentView && currentView.el) {
            currentView.el.classList.add('exiting', slideClass);
        }

        // 3. Middle of transition: Swap displays
        setTimeout(async () => {
            // 2. Update state - delayed until physical swap to keep old view rendering
            state.activeView = view;

            // Force repaint again during swap
            navArrows.forEach(btn => { void btn.offsetHeight; });

            // Handle halt overlay visibility if simulation is finished
            if (state.halted) {
                document.getElementById('halt-overlay').style.display = (view === 'live') ? 'block' : 'none';
            }

            if (currentView && currentView.el) {
                currentView.el.style.display = 'none';
                currentView.el.classList.remove('exiting', slideClass);
            }

            if (nextView && nextView.el) {
                nextView.el.style.display = nextView.display;
                nextView.el.classList.add('entering', slideClass);

                // Trigger layout-heavy updates immediately after display: block to prevent snaps
                if (view === 'live') {
                    await initialiseCanvas();
                } else if (view === 'morphology') {
                    if (!state.charts.scatter) renderScatter();
                    else state.charts.scatter.resize();
                } else if (view === 'energy') {
                    if (!state.charts.histogram) renderHistogram();
                    else state.charts.histogram.resize();
                } else if (view === 'momentum') {
                    if (!state.charts.momentum) renderMomentumChart();
                    else state.charts.momentum.resize();
                }
            }
        }, 400);

        // 4. End of transition: Cleanup
        setTimeout(() => {
            if (nextView && nextView.el) {
                nextView.el.classList.remove('entering', slideClass);
            }

            if (view !== 'live') state.dashboard.dirty = true;
            state.isTransitioning = false;

            // Final force repaint when animations finish
            navArrows.forEach(btn => { void btn.offsetHeight; });
        }, 800);
    }

    const externalTooltipHandler = (context) => {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');

        // Create element on first render
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'chartjs-tooltip';
            document.body.appendChild(tooltipEl);
        }

        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        if (tooltipModel.opacity === 0) {
            tooltipEl.style.opacity = 0;
            return;
        }

        // Set Text
        if (tooltipModel.body) {
            const bodyLines = tooltipModel.body.map(b => b.lines);
            let innerHtml = '<div>';
            bodyLines.forEach(line => {
                innerHtml += `<div style="margin-bottom: 4px;">${line}</div>`;
            });
            innerHtml += '</div>';
            tooltipEl.innerHTML = innerHtml;
        }

        const position = context.chart.canvas.getBoundingClientRect();

        // Display, position, and set styles for font
        tooltipEl.style.opacity = 1;
        tooltipEl.style.left = position.left + window.pageXOffset + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY - 10 + 'px';
        tooltipEl.style.padding = tooltipModel.options.padding + 'px ' + tooltipModel.options.padding + 'px';
    };

    const confidenceEllipsePlugin = {
        id: 'confidenceEllipse',
        beforeDatasetsDraw(chart) {
            const { ctx, scales: { x, y } } = chart;
            
            const drawEllipseForDataset = (datasetIndex, baseColor) => {
                const dataset = chart.data.datasets[datasetIndex];
                const points = dataset.data;
                const n = points.length;
                
                // Require at least 3 points to form a statistically meaningful ellipse
                if (n < 3) return;

                // 1. Calculate Mean (Center of mass)
                let sumX = 0, sumY = 0;
                for (let i = 0; i < n; i++) {
                    sumX += points[i].x;
                    sumY += points[i].y;
                }
                const meanX = sumX / n;
                const meanY = sumY / n;

                // 2. Calculate Standard Deviation (Spread)
                let sqDiffX = 0, sqDiffY = 0;
                for (let i = 0; i < n; i++) {
                    sqDiffX += Math.pow(points[i].x - meanX, 2);
                    sqDiffY += Math.pow(points[i].y - meanY, 2);
                }
                const sdX = Math.sqrt(sqDiffX / n);
                const sdY = Math.sqrt(sqDiffY / n);

                // 3. Map mathematical values to canvas pixel coordinates
                const centerX = x.getPixelForValue(meanX);
                const centerY = y.getPixelForValue(meanY);
                
                // 2-Sigma Radius (~95% confidence interval)
                const radiusX = Math.abs(x.getPixelForValue(meanX + 2 * sdX) - centerX);
                const radiusY = Math.abs(y.getPixelForValue(meanY + 2 * sdY) - centerY);

                // 4. Render the Ellipse
                ctx.save();
                ctx.beginPath();
                ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
                
                // Slightly deeper transparent fill
                ctx.fillStyle = baseColor + '26'; // approx 0.15 opacity in hex (26/255)
                ctx.fill();
                
                // Thicker, fully opaque dashed border
                ctx.lineWidth = 3; 
                ctx.strokeStyle = baseColor; 
                ctx.setLineDash([8, 6]);     // Longer dashes, wider gaps
                ctx.stroke();
                
                ctx.restore();
            };

            // Draw for Dataset 0 (Alpha) and Dataset 1 (Beta)
            drawEllipseForDataset(0, '#0096c8'); // Alpha
            drawEllipseForDataset(1, '#a1a1aa'); // Beta
        }
    };

    /**
     * Render the Scatter Chart using Chart.js.
     */
    function renderScatter() {

        
        const ctx = document.getElementById('scatterChart').getContext('2d');

        if (state.charts.scatter) return;

        const chartConfig = {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        label: 'Alpha Particles',
                        data: [],
                        backgroundColor: '#0096c899',
                        pointRadius: 1.5,
                        parsing: false
                    },
                    {
                        label: 'Beta Particles',
                        data: [],
                        backgroundColor: '#a1a1aa4d',
                        pointRadius: 1.5,
                        parsing: false
                    },
                    {
                        label: 'Cosmic Muons',
                        data: [],
                        backgroundColor: '#71717a33',
                        pointRadius: 1.5,
                        parsing: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuart'
                },

                plugins: {
                    legend: { 
                        position: 'top',
                        labels: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b',
                            padding: window.innerWidth < 480 ? 8 : 20,
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        enabled: false,
                        position: 'nearest',
                        external: externalTooltipHandler
                    }
                },
                scales: {
                    x: {
                        title: { 
                            display: true, 
                            text: 'Track Length (pixels)',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        min: 0,
                        max: 30,
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Tortuosity Index',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        min: 0.5,
                        max: 1.05,
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    }
                },
                
            },
            plugins: [confidenceEllipsePlugin]
        };

        state.charts.scatter = new Chart(ctx, chartConfig);

        refreshScatterData();
    }

    /**
     * Render the Energy Histogram using Chart.js.
     */
    function renderHistogram() {
        const ctx = document.getElementById('histogramChart').getContext('2d');

        if (state.charts.histogram) return;

        // Bin labels (Range 0-9)
        const bins = Array.from({ length: 10 }, (_, i) => i);

        // Gradient Definitions
        const gradientBlue = ctx.createLinearGradient(0, 0, 0, 400);
        gradientBlue.addColorStop(0, 'rgba(0, 150, 200, 0.8)');
        gradientBlue.addColorStop(1, 'rgba(0, 150, 200, 0.1)');
        
        const gradientGrey = ctx.createLinearGradient(0, 0, 0, 400);
        gradientGrey.addColorStop(0, 'rgba(161, 161, 170, 0.8)');
        gradientGrey.addColorStop(1, 'rgba(161, 161, 170, 0.1)');

        const chartConfig = {
            type: 'barWithErrorBars',
            data: {
                labels: bins.map(b => `${b}-${b+1}`),
                datasets: [
                    {
                        label: 'Alpha (MeV)',
                        grouped: false,
                        data: mapBins(new Array(10).fill(0)),
                        backgroundColor: gradientBlue,
                        errorBarLineWidth: 2,
                        errorBarColor: '#0096c8cc',
                        barPercentage: 1.0,
                        categoryPercentage: 1.0
                    },
                    {
                        label: 'Beta (MeV)',
                        grouped: false,
                        data: mapBins(new Array(10).fill(0)),
                        backgroundColor: gradientGrey,
                        errorBarLineWidth: 2,
                        errorBarColor: '#a1a1aa80',
                        barPercentage: 1.0,
                        categoryPercentage: 1.0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuart'
                },
                scales: {
                    x: {
                        title: { 
                            display: true, 
                            text: 'Energy Range (MeV)',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Event Frequency',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    }
                },
                plugins: {
                    legend: {
                        labels: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b',
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        enabled: false,
                        position: 'nearest',
                        external: externalTooltipHandler
                    }
                }
            }
        };

        state.charts.histogram = new Chart(ctx, chartConfig);
    }

    /**
     * Render the Momentum Spectrum using Chart.js.
     */
    function renderMomentumChart() {
        const ctx = document.getElementById('momentumChart').getContext('2d');

        if (state.charts.momentum) return;

        // Gradient Definitions
        const gradientBlue = ctx.createLinearGradient(0, 0, 0, 400);
        gradientBlue.addColorStop(0, 'rgba(0, 150, 200, 0.8)');
        gradientBlue.addColorStop(1, 'rgba(0, 150, 200, 0.1)');
        
        const gradientGrey = ctx.createLinearGradient(0, 0, 0, 400);
        gradientGrey.addColorStop(0, 'rgba(161, 161, 170, 0.8)');
        gradientGrey.addColorStop(1, 'rgba(161, 161, 170, 0.1)');

        const gradientDarkGrey = ctx.createLinearGradient(0, 0, 0, 400);
        gradientDarkGrey.addColorStop(0, 'rgba(113, 113, 122, 0.8)');
        gradientDarkGrey.addColorStop(1, 'rgba(113, 113, 122, 0.1)');

        const chartConfig = {
            type: 'lineWithErrorBars', // --- Changed from 'line' ---
            data: {
                datasets: [
                    {
                        label: 'Alpha (MeV/c)',
                        data: [],
                        borderColor: '#0096c8',
                        backgroundColor: gradientBlue,
                        borderWidth: 0,
                        barPercentage: 1.0,
                        categoryPercentage: 1.0,
                        
                        // --- THE HARD-DISABLE FOR POINTS ---
                        pointStyle: false,         // Completely skips point geometry rendering
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        pointBorderWidth: 0,       // Prevents the border stroke from rendering at 5x scale
                        pointBorderColor: 'transparent',
                        pointBackgroundColor: 'transparent',
                        
                        // --- VERTICAL ERROR LINE ---
                        errorBarColor: '#0096c866',
                        errorBarLineWidth: 1,
                        
                        // --- FORCE HIDE WHISKERS (CAPS) ---
                        errorBarWhiskerLineWidth: 0,
                        errorBarWhiskerRatio: 0,
                        errorBarWhiskerColor: 'transparent',
                        
                        stepped: 'middle',
                        fill: true
                    },
                    {
                        label: 'Beta (MeV/c)',
                        data: [],
                        borderColor: '#a1a1aa',
                        backgroundColor: gradientGrey,
                        borderWidth: 0,
                        barPercentage: 1.0,
                        categoryPercentage: 1.0,
                        
                        pointStyle: false,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        pointBorderWidth: 0,
                        pointBorderColor: 'transparent',
                        pointBackgroundColor: 'transparent',
                        
                        errorBarColor: '#a1a1aa66',
                        errorBarLineWidth: 1,
                        errorBarWhiskerLineWidth: 0,
                        errorBarWhiskerRatio: 0,
                        errorBarWhiskerColor: 'transparent',
                        
                        stepped: 'middle',
                        fill: true
                    },
                    {
                        label: 'Cosmic Muons (MeV/c)',
                        data: [],
                        borderColor: '#71717a',
                        backgroundColor: gradientDarkGrey,
                        borderWidth: 0,
                        barPercentage: 1.0,
                        categoryPercentage: 1.0,
                        
                        pointStyle: false,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        pointBorderWidth: 0,
                        pointBorderColor: 'transparent',
                        pointBackgroundColor: 'transparent',
                        
                        errorBarColor: '#71717a4d',
                        errorBarLineWidth: 1,
                        errorBarWhiskerLineWidth: 0,
                        errorBarWhiskerRatio: 0,
                        errorBarWhiskerColor: 'transparent',
                        
                        stepped: 'middle',
                        fill: true
                    }
                ]
            },
    
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuart'
                },

                elements: {
                    point: {
                        radius: 0,
                        hitRadius: 0,
                        hoverRadius: 0
                    }
                },

                


                
                scales: {
                    x: {
                        type: 'logarithmic',
                        position: 'bottom',
                        min: 0.1,
                        max: 2000,
                        title: { 
                            display: true, 
                            text: 'Momentum (MeV/c)',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Event Frequency',
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b'
                        },
                        ticks: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 9 : 13 },
                            color: '#71717a',
                            autoSkip: true,
                            maxTicksLimit: window.innerWidth < 480 ? 6 : 10
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)', borderDash: [4, 4], drawTicks: false },
                        border: { display: false }
                    }
                },
                plugins: {
                    legend: { 
                        labels: { 
                            font: { family: "'Geist', sans-serif", weight: '500', size: window.innerWidth < 480 ? 10 : 14 },
                            color: '#52525b',
                            usePointStyle: true,
                            pointStyle: 'circle'
                        } 
                    },
                    tooltip: {
                        enabled: false,
                        position: 'nearest',
                        external: externalTooltipHandler
                    }
                }
            }
        };

        state.charts.momentum = new Chart(ctx, chartConfig);
    }

    /**
     * Create a glowing radial gradient texture for particles.
     */
    function createGlowTexture(app) {
        const size = 32;
        const radius = size / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        const grad = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        
        return PIXI.Texture.from(canvas);
    }

    /**
     * Initialise the PixiJS application and canvas dimensions.
     */
    async function initialiseCanvas() {
        const viewport = document.getElementById('simulation-viewport');
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        // Prevent collapse to 0 when viewport is hidden
        const viewportWidth = (viewport && viewport.clientWidth > 0) ? viewport.clientWidth : (state.width || window.innerWidth || 800);
        const viewportHeight = (viewport && viewport.clientHeight > 0) ? viewport.clientHeight : (state.height || window.innerHeight || 500);

        state.width = viewportWidth;
        state.height = viewportHeight;

        if (!pixiApp) {
            pixiApp = new PIXI.Application();
            await pixiApp.init({
                canvas: canvas,
                width: viewportWidth,
                height: viewportHeight,
                resolution: ratio,
                autoDensity: true,
                background: 0x000000,
                antialias: true,
                clearBeforeRender: true
            });
            glowTexture = createGlowTexture(pixiApp);

            // Using standard Container because v8 ParticleContainer requires a different Particle API
            particleContainer = new PIXI.Container();
            
            // Add Cinematic Bloom (Task 7: Visuals)
            const filterWrapper = new PIXI.Container();
            
            if (PIXI.filters && PIXI.filters.AdvancedBloomFilter) {
                const bloomFilter = new PIXI.filters.AdvancedBloomFilter({
                    threshold: 0.4,
                    bloomScale: 1.5,
                    brightness: 1.2,
                    blur: 6,
                    quality: 3
                });
                filterWrapper.filters = [bloomFilter];
            }
            
            filterWrapper.addChild(particleContainer);
            pixiApp.stage.addChild(filterWrapper);
        } else {
            pixiApp.renderer.resize(viewportWidth, viewportHeight);
        }

        // Calculate spawn boundaries based on UI docks
        const controlsDock = document.getElementById('live-controls-dock');
        const hudDock = document.getElementById('live-hud');

        if (window.innerWidth > 800 && controlsDock && hudDock) {
            const controlsRect = controlsDock.getBoundingClientRect();
            const hudRect = hudDock.getBoundingClientRect();
            state.spawnMinX = controlsRect.right;
            state.spawnMaxX = hudRect.left;
        } else {
            state.spawnMinX = 0;
            state.spawnMaxX = state.width;
        }

        console.log(`initialiseCanvas: PIXI.Application initialised. Resolution: ${viewportWidth}x${viewportHeight} @ ${ratio}x`);
    }
    /**
     * Event listener for window resizing.
     */
    async function handleResize() {
        await initialiseCanvas();
        // Force refresh on resize to avoid stretched visuals
        state.dashboard.dirty = true;
    }

    /**
     * Update state based on UI interactions.
     */
    function updateState() {
        state.showAlpha = alphaToggle.checked;
        state.showBeta = betaToggle.checked;
    }

    /**
     * Records particle metadata for analytics using jStat distributions.     * Incremental updates for O(1) performance.
     * @param {string} type - 'alpha' or 'beta'
     * @param {number} startX - Origin X coordinate
     * @param {number} startY - Origin Y coordinate
     * @param {object} metadata - Pre-generated physics metadata
     */
    function logParticleMetadata(type, startX, startY, metadata) {
        try {
            if (typeof jStat === 'undefined' && !metadata) return;
            let newItem = metadata, oldItem, chartIdx;

            if (type === 'alpha') {
                oldItem = state.liveAlphaData.push(newItem);
                chartIdx = 0;
            } else if (type === 'beta') {
                oldItem = state.liveBetaData.push(newItem);
                chartIdx = 1;
            } else if (type === 'muon') {
                state.liveMuonData.push(newItem);
                
                if (state.charts.scatter) {
                    const chartData = state.charts.scatter.data.datasets[2].data;
                    const buffer = state.liveMuonData;
                    const item = { x: newItem.length, y: newItem.tortuosity };

                    if (chartData.length < buffer.capacity) {
                        chartData.push(item);
                    } else {
                        const idx = (buffer.head - 1 + buffer.capacity) % buffer.capacity;
                        chartData[idx] = item;
                    }
                }
                state.dashboard.dirty = true;
                return;
            } else {
                return;
            }

            // --- Maintain O(1) Running Sums ---
            const target = type === 'alpha' ? state.stats.alpha : state.stats.beta;
            
            // Subtract old item if it was shifted out
            if (oldItem) {
                target.sumX -= oldItem.length;
                target.sumX2 -= (oldItem.length ** 2);
                target.sumY -= oldItem.tortuosity;
                target.sumY2 -= (oldItem.tortuosity ** 2);
                target.count--;
            }
            
            // Add new item
            target.sumX += newItem.length;
            target.sumX2 += (newItem.length ** 2);
            target.sumY += newItem.tortuosity;
            target.sumY2 += (newItem.tortuosity ** 2);
            target.count++;

            // Incremental Scatter Updates
            if (state.charts.scatter) {
                const chartData = state.charts.scatter.data.datasets[chartIdx].data;
                const buffer = type === 'alpha' ? state.liveAlphaData : state.liveBetaData;
                
                const getObserved = (p, t) => {
                    if (!state.dashboard.scatterMag) return p.tortuosity;
                    if (t === 'alpha') return Math.max(0, p.tortuosity - 0.035);
                    const noise = (p.energy % 0.3);
                    return 0.2 + noise;
                };

                const displayTort = getObserved(newItem, type);

                if (chartData.length < buffer.capacity) {
                    chartData.push({ x: newItem.length, y: displayTort });
                } else {
                    const idx = (buffer.head - 1 + buffer.capacity) % buffer.capacity;
                    chartData[idx] = { x: newItem.length, y: displayTort };
                }
            }

            state.dashboard.dirty = true;
        } catch (e) {
            console.error('Metadata Log Error:', e);
        }
    }

    /**
     * Generates physical metadata for a particle using jStat distributions.
     */
    function generateMetadata(type, startX, startY) {
        if (typeof jStat === 'undefined') return null;
        let len, eng, tort, angle;

        if (type === 'alpha') {
            const stage = Math.floor(Math.random() * 3);
            if (stage === 0) {
                len = jStat.normal.sample(2.5, 0.2);
                eng = jStat.normal.sample(5.49, 0.05);
            } else if (stage === 1) {
                len = jStat.normal.sample(3.0, 0.2);
                eng = jStat.normal.sample(6.00, 0.05);
            } else {
                len = jStat.normal.sample(4.2, 0.3);
                eng = jStat.normal.sample(7.69, 0.05);
            }
            tort = Math.min(1.0, jStat.normal.sample(0.985, 0.015));
            angle = Math.random() * Math.PI * 2;
        } else if (type === 'beta') {
            len = jStat.gamma.sample(3.0, 3.5) + 2.0;
            tort = Math.max(0.60, Math.min(0.95, jStat.normal.sample(0.81, 0.04)));
            eng = jStat.beta.sample(2, 5) * 3.5;
            angle = Math.random() * Math.PI * 2;
        } else if (type === 'muon') {
            len = 20 + Math.random() * 10;
            tort = 1.0; // Perfectly straight
            eng = 1000;
            // Mostly vertical angle
            angle = (Math.random() * 0.4 - 0.2) + (startY <= 0 ? Math.PI/2 : -Math.PI/2);
        }

        return { x: startX, y: startY, length: len, tortuosity: tort, energy: eng, angle: angle };
    }

    /**
     * Generate new particle events based on the defined decay rate and ratio.
     * Task 3: The Radon Spawner Engine.
     */
    function spawnParticles(timestamp) {
        if (!lastTime) {
            lastTime = timestamp;
            lastLogTime = timestamp;
            return;
        }

        let deltaTime = (timestamp - lastTime) / 1000; // Time in seconds
        if (deltaTime > 1.0) deltaTime = 1.0; // Cap to prevent bursts
        lastTime = timestamp;

        // Accumulate fractional particles to maintain exactly ~20/sec
        spawnAccumulator += SPAWN_RATE * deltaTime;

        while (spawnAccumulator >= 1) {
            spawnAccumulator -= 1;

            // Gas Diffusion: Radon spawner origins are random across the chamber
            const startX = state.spawnMinX + Math.random() * (state.spawnMaxX - state.spawnMinX);
            const startY = Math.random() * state.height;

            // The 3:2 Ratio (60% Alpha chance, 40% Beta chance)
            const type = Math.random() < 0.6 ? 'alpha' : 'beta';

            // Filtering: Only spawn if the corresponding toggle is checked
            if ((type === 'alpha' && state.showAlpha) || (type === 'beta' && state.showBeta)) {
                // Task 2: Generate metadata BEFORE Particle instantiation
                const metadata = generateMetadata(type, startX, startY);
                particles.push(new Particle(startX, startY, type, metadata));
                Geiger.playClick(type);
                Haptics.pulse(type);
                
                // Synchronise Visuals with Data Generation
                logParticleMetadata(type, startX, startY, metadata);

                // Update verification counters
                totalSpawned++;
                if (type === 'alpha') {
                    alphaCount++;
                    lifetimeAlphaCount++;

                    // Alert Pulse Warning (Task 4)
                    if (lifetimeAlphaCount > 2300) {
                        if (haltAlertPulse && !haltAlertPulse.classList.contains('active')) {
                            haltAlertPulse.classList.add('active');
                        }
                    }

                    if (lifetimeAlphaCount >= 2554) {
                        state.halted = true;
                        return; // Halt spawning immediately
                    }
                } else {
                    betaCount++;
                    lifetimeBetaCount++;
                }
            }
        }

        // Rare Cosmic Ray Muon (Background radiation)
        if (Math.random() < 0.005) {
             const startX = state.spawnMinX + Math.random() * (state.spawnMaxX - state.spawnMinX);
             const startY = Math.random() < 0.5 ? 0 : state.height; 
             
             const metadata = generateMetadata('muon', startX, startY);
             particles.push(new Particle(startX, startY, 'muon', metadata));
             logParticleMetadata('muon', startX, startY, metadata);
        }

        // Log verification every 5 seconds
        if (timestamp - lastLogTime > 5000) {
            const duration = (timestamp - lastLogTime) / 1000;
            const actualRate = (totalSpawned / duration).toFixed(2);
            const alphaRatio = ((alphaCount / totalSpawned) * 100).toFixed(1);
            const betaRatio = ((betaCount / totalSpawned) * 100).toFixed(1);
            
            console.log(`Task 3 Verify: Rate ~${actualRate}/sec | Alpha: ${alphaRatio}% | Beta: ${betaRatio}% | Active: ${particles.length}`);
            
            // Reset for next interval for per-interval stats
            lastLogTime = timestamp;
            totalSpawned = 0;
            alphaCount = 0;
            betaCount = 0;
        }
    }

    /**
     * The main rendering loop.
     */
    function render(timestamp) {
        if (state.halted) {
            // Final dashboard update to capture full dataset
            state.dashboard.dirty = true;
            refreshDashboards();

            // Populate final stats
            document.getElementById('final-alpha-count').textContent = state.liveAlphaData.totalPushed;
            document.getElementById('final-beta-count').textContent = state.liveBetaData.totalPushed;
            document.getElementById('final-muon-count').textContent = state.liveMuonData.totalPushed;

            if (state.activeView === 'live') {
                document.getElementById('halt-overlay').style.display = 'block';
            } else {
                document.getElementById('halt-overlay').style.display = 'none';
            }

            document.getElementById('live-chamber-header').style.opacity = '0.3';
            document.getElementById('live-chamber-header').style.pointerEvents = 'none';
            return; // Kill the animation loop
        }

        // Step 1: Update state from UI
        updateState();

        if (state.playing) {
            // Step 2: Spawn particles
            spawnParticles(timestamp);

            // Task 5: Trail Dissipation System - Run only when playing to "freeze" visuals
            for (let i = state.trails.length - 1; i >= 0; i--) {
                const trail = state.trails[i];
                trail.alpha -= 0.008; // Control dissipation speed
                if (trail.alpha <= 0) {
                    trail.graphics.destroy();
                    state.trails.splice(i, 1);
                } else {
                    trail.graphics.alpha = trail.alpha;
                }
            }

            if (state.activeView === 'live') {
                // Live Chamber rendering

                for (let i = particles.length - 1; i >= 0; i--) {
                    const particle = particles[i];
                    particle.update();
                    // Task 5: particle.draw(pixiApp);
                    if (!particle.active) {
                        particle.destroy();
                        particles.splice(i, 1);
                    }
                }

                // Update Live HUD
                if (timestamp - lastHUDUpdateTime > 100) {
                    document.getElementById('hud-alpha-count').textContent = state.liveAlphaData.totalPushed;
                    document.getElementById('hud-beta-count').textContent = state.liveBetaData.totalPushed;
                    document.getElementById('hud-muon-count').textContent = state.liveMuonData.totalPushed;
                    lastHUDUpdateTime = timestamp;
                }
            } else {
                // Keep simulation physics ticking even if not drawing them
                for (let i = particles.length - 1; i >= 0; i--) {
                    const particle = particles[i];
                    particle.update();
                    if (!particle.active) {
                        particle.destroy();
                        particles.splice(i, 1);
                    }
                }
            }
        } else {
            // Freeze simulation but keep clock updated to avoid burst on resume
            lastTime = timestamp;
            lastLogTime = timestamp;
            lastHUDUpdateTime = timestamp;
        }

        animationId = requestAnimationFrame(render);
    }

    /**
     * Export a chart as an ultra-high-resolution JPG for A1 poster printing.
     * Overrides the live chart's pixel ratio temporarily to guarantee perfect layout fidelity.
     * @param {string} chartKey - The state key of the chart (e.g., 'scatter', 'histogram').
     * @param {string} filename - The base filename for the export.
     */
    window.exportHighResPrint = function(chartKey, filename) {
        const chart = state.charts[chartKey];
        if (!chart) return;

        // 1. Save original pixel ratio
        const originalRatio = chart.options.devicePixelRatio || window.devicePixelRatio || 1;
        
        // 2. Force chart to render at 5x resolution (approx 5K width, perfect for A1 print)
        chart.options.devicePixelRatio = 5;
        chart.update('none'); // 'none' forces an instant, synchronous render without animations

        // 3. Create a temporary canvas at the new ultra-high resolution
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = chart.canvas.width;
        tempCanvas.height = chart.canvas.height;
        const ctx = tempCanvas.getContext('2d');

        // 4. Fill with solid white (This permanently fixes the black background issue)
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

        // 5. Draw the ultra-high-res chart on top of the solid white background
        ctx.drawImage(chart.canvas, 0, 0);

        // 6. Extract the pristine image data
        const dataUrl = tempCanvas.toDataURL('image/jpeg', 1.0);

        // 7. Instantly restore the live chart back to normal screen resolution
        chart.options.devicePixelRatio = originalRatio;
        chart.update('none');

        // 8. Trigger the browser download
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${filename}_A1_Print_${new Date().getTime()}.jpg`;
        link.click();
    };



    
    window.exportDataCSV = function() {
        const alpha = state.liveAlphaData.toArray();
        const beta = state.liveBetaData.toArray();
        const muon = state.liveMuonData.toArray();
        
        let csv = "Type,Energy(MeV),Length(px),Tortuosity,Momentum(MeV/c)\n";
        
        const calcMom = (e, m) => Math.sqrt(e ** 2 + 2 * m * e);

        alpha.forEach(p => {
            const mom = calcMom(p.energy, MASS_ALPHA);
            csv += `Alpha,${p.energy.toFixed(3)},${p.length.toFixed(2)},${p.tortuosity.toFixed(4)},${mom.toFixed(3)}\n`;
        });
        
        beta.forEach(p => {
            const mom = calcMom(p.energy, MASS_BETA);
            csv += `Beta,${p.energy.toFixed(3)},${p.length.toFixed(2)},${p.tortuosity.toFixed(4)},${mom.toFixed(3)}\n`;
        });

        muon.forEach(p => {
            const mom = calcMom(p.energy, MASS_MUON);
            csv += `Muon,${p.energy.toFixed(3)},${p.length.toFixed(2)},${p.tortuosity.toFixed(4)},${mom.toFixed(3)}\n`;
        });
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `radon_research_data_${new Date().getTime()}.csv`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
    };

    /**
     * Handle touch start event for swipe gestures.
     */
    function handleTouchStart(e) {
        state.touchStartX = e.touches[0].clientX;
    }

    /**
     * Handle touch end event for swipe gestures.
     */
    function handleTouchEnd(e) {
        const touchEndX = e.changedTouches[0].clientX;
        const deltaX = touchEndX - state.touchStartX;
        handleSwipeGesture(deltaX);
    }

    /**
     * Navigate between views with looping logic.
     */
    function navigateViews(offset) {
        const views = ['live', 'morphology', 'energy', 'momentum'];
        const currentIndex = views.indexOf(state.activeView);
        
        // Use modulo for looping
        const nextIndex = (currentIndex + offset + views.length) % views.length;
        const direction = offset > 0 ? 'next' : 'prev';

        if (nextIndex !== currentIndex) {
            vibrate(10);
            switchView(views[nextIndex], direction);
        }
    }

    /**
     * Process swipe gesture and switch views.
     */
    function handleSwipeGesture(deltaX) {
        const threshold = 50; // pixels
        
        if (deltaX < -threshold) {
            // Swipe Left -> Next View
            navigateViews(1);
        } else if (deltaX > threshold) {
            // Swipe Right -> Previous View
            navigateViews(-1);
        }
    }

    /**
     * Initialise the application.
     */
    async function initialise() {
        Chart.defaults.font.family = "'Geist', sans-serif";
        await initialiseCanvas();
        
        window.addEventListener('resize', handleResize);
        window.addEventListener('touchstart', handleTouchStart, { passive: true });
        window.addEventListener('touchend', handleTouchEnd, { passive: true });
        
        // UI Toggles
        alphaToggle.addEventListener('change', updateState);
        betaToggle.addEventListener('change', updateState);
        
        // Navigation listeners
        if (btnPrev) btnPrev.addEventListener('click', () => {
            btnPrev.blur();
            navigateViews(-1);
        });
        if (btnNext) btnNext.addEventListener('click', () => {
            btnNext.blur();
            navigateViews(1);
        });
        
        const bFieldToggleSim = document.getElementById('toggleBFieldSim');
        if(bFieldToggleSim) {
             bFieldToggleSim.addEventListener('change', (e) => {
                 state.magneticField = e.target.checked;
             });
        }

        const bFieldToggleScatter = document.getElementById('toggleBFieldScatter');
        if(bFieldToggleScatter) {
             bFieldToggleScatter.addEventListener('change', (e) => {
                 window.setScatterMag(e.target.checked);
             });
        }

        const startEngineBtn = document.getElementById('start-engine-btn');
        const toggleEngine = document.getElementById('toggleEngine');
        const startOverlay = document.getElementById('start-overlay');

        if (startEngineBtn) {
            startEngineBtn.addEventListener('click', () => {
                state.playing = true;
                if (startOverlay) startOverlay.style.display = 'none';
                if (toggleEngine) toggleEngine.checked = true;
            });
        }

        if (toggleEngine) {
            toggleEngine.addEventListener('change', (e) => {
                state.playing = e.target.checked;
            });
        }
        
        // Throttled dashboard updates
        setInterval(() => {
            if (state.activeView === 'morphology' || state.activeView === 'energy' || state.activeView === 'momentum') {
                if (state.dashboard.dirty) refreshDashboards();
            }
        }, 100);

        // Start the render loop
        animationId = requestAnimationFrame(render);
        
        // Initial Nav Theme Setup
        const navArrows = document.querySelectorAll('.side-nav-arrow');
        navArrows.forEach(btn => btn.classList.add('theme-dark'));

        console.log('Radon Cloud Chamber: Engine initialised.');
    }

    // Launch the application
    initialise().catch(err => {
        console.error('Initialisation failed:', err);
    });

})();