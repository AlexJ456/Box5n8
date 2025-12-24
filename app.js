document.addEventListener('DOMContentLoaded', () => {
    const app = document.getElementById('app-content');
    const canvas = document.getElementById('box-canvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!app || !canvas || !ctx) {
        return;
    }

    const layoutHost = canvas.parentElement || document.querySelector('.container');
    const initialWidth = layoutHost ? layoutHost.clientWidth : canvas.clientWidth;
    const initialHeight = layoutHost ? layoutHost.clientHeight : canvas.clientHeight;

    const state = {
        isPlaying: false,
        count: 0,
        countdown: 4,
        totalTime: 0,
        soundEnabled: false,
        timeLimit: '',
        sessionComplete: false,
        timeLimitReached: false,
        phaseTime: 4,
        pulseStartTime: null,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        viewportWidth: initialWidth,
        viewportHeight: initialHeight,
        prefersReducedMotion: false,
        hasStarted: false
    };

    let wakeLock = null;

    // Audio setup
    let audioContext = null;
    let masterGain = null;
    let ambienceBus = null; // subtle filtered delay bus

    function ensureAudio() {
        if (!audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            audioContext = new Ctx();
            masterGain = audioContext.createGain();
            masterGain.gain.setValueAtTime(state.soundEnabled ? 0.9 : 0.0, audioContext.currentTime);

            // Create a very subtle ambience bus (filtered short delay) for a soft tail
            const delay = audioContext.createDelay(0.5);
            delay.delayTime.value = 0.12;

            const feedback = audioContext.createGain();
            feedback.gain.value = 0.18;

            const toneFilter = audioContext.createBiquadFilter();
            toneFilter.type = 'lowpass';
            toneFilter.frequency.value = 3200;

            const ambienceFilter = audioContext.createBiquadFilter();
            ambienceFilter.type = 'lowpass';
            ambienceFilter.frequency.value = 1800;

            delay.connect(feedback).connect(ambienceFilter).connect(delay);

            ambienceBus = audioContext.createGain();
            ambienceBus.gain.value = 0.18;

            // Route: tones -> toneFilter -> master + (split to) delay -> master
            toneFilter.connect(masterGain);
            toneFilter.connect(delay);
            delay.connect(ambienceBus);

            ambienceBus.connect(masterGain);
            masterGain.connect(audioContext.destination);

            // Keep references to shared nodes
            ensureAudio.toneFilter = toneFilter;
        }
    }

    function updateAudioRouting() {
        if (!audioContext) return;
        const t = audioContext.currentTime;
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(masterGain.gain.value, t);
        masterGain.gain.linearRampToValueAtTime(state.soundEnabled ? 0.9 : 0.0, t + 0.05);
    }

    // Pleasant chime per phase (soft ADSR, dual-osc detune, gentle filter sweep)
    // Phase map: 0=Inhale, 1=Hold, 2=Exhale, 3=Wait
    const phaseFrequencies = [440.00, 523.25, 329.63, 293.66]; // A4, C5, E4, D4
    const phasePan = [-0.12, 0.0, 0.12, 0.0];

    function playCue(phaseIndex = 0) {
        if (!state.soundEnabled) return;
        ensureAudio();
        if (audioContext.state === 'suspended') {
            // Will resume on user gesture; guard anyway
            audioContext.resume().catch(() => {});
        }

        const t0 = audioContext.currentTime + 0.005;
        const dur = 0.38;

        const osc1 = audioContext.createOscillator();
        const osc2 = audioContext.createOscillator();
        const pan = audioContext.createStereoPanner ? audioContext.createStereoPanner() : null;
        const g = audioContext.createGain();
        const f = audioContext.createBiquadFilter();

        const baseFreq = phaseFrequencies[phaseIndex % 4];
        osc1.type = 'sine';
        osc2.type = 'triangle';
        osc1.frequency.setValueAtTime(baseFreq, t0);
        osc2.frequency.setValueAtTime(baseFreq * Math.pow(2, 3 / 1200), t0); // +3 cents detune

        // Envelope (soft attack, quick decay to a warm sustain, short release)
        const attack = 0.01;
        const decay = 0.15;
        const sustain = 0.35;
        const release = 0.14;

        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.9, t0 + attack);
        g.gain.linearRampToValueAtTime(sustain, t0 + attack + decay);
        g.gain.setValueAtTime(sustain, t0 + dur);
        g.gain.linearRampToValueAtTime(0.0001, t0 + dur + release);

        // Gentle filter sweep to soften the transient
        f.type = 'lowpass';
        f.frequency.setValueAtTime(3800, t0);
        f.frequency.exponentialRampToValueAtTime(1900, t0 + dur);

        // Optional subtle stereo placement by phase
        if (pan) {
            pan.pan.setValueAtTime(phasePan[phaseIndex % 4] || 0, t0);
        }

        // Connect graph: osc -> gain -> filter -> shared toneFilter -> master/delay (configured in ensureAudio)
        const toneFilter = ensureAudio.toneFilter;
        osc1.connect(g);
        osc2.connect(g);
        g.connect(f);
        if (pan) {
            f.connect(pan);
            pan.connect(toneFilter);
        } else {
            f.connect(toneFilter);
        }

        osc1.start(t0);
        osc2.start(t0);
        // Stop after envelope finishes
        const stopAt = t0 + dur + release + 0.02;
        osc1.stop(stopAt);
        osc2.stop(stopAt);
    }

    const icons = {
        play: `<svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
        pause: `<svg class="icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
        volume2: `<svg class="icon" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
        volumeX: `<svg class="icon" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`,
        rotateCcw: `<svg class="icon" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
        clock: `<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`
    };

    function getInstruction(count) {
        switch (count) {
            case 0: return 'Inhale';
            case 1: return 'Hold';
            case 2: return 'Exhale';
            case 3: return 'Wait';
            default: return '';
        }
    }

    const phaseColors = ['#f97316', '#fbbf24', '#38bdf8', '#22c55e'];

    function hexToRgba(hex, alpha) {
        const normalized = hex.replace('#', '');
        const bigint = parseInt(normalized, 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    let cachedGradient = null;
    let cachedGradientKey = '';

    function invalidateGradient() {
        cachedGradient = null;
        cachedGradientKey = '';
    }

    function resizeCanvas() {
        const currentSizingElement = layoutHost || document.body;
        if (!currentSizingElement) {
            return;
        }

        const rect = currentSizingElement.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

        state.viewportWidth = width;
        state.viewportHeight = height;
        state.devicePixelRatio = pixelRatio;

        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.floor(width * pixelRatio);
        canvas.height = Math.floor(height * pixelRatio);

        if (ctx) {
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }

        invalidateGradient();

        if (!state.isPlaying) {
            drawScene({ progress: state.sessionComplete ? 1 : 0, showTrail: false, phase: state.count });
        }
    }

    window.addEventListener('resize', resizeCanvas, { passive: true });

    function updateMotionPreference(event) {
        state.prefersReducedMotion = event.matches;
        if (!state.isPlaying) {
            drawScene({ progress: state.sessionComplete ? 1 : 0, showTrail: false, phase: state.count });
        }
    }

    const motionQuery = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    if (motionQuery) {
        state.prefersReducedMotion = motionQuery.matches;
        if (typeof motionQuery.addEventListener === 'function') {
            motionQuery.addEventListener('change', updateMotionPreference);
        } else if (typeof motionQuery.addListener === 'function') {
            motionQuery.addListener(updateMotionPreference);
        }
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    let interval;
    let animationFrameId;
    let lastStateUpdate;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.error('Failed to acquire wake lock:', err);
            }
        }
    }

    function releaseWakeLock() {
        if (wakeLock !== null) {
            wakeLock.release()
                .then(() => { wakeLock = null; })
                .catch(err => { console.error('Failed to release wake lock:', err); });
        }
    }

    function togglePlay() {
        state.isPlaying = !state.isPlaying;
        if (state.isPlaying) {
            ensureAudio();
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume().catch(() => {});
            }
            state.hasStarted = true;
            state.totalTime = 0;
            state.countdown = state.phaseTime;
            state.count = 0;
            state.sessionComplete = false;
            state.timeLimitReached = false;
            state.pulseStartTime = performance.now();
            playCue(0);
            startInterval();
            animate();
            requestWakeLock();
        } else {
            clearInterval(interval);
            cancelAnimationFrame(animationFrameId);
            state.totalTime = 0;
            state.countdown = state.phaseTime;
            state.count = 0;
            state.sessionComplete = false;
            state.timeLimitReached = false;
            state.hasStarted = false;
            invalidateGradient();
            drawScene({ progress: 0, showTrail: false, phase: state.count });
            state.pulseStartTime = null;
            releaseWakeLock();
        }
        render();
    }

    function resetToStart() {
        state.isPlaying = false;
        state.totalTime = 0;
        state.countdown = state.phaseTime;
        state.count = 0;
        state.sessionComplete = false;
        state.timeLimit = '';
        state.timeLimitReached = false;
        state.pulseStartTime = null;
        state.hasStarted = false;
        clearInterval(interval);
        cancelAnimationFrame(animationFrameId);
        invalidateGradient();
        drawScene({ progress: 0, showTrail: false, phase: state.count });
        releaseWakeLock();
        render();
    }

    function toggleSound() {
        state.soundEnabled = !state.soundEnabled;
        ensureAudio();
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }
        updateAudioRouting();
        render();
    }

    function handleTimeLimitChange(e) {
        state.timeLimit = e.target.value.replace(/[^0-9]/g, '');
    }

    function startWithPreset(minutes) {
        state.timeLimit = minutes.toString();
        state.isPlaying = true;
        state.totalTime = 0;
        state.countdown = state.phaseTime;
        state.count = 0;
        state.sessionComplete = false;
        state.timeLimitReached = false;
        state.pulseStartTime = performance.now();
        state.hasStarted = true;
        ensureAudio();
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }
        playCue(0);
        startInterval();
        animate();
        requestWakeLock();
        render();
    }

    function startInterval() {
        clearInterval(interval);
        lastStateUpdate = performance.now();
        interval = setInterval(() => {
            state.totalTime += 1;
            if (state.timeLimit && !state.timeLimitReached) {
                const timeLimitSeconds = parseInt(state.timeLimit) * 60;
                if (state.totalTime >= timeLimitSeconds) {
                    state.timeLimitReached = true;
                }
            }
            if (state.countdown === 1) {
                state.count = (state.count + 1) % 4;
                state.pulseStartTime = performance.now();
                state.countdown = state.phaseTime;
                playCue(state.count);
                if (state.count === 3 && state.timeLimitReached) {
                    state.sessionComplete = true;
                    state.isPlaying = false;
                    state.hasStarted = false;
                    clearInterval(interval);
                    cancelAnimationFrame(animationFrameId);
                    releaseWakeLock();
                }
            } else {
                state.countdown -= 1;
            }
            lastStateUpdate = performance.now();
            render();
        }, 1000);
    }

    function drawScene({ progress = 0, phase = state.count, showTrail = state.isPlaying, timestamp = performance.now() } = {}) {
        if (!ctx) return;

        const width = state.viewportWidth || canvas.clientWidth || canvas.width;
        const height = state.viewportHeight || canvas.clientHeight || canvas.height;
        if (!width || !height) return;

        const scale = state.devicePixelRatio || 1;
        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        ctx.clearRect(0, 0, width, height);

        if (!state.hasStarted && !state.sessionComplete) {
            invalidateGradient();
            ctx.restore();
            return;
        }

        const clampedProgress = Math.max(0, Math.min(1, progress));
        const easedProgress = 0.5 - (Math.cos(Math.PI * clampedProgress) / 2);

        // Reserve some space vertically so UI never overlaps artwork on very small screens
        const baseSize = Math.min(width, height) * 0.62;
        const topMargin = 20;
        const sizeWithoutBreath = Math.min(baseSize, height - topMargin * 2);
        const verticalOffset = Math.min(height * 0.18, 120);
        const preferredTop = height / 2 + verticalOffset - sizeWithoutBreath / 2;
        const top = Math.max(topMargin, Math.min(preferredTop, height - sizeWithoutBreath - topMargin));
        const left = (width - sizeWithoutBreath) / 2;

        const now = timestamp;
        const allowMotion = !state.prefersReducedMotion;
        let breathInfluence = 0;
        if (phase === 0) {
            breathInfluence = easedProgress;
        } else if (phase === 2) {
            breathInfluence = 1 - easedProgress;
        } else if (allowMotion) {
            breathInfluence = 0.3 + 0.2 * (0.5 + 0.5 * Math.sin(now / 350));
        } else {
            breathInfluence = 0.3;
        }

        let pulseBoost = 0;
        if (allowMotion && state.pulseStartTime !== null) {
            const pulseElapsed = (now - state.pulseStartTime) / 1000;
            if (pulseElapsed < 0.6) {
                pulseBoost = Math.sin((pulseElapsed / 0.6) * Math.PI);
            }
        }

        const size = sizeWithoutBreath * (1 + 0.08 * breathInfluence + 0.03 * pulseBoost);
        const adjustedLeft = left + (sizeWithoutBreath - size) / 2;
        const adjustedTop = top + (sizeWithoutBreath - size) / 2;

        const points = [
            { x: adjustedLeft, y: adjustedTop + size },
            { x: adjustedLeft, y: adjustedTop },
            { x: adjustedLeft + size, y: adjustedTop },
            { x: adjustedLeft + size, y: adjustedTop + size }
        ];
        const startPoint = points[phase];
        const endPoint = points[(phase + 1) % 4];
        const currentX = startPoint.x + easedProgress * (endPoint.x - startPoint.x);
        const currentY = startPoint.y + easedProgress * (endPoint.y - startPoint.y);

        const accentColor = phaseColors[phase] || '#f97316';
        const shouldShowTrail = allowMotion && showTrail;

        const gradientKey = `${Math.round(size * 100)}-${accentColor}-${Math.round(adjustedLeft)}-${Math.round(adjustedTop)}`;
        if (!cachedGradient || cachedGradientKey !== gradientKey) {
            cachedGradient = ctx.createRadialGradient(
                adjustedLeft + size / 2,
                adjustedTop + size / 2,
                size * 0.2,
                adjustedLeft + size / 2,
                adjustedTop + size / 2,
                size
            );
            cachedGradient.addColorStop(0, hexToRgba(accentColor, 0.18));
            cachedGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            cachedGradientKey = gradientKey;
        }
        ctx.fillStyle = cachedGradient;
        ctx.fillRect(0, 0, width, height);

        // Subtle guide square
        ctx.strokeStyle = hexToRgba('#fcd34d', 0.22);
        ctx.lineWidth = Math.max(2, size * 0.015);
        ctx.lineJoin = 'round';
        ctx.strokeRect(adjustedLeft, adjustedTop, size, size);

        // Trail/path
        ctx.lineWidth = Math.max(4, size * 0.03);
        ctx.strokeStyle = hexToRgba(accentColor, shouldShowTrail ? 0.82 : 0.45);
        ctx.shadowColor = hexToRgba(accentColor, 0.55);
        ctx.shadowBlur = shouldShowTrail ? 16 : 9;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i <= phase; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        if (shouldShowTrail) {
            ctx.lineTo(currentX, currentY);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Moving node
        const baseRadius = Math.max(8, size * 0.04);
        let radius = baseRadius * (1 + 0.35 * breathInfluence + 0.25 * pulseBoost);
        if (allowMotion && (phase === 1 || phase === 3)) {
            radius += baseRadius * 0.12 * (0.5 + 0.5 * Math.sin(now / 200));
        }

        ctx.beginPath();
        ctx.arc(currentX, currentY, radius * 1.8, 0, 2 * Math.PI);
        ctx.fillStyle = hexToRgba(accentColor, 0.25);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(currentX, currentY, radius, 0, 2 * Math.PI);
        ctx.fillStyle = accentColor;
        ctx.fill();

        ctx.restore();
    }

    function updateCanvasVisibility() {
        const shouldShow = state.isPlaying || state.sessionComplete;
        canvas.classList.toggle('is-visible', shouldShow);
    }

    function animate() {
        if (!state.isPlaying) return;
        const now = performance.now();
        const elapsed = (now - lastStateUpdate) / 1000;
        const effectiveCountdown = state.countdown - elapsed;
        let progress = (state.phaseTime - effectiveCountdown) / state.phaseTime;
        progress = Math.max(0, Math.min(1, progress));

        drawScene({ progress, timestamp: now });

        animationFrameId = requestAnimationFrame(animate);
    }

    function render() {
        let html = `
            <h1 class="brand-title">Box Breathing</h1>
        `;
        if (state.isPlaying) {
            html += `
                <div class="timer" role="status" aria-live="polite">Total: ${formatTime(state.totalTime)}</div>
                <div class="instruction" role="status" aria-live="polite">${getInstruction(state.count)}</div>
                <div class="countdown" role="status" aria-live="polite">${state.countdown}</div>
            `;
            const phases = ['Inhale', 'Hold', 'Exhale', 'Wait'];
            html += `<div class="phase-tracker">`;
            phases.forEach((label, index) => {
                const phaseColor = phaseColors[index] || '#fde68a';
                const softPhaseColor = hexToRgba(phaseColor, 0.25);
                html += `
                    <div class="phase-item ${index === state.count ? 'active' : ''}" style="--phase-color: ${phaseColor}; --phase-soft: ${softPhaseColor};">
                        <span class="phase-dot"></span>
                        <span class="phase-label">${label}</span>
                    </div>
                `;
            });
            html += `</div>`;
        }
        if (state.timeLimitReached && !state.sessionComplete) {
            const limitMessage = state.isPlaying ? 'Finishing current cycle…' : 'Time limit reached';
            html += `<div class="limit-warning">${limitMessage}</div>`;
        }
        if (!state.isPlaying && !state.sessionComplete) {
            html += `
                <div class="settings card">
                    <div class="form-group">
                        <label class="switch">
                            <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''} aria-label="Toggle sound">
                            <span class="slider"></span>
                        </label>
                        <label for="sound-toggle" class="switch-label">
                            ${state.soundEnabled ? icons.volume2 : icons.volumeX}
                            <span>${state.soundEnabled ? 'Sound On' : 'Sound Off'}</span>
                        </label>
                    </div>
                    <div class="form-group input-row">
                        <div class="input-wrap">
                            <input
                                type="number"
                                inputmode="numeric"
                                placeholder="Minutes"
                                value="${state.timeLimit}"
                                id="time-limit"
                                step="1"
                                min="0"
                                aria-label="Time limit in minutes (optional)"
                            >
                            <label for="time-limit" class="floating">Time limit (optional)</label>
                        </div>
                    </div>
                </div>
                <div class="prompt">Press start to begin</div>
            `;
        }
        if (state.sessionComplete) {
            html += `<div class="complete">Complete!</div>`;
        }
        if (!state.sessionComplete) {
            html += `
                <button id="toggle-play" class="primary">
                    ${state.isPlaying ? icons.pause : icons.play}
                    ${state.isPlaying ? 'Pause' : 'Start'}
                </button>
            `;
        }
        if (!state.isPlaying && !state.sessionComplete) {
            html += `
                <div class="slider-container card">
                    <label for="phase-time-slider">Phase Time (seconds): <span id="phase-time-value">${state.phaseTime}</span></label>
                    <input type="range" min="3" max="6" step="1" value="${state.phaseTime}" id="phase-time-slider" aria-label="Phase time in seconds">
                </div>
            `;
        }
        if (state.sessionComplete) {
            html += `
                <button id="reset" class="secondary">
                    ${icons.rotateCcw}
                    Back to Start
                </button>
            `;
        }
        if (!state.isPlaying && !state.sessionComplete) {
            html += `
                <div class="shortcut-buttons">
                    <button id="preset-2min" class="preset-button chip">
                        ${icons.clock} 2 min
                    </button>
                    <button id="preset-5min" class="preset-button chip">
                        ${icons.clock} 5 min
                    </button>
                    <button id="preset-10min" class="preset-button chip">
                        ${icons.clock} 10 min
                    </button>
                </div>
            `;
        }
        app.innerHTML = html;

        updateCanvasVisibility();

        if (!state.sessionComplete) {
            document.getElementById('toggle-play').addEventListener('click', togglePlay);
        }
        if (state.sessionComplete) {
            document.getElementById('reset').addEventListener('click', resetToStart);
        }
        if (!state.isPlaying && !state.sessionComplete) {
            document.getElementById('sound-toggle').addEventListener('change', toggleSound);
            const timeLimitInput = document.getElementById('time-limit');
            timeLimitInput.addEventListener('input', handleTimeLimitChange);
            const phaseTimeSlider = document.getElementById('phase-time-slider');
            phaseTimeSlider.addEventListener('input', function() {
                state.phaseTime = parseInt(this.value);
                document.getElementById('phase-time-value').textContent = state.phaseTime;
            });
            document.getElementById('preset-2min').addEventListener('click', () => startWithPreset(2));
            document.getElementById('preset-5min').addEventListener('click', () => startWithPreset(5));
            document.getElementById('preset-10min').addEventListener('click', () => startWithPreset(10));
        }
        if (!state.isPlaying) {
            drawScene({ progress: state.sessionComplete ? 1 : 0, phase: state.count, showTrail: false });
        }
    }

    render();
    resizeCanvas();

    // Accessibility: reduce accidental overscroll bounce in PWA
    document.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) e.preventDefault();
    }, { passive: false });
});
