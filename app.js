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
    const FADE_COLOUR = 'rgba(0, 0, 0, 0.05)';
    const MASS_ALPHA = 3727;
    const MASS_BETA = 0.511;
    const MASS_MUON = 105.6;

    // --- DOM Elements ---
    const canvas = document.getElementById('chamberCanvas');
    const ctx = canvas.getContext('2d');
    const alphaToggle = document.getElementById('showAlpha');
    const betaToggle = document.getElementById('showBeta');
    
    // View switching elements
    const liveView = document.getElementById('live-chamber');
    const morphologyView = document.getElementById('morphology-view');
    const energyView = document.getElementById('energy-view');
    const momentumView = document.getElementById('momentum-view');
    const btnLive = document.getElementById('btn-live');
    const btnMorphology = document.getElementById('btn-morphology');
    const btnEnergy = document.getElementById('btn-energy');
    const btnMomentum = document.getElementById('btn-momentum');

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
    }

    const state = {
        magneticField: false,
        showAlpha: alphaToggle.checked,
        showBeta: betaToggle.checked,
        width: 0,
        height: 0,
        activeView: 'live', // 'live', 'morphology', or 'energy'
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
        liveAlphaData: new RingBuffer(2500),
        liveBetaData: new RingBuffer(2500),
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
    let lastLogTime = 0;

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
     * Represents a radiation particle track.
     * Task 4: Particle Rendering Algorithms.
     */
    class Particle {
        constructor(x, y, type, metadata) {
            this.x = x;
            this.y = y;
            this.type = type;
            this.active = true;
            this.distanceTravelled = 0;

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
            if (!this.active) return;

            // Save previous position for line drawing
            this.prevX = this.x;
            this.prevY = this.y;

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
            this.x += Math.cos(this.angle) * this.speed;
            this.y += Math.sin(this.angle) * this.speed;

            this.distanceTravelled += this.speed;

            if (this.distanceTravelled >= this.lifespan) {
                this.active = false;
            }
        }

        /**
         * Draw the particle track segment using a Core and Halo technique.
         */
        draw(ctx) {
            if (this.distanceTravelled === 0) return;

            // 1. Prepare the path
            ctx.beginPath();
            ctx.moveTo(this.prevX, this.prevY);
            ctx.lineTo(this.x, this.y);
            ctx.lineCap = 'round';
            
            // 2. Render based on particle type
            if (this.type === 'alpha') {
                // HALO PASS: Wide, highly transparent outer mist
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; 
                ctx.lineWidth = this.lineWidth * 2.5; 
                ctx.stroke();

                // CORE PASS: Narrow, solid white high-energy centre
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                ctx.lineWidth = this.lineWidth * 0.6; 
                ctx.stroke();
                
            } else if (this.type === 'beta') {
                // Beta particles are faint and wispy
                ctx.strokeStyle = 'rgba(200, 255, 220, 0.4)'; // Slight icy-green tint for contrast
                ctx.lineWidth = 1.5;
                ctx.stroke();
                
            } else {
                // Cosmic Muons remain sharp and faint
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.lineWidth = 1.0;
                ctx.stroke();
            }
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

        state.charts.scatter.data.datasets[0].data = state.liveAlphaData.toArray().map(p => ({
            x: p.length, y: getObserved(p, 'alpha')
        }));
        state.charts.scatter.data.datasets[1].data = state.liveBetaData.toArray().map(p => ({
            x: p.length, y: getObserved(p, 'beta')
        }));
        state.charts.scatter.data.datasets[2].data = state.liveMuonData.toArray().map(p => ({
            x: p.length, y: getObserved(p, 'muon')
        }));
        
        // Update Y axis min
        state.charts.scatter.options.scales.y.min = state.dashboard.scatterMag ? 0.0 : 0.5;
        
        state.charts.scatter.update();
    }

    /**
     * Render the dashboard components incrementally per-frame.
     */
    function refreshDashboards() {
        if (!state.dashboard.dirty) return;

        calculateStats();

        // Update other charts if they exist
        if (state.charts.scatter) {
            state.charts.scatter.update('none');
        }

        if (state.charts.histogram) {
            const alphaEnergyBins = new Array(10).fill(0);
            const betaEnergyBins = new Array(10).fill(0);

            state.liveAlphaData.toArray().forEach(p => {
                const newBin = Math.floor(p.energy);
                if (!isNaN(newBin) && newBin >= 0 && newBin <= 9) {
                    alphaEnergyBins[newBin]++;
                }
            });

            state.liveBetaData.toArray().forEach(p => {
                const newBin = Math.floor(p.energy);
                if (!isNaN(newBin) && newBin >= 0 && newBin <= 9) {
                    betaEnergyBins[newBin]++;
                }
            });

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

            state.liveAlphaData.toArray().forEach(p => {
                const mom = Math.sqrt(p.energy ** 2 + 2 * alphaMass * p.energy); // Relativistic
                addToLogBin(mom, alphaBins);
            });

            state.liveBetaData.toArray().forEach(p => {
                const mom = Math.sqrt(p.energy ** 2 + 2 * betaMass * p.energy); // Relativistic
                addToLogBin(mom, betaBins);
            });

            state.liveMuonData.toArray().forEach(p => {
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
    function switchView(view) {
        if (state.activeView === view) return;
        state.activeView = view;

        // Hide all views first
        liveView.style.display = 'none';
        morphologyView.style.display = 'none';
        energyView.style.display = 'none';
        momentumView.style.display = 'none';

        // Deactivate all buttons
        btnLive.classList.remove('active');
        btnMorphology.classList.remove('active');
        btnEnergy.classList.remove('active');
        btnMomentum.classList.remove('active');

        if (view === 'live') {
            liveView.style.display = 'flex';
            btnLive.classList.add('active');
            
            // Wait for browser to apply 'display: flex' and compute layout
            // before re-initialising the canvas dimensions.
            requestAnimationFrame(() => {
                initialiseCanvas();
            });
        } else if (view === 'morphology') {
            morphologyView.style.display = 'block';
            btnMorphology.classList.add('active');
            
            if (!state.charts.scatter) {
                renderScatter();
            } else {
                state.charts.scatter.resize();
            }
            state.dashboard.dirty = true;
        } else if (view === 'energy') {
            energyView.style.display = 'block';
            btnEnergy.classList.add('active');
            
            if (!state.charts.histogram) {
                renderHistogram();
            } else {
                state.charts.histogram.resize();
            }
            state.dashboard.dirty = true;
        } else if (view === 'momentum') {
            momentumView.style.display = 'block';
            btnMomentum.classList.add('active');
            
            if (!state.charts.momentum) {
                renderMomentumChart();
            } else {
                state.charts.momentum.resize();
            }
            state.dashboard.dirty = true;
        }
    }

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
                ctx.fillStyle = baseColor.replace('1.0)', '0.15)'); 
                ctx.fill();
                
                // Thicker, fully opaque dashed border
                ctx.lineWidth = 3; 
                ctx.strokeStyle = baseColor; // Use the full 1.0 opacity base colour
                ctx.setLineDash([8, 6]);     // Longer dashes, wider gaps
                ctx.stroke();
                
                ctx.restore();
            };

            // Draw for Dataset 0 (Alpha) and Dataset 1 (Beta)
            drawEllipseForDataset(0, 'rgba(136, 132, 216, 1.0)');
            drawEllipseForDataset(1, 'rgba(130, 202, 157, 1.0)');
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
                        backgroundColor: 'rgba(0, 150, 200, 0.6)',
                        pointRadius: 1.5
                    },
                    {
                        label: 'Beta Particles',
                        data: [],
                        backgroundColor: 'rgba(100, 100, 100, 0.3)',
                        pointRadius: 1.5
                    },
                    {
                        label: 'Cosmic Muons',
                        data: [],
                        backgroundColor: 'rgba(150, 150, 150, 0.2)',
                        pointRadius: 1.5
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 150,
                    easing: 'easeOutQuart'
                },

                plugins: {
                    legend: { 
                        position: 'top',
                        labels: { 
                            font: { size: 16, weight: '600' },
                            color: '#222222'
                        }
                    }
                },
                scales: {
                    x: {
                        title: { 
                            display: true, 
                            text: 'Track Length (pixels)',
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { 
                            font: { size: 14 },
                            color: '#444444'
                        },
                        min: 0,
                        max: 30,
                        grid: { color: 'rgba(0, 0, 0, 0.05)', drawTicks: false },
                        border: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Tortuosity Index',
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { 
                            font: { size: 14 },
                            color: '#444444'
                        },
                        min: 0.5,
                        max: 1.05,
                        grid: { color: 'rgba(0, 0, 0, 0.05)', drawTicks: false },
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

        const chartConfig = {
            type: 'barWithErrorBars',
            data: {
                labels: bins.map(b => `${b}-${b+1}`),
                datasets: [
                    {
                        label: 'Alpha (MeV)',
                        grouped: false,
                        data: mapBins(new Array(10).fill(0)),
                        backgroundColor: 'rgba(0, 150, 200, 0.6)',
                        errorBarLineWidth: 2,
                        errorBarColor: 'rgba(0, 150, 200, 0.8)',
                        barPercentage: 1.0,
                        categoryPercentage: 1.0
                    },
                    {
                        label: 'Beta (MeV)',
                        grouped: false,
                        data: mapBins(new Array(10).fill(0)),
                        backgroundColor: 'rgba(100, 100, 100, 0.3)',
                        errorBarLineWidth: 2,
                        errorBarColor: 'rgba(100, 100, 100, 0.5)',
                        barPercentage: 1.0,
                        categoryPercentage: 1.0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 150,
                    easing: 'easeOutQuart'
                },
                scales: {
                    x: {
                        title: { 
                            display: true, 
                            text: 'Energy Range (MeV)',
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { 
                            font: { size: 14 },
                            color: '#444444'
                        },
                        grid: { color: 'rgba(0, 0, 0, 0.05)', drawTicks: false },
                        border: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Event Frequency',
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { 
                            font: { size: 14 },
                            color: '#444444'
                        },
                        grid: { color: 'rgba(0, 0, 0, 0.05)', drawTicks: false },
                        border: { display: false }
                    }
                },
                plugins: {
                    legend: {
                        labels: { 
                            font: { size: 16, weight: '600' },
                            color: '#222222'
                        }
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

        const chartConfig = {
            type: 'lineWithErrorBars', // --- Changed from 'line' ---
            data: {
                datasets: [
                    {
                        label: 'Alpha (MeV/c)',
                        data: [],
                        borderColor: 'rgba(136, 132, 216, 1.0)',
                        backgroundColor: 'rgba(0, 150, 200, 0.6)',
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
                        errorBarColor: 'rgba(136, 132, 216, 0.4)',
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
                        borderColor: 'rgba(130, 202, 157, 1.0)',
                        backgroundColor: 'rgba(100, 100, 100, 0.3)',
                        borderWidth: 0,
                        barPercentage: 1.0,
                        categoryPercentage: 1.0,
                        
                        pointStyle: false,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        pointBorderWidth: 0,
                        pointBorderColor: 'transparent',
                        pointBackgroundColor: 'transparent',
                        
                        errorBarColor: 'rgba(130, 202, 157, 0.4)',
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
                        borderColor: 'rgba(200, 200, 200, 1.0)',
                        backgroundColor: 'rgba(150, 150, 150, 0.2)',
                        borderWidth: 0,
                        barPercentage: 1.0,
                        categoryPercentage: 1.0,
                        
                        pointStyle: false,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        pointBorderWidth: 0,
                        pointBorderColor: 'transparent',
                        pointBackgroundColor: 'transparent',
                        
                        errorBarColor: 'rgba(200, 200, 200, 0.4)',
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
                    duration: 150,
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
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { color: '#444444' },
                        grid: { display: false }
                    },
                    y: {
                        title: { 
                            display: true, 
                            text: 'Event Frequency',
                            font: { size: 18, weight: 'bold' },
                            color: '#333333'
                        },
                        ticks: { color: '#444444' },
                        grid: { color: 'rgba(0, 0, 0, 0.1)' },
                        border: { display: false }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#222222' } }
                }
            }
        };

        state.charts.momentum = new Chart(ctx, chartConfig);
    }

    /**
     * Initialise the canvas dimensions to match the viewport.
     */
    function initialiseCanvas() {
        const viewport = document.getElementById('simulation-viewport');
        const dpr = window.devicePixelRatio || 1;

        // Prevent collapse to 0 when viewport is hidden
        const viewportWidth = (viewport && viewport.clientWidth > 0) ? viewport.clientWidth : (state.width || window.innerWidth || 800);
        const viewportHeight = (viewport && viewport.clientHeight > 0) ? viewport.clientHeight : (state.height || window.innerHeight || 500);

        state.width = viewportWidth;
        state.height = viewportHeight;

        // Scale buffer for Retina
        canvas.width = viewportWidth * dpr;
        canvas.height = viewportHeight * dpr;

        // Lock visible size
        canvas.style.width = viewportWidth + 'px';
        canvas.style.height = viewportHeight + 'px';

        ctx.scale(dpr, dpr);

        console.log(`initialiseCanvas: Retina enabled (DPI: ${dpr}). Resolution: ${canvas.width}x${canvas.height}`);

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, state.width, state.height);
    }
    /**
     * Event listener for window resizing.
     */
    function handleResize() {
        initialiseCanvas();
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
     * Apply the vapour dissipation effect by drawing a semi-transparent 
     * black rectangle over the entire canvas.
     */
    function applyDissipation() {
        ctx.fillStyle = FADE_COLOUR;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    /**
     * Records particle metadata for analytics using jStat distributions.
     * Incremental updates for O(1) performance.
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
                    state.charts.scatter.data.datasets[2].data.push({ x: newItem.length, y: newItem.tortuosity });
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

        if (alphaCount >= 2500) {
            return;
        }

        if (!lastTime) {
            lastTime = timestamp;
            return;
        }

        const deltaTime = (timestamp - lastTime) / 1000; // Time in seconds
        lastTime = timestamp;

        // Accumulate fractional particles to maintain exactly ~20/sec
        spawnAccumulator += SPAWN_RATE * deltaTime;

        while (spawnAccumulator >= 1) {
            spawnAccumulator -= 1;

            // Gas Diffusion: Radon spawner origins are random across the chamber
            const startX = Math.random() * state.width;
            const startY = Math.random() * state.height;

            // The 3:2 Ratio (60% Alpha chance, 40% Beta chance)
            const type = Math.random() < 0.6 ? 'alpha' : 'beta';

            // Filtering: Only spawn if the corresponding toggle is checked
            if ((type === 'alpha' && state.showAlpha) || (type === 'beta' && state.showBeta)) {
                // Task 2: Generate metadata BEFORE Particle instantiation
                const metadata = generateMetadata(type, startX, startY);
                particles.push(new Particle(startX, startY, type, metadata));
                
                // Synchronise Visuals with Data Generation
                logParticleMetadata(type, startX, startY, metadata);

                // Update verification counters
                totalSpawned++;
                if (type === 'alpha') alphaCount++;
                else betaCount++;
            }
        }

        // Rare Cosmic Ray Muon (Background radiation)
        if (Math.random() < 0.005) {
             const startX = Math.random() * state.width;
             const startY = Math.random() < 0.5 ? 0 : state.height; 
             
             const metadata = generateMetadata('muon', startX, startY);
             particles.push(new Particle(startX, startY, 'muon', metadata));
             logParticleMetadata('muon', startX, startY, metadata);
        }

        // Log verification every 5 seconds
        if (timestamp - lastLogTime > 5000) {
            const actualRate = (totalSpawned / ((timestamp - (lastLogTime || timestamp)) / 1000)).toFixed(2);
            const alphaRatio = ((alphaCount / totalSpawned) * 100).toFixed(1);
            const betaRatio = ((betaCount / totalSpawned) * 100).toFixed(1);
            
            console.log(`Task 3 Verify: Rate ~${actualRate}/sec | Alpha: ${alphaRatio}% | Beta: ${betaRatio}% | Active: ${particles.length}`);
            
            // Reset for next interval if we want per-interval stats, 
            // or keep cumulative. Let's keep cumulative for better averages.
            lastLogTime = timestamp;
        }
    }

    /**
     * The main rendering loop.
     */
    function render(timestamp) {
        // Step 1: Update state from UI
        updateState();

        // Step 2: Spawn particles unconditionally
        spawnParticles(timestamp);

        if (state.activeView === 'live') {
            // Live Chamber rendering
            applyDissipation();
            for (let i = particles.length - 1; i >= 0; i--) {
                const particle = particles[i];
                particle.update();
                particle.draw(ctx);
                if (!particle.active) particles.splice(i, 1);
            }
        } else {
            // Keep simulation physics ticking even if not drawing them
            for (let i = particles.length - 1; i >= 0; i--) {
                const particle = particles[i];
                particle.update();
                if (!particle.active) particles.splice(i, 1);
            }
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
     * Initialise the application.
     */
    function initialise() {
        Chart.defaults.font.family = "'Geist', sans-serif";
        initialiseCanvas();
        
        window.addEventListener('resize', handleResize);
        
        // Navigation listeners
        btnLive.addEventListener('click', () => switchView('live'));
        btnMorphology.addEventListener('click', () => switchView('morphology'));
        btnEnergy.addEventListener('click', () => switchView('energy'));
        btnMomentum.addEventListener('click', () => switchView('momentum'));
        
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
        
        // Throttled dashboard updates
        setInterval(() => {
            if (state.activeView === 'morphology' || state.activeView === 'energy' || state.activeView === 'momentum') {
                if (state.dashboard.dirty) refreshDashboards();
            }
        }, 100);

        // Start the render loop
        animationId = requestAnimationFrame(render);
        
        console.log('Radon Cloud Chamber: Engine initialised.');
    }

    // Launch the application
    initialise();

})();