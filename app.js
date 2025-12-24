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
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),
        viewportWidth: initialWidth,
        viewportHeight: initialHeight,
        prefersReducedMotion: false,
        hasStarted: false
    };

    let wakeLock = null;
    let audioContext = new (window.AudioContext || window.webkitAudioContext)();

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
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);

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

    function playTone() {
        if (state.soundEnabled && audioContext) {
            try {
                const oscillator = audioContext.createOscillator();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
                oscillator.connect(audioContext.destination);
                oscillator.start();
                oscillator.stop(audioContext.currentTime + 0.1);
            } catch (e) {
                console.error('Error playing tone:', e);
            }
        }
    }

    let interval;
    let animationFrameId;
    let lastStateUpdate;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake lock is active');
            } catch (err) {
                console.error('Failed to acquire wake lock:', err);
            }
        } else {
            console.log('Wake Lock API not supported');
        }
    }

    function releaseWakeLock() {
        if (wakeLock !== null) {
            wakeLock.release()
                .then(() => {
                    wakeLock = null;
                    console.log('Wake lock released');
                })
                .catch(err => {
                    console.error('Failed to release wake lock:', err);
                });
        }
    }

    function togglePlay() {
        state.isPlaying = !state.isPlaying;
        if (state.isPlaying) {
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log('AudioContext resumed');
                });
            }
            state.hasStarted = true;
            state.totalTime = 0;
            state.countdown = state.phaseTime;
            state.count = 0;
            state.sessionComplete = false;
            state.timeLimitReached = false;
            state.pulseStartTime = performance.now();
            playTone();
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
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('AudioContext resumed');
            });
        }
        playTone();
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
                playTone();
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
        if (!width || !height) {
            return;
        }

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
        const baseSize = Math.min(width, height) * 0.6;
        const topMargin = 20;
        const sizeWithoutBreath = Math.min(baseSize, height - topMargin * 2);
        const verticalOffset = Math.min(height * 0.18, 110);
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

        ctx.strokeStyle = hexToRgba('#fcd34d', 0.25);
        ctx.lineWidth = Math.max(2, size * 0.015);
        ctx.lineJoin = 'round';
        ctx.strokeRect(adjustedLeft, adjustedTop, size, size);

        ctx.lineWidth = Math.max(4, size * 0.03);
        ctx.strokeStyle = hexToRgba(accentColor, shouldShowTrail ? 0.8 : 0.45);
        ctx.shadowColor = hexToRgba(accentColor, 0.5);
        ctx.shadowBlur = shouldShowTrail ? 15 : 8;
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
            <h1>Box Breathing</h1>
        `;
        if (state.isPlaying) {
            html += `
                <div class="timer">Total Time: ${formatTime(state.totalTime)}</div>
                <div class="instruction">${getInstruction(state.count)}</div>
                <div class="countdown">${state.countdown}</div>
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
                <div class="settings">
                    <div class="form-group">
                        <label class="switch">
                            <input type="checkbox" id="sound-toggle" ${state.soundEnabled ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                        <label for="sound-toggle">
                            ${state.soundEnabled ? icons.volume2 : icons.volumeX}
                            Sound ${state.soundEnabled ? 'On' : 'Off'}
                        </label>
                    </div>
                    <div class="form-group">
                        <input
                            type="number"
                            inputmode="numeric"
                            placeholder="Time limit (minutes)"
                            value="${state.timeLimit}"
                            id="time-limit"
                            step="1"
                            min="0"
                        >
                        <label for="time-limit">Minutes (optional)</label>
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
                <button id="toggle-play">
                    ${state.isPlaying ? icons.pause : icons.play}
                    ${state.isPlaying ? 'Pause' : 'Start'}
                </button>
            `;
        }
        if (!state.isPlaying && !state.sessionComplete) {
            html += `
                <div class="slider-container">
                    <label for="phase-time-slider">Phase Time (seconds): <span id="phase-time-value">${state.phaseTime}</span></label>
                    <input type="range" min="3" max="6" step="1" value="${state.phaseTime}" id="phase-time-slider">
                </div>
            `;
        }
        if (state.sessionComplete) {
            html += `
                <button id="reset">
                    ${icons.rotateCcw}
                    Back to Start
                </button>
            `;
        }
        if (!state.isPlaying && !state.sessionComplete) {
            html += `
                <div class="shortcut-buttons">
                    <button id="preset-2min" class="preset-button">
                        ${icons.clock} 2 min
                    </button>
                    <button id="preset-5min" class="preset-button">
                        ${icons.clock} 5 min
                    </button>
                    <button id="preset-10min" class="preset-button">
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
});
