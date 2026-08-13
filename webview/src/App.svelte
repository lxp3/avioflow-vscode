<script lang="ts">
    import { onMount } from "svelte";
    import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-svelte";
    import "./globals.css";
    import FileUpload from "./components/FileUpload.svelte";

    type ViewState = "booting" | "loading" | "ready" | "error";

    interface AudioMetadata {
        duration: number;
        sampleRate: number;
        numChannels: number;
        codec: string;
        numSamples: number;
        sampleFormat: string;
        bitRate: number;
        container: string;
        fileSize: number;
    }

    interface WaveformPeakLevel {
        samplesPerBucket: number;
        min: Float32Array[];
        max: Float32Array[];
    }

    interface LoadError {
        title: string;
        message: string;
        code?: string;
    }

    const DEFAULT_CHANNEL_HEIGHT = 120;
    const MIN_CHANNEL_HEIGHT = 48;
    const MAX_CHANNEL_HEIGHT = 360;
    const TIME_AXIS_HEIGHT = 24;
    const PAN_THRESHOLD = 5;
    const MAX_CANVAS_BITMAP_WIDTH = 16384;
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 50;
    const CHANNEL_COLORS = [
        { played: "#d32f2f", idle: "#efb7b7" },
        { played: "#1976d2", idle: "#b8d7f2" },
    ];

    let viewState: ViewState = "booting";
    let metadata: AudioMetadata | null = null;
    let samples: Float32Array[] = [];
    let peakLevels: WaveformPeakLevel[] = [];
    let filePath = "";
    let decodeTimeMs = 0;
    let totalTimeMs = 0;
    let isLoadingSamples = false;
    let loadStartTime = 0;
    let loadError: LoadError | null = null;

    let audioContext: AudioContext | null = null;
    let audioBuffer: AudioBuffer | null = null;
    let sourceNode: AudioBufferSourceNode | null = null;
    let gainNode: GainNode | null = null;
    let volume = 100;
    let isPlaying = false;
    let currentTime = 0;
    let duration = 0;
    let pageIndex = 0;
    let pageCount = 1;
    let pageStart = 0;
    let pageEnd = 0;
    let pageDuration = 0;
    let pendingPageIndex = 0;
    let startTime = 0;
    let pauseOffset = 0;
    let animationFrame = 0;
    let sourceGeneration = 0;

    let waveformCanvas: HTMLCanvasElement;
    let progressCanvas: HTMLCanvasElement;
    let canvasContainer: HTMLDivElement;
    let resizeObserver: ResizeObserver | null = null;
    let observedContainer: HTMLDivElement | null = null;
    let zoom = 1;
    let zoomInput = "1.0";
    let canvasWidth = 0;
    let isSeeking = false;
    let resumeAfterSeek = false;
    let pointerIsDown = false;
    let isPanning = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let pointerStartScrollLeft = 0;
    let manualViewport = false;
    let channelHeight = DEFAULT_CHANNEL_HEIGHT;
    let isResizingHeight = false;
    let resizeStartY = 0;
    let resizeStartHeight = DEFAULT_CHANNEL_HEIGHT;

    // @ts-ignore
    const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

    onMount(() => {
        window.addEventListener("message", handleMessage);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", finishWaveformGesture);
        window.addEventListener("pointerup", finishHeightResize);
        loadStartTime = Date.now();

        resizeObserver = new ResizeObserver(() => renderWaveforms());
        if (canvasContainer) {
            resizeObserver.observe(canvasContainer);
            observedContainer = canvasContainer;
        }
        vscode?.postMessage({ type: "ready" });

        return () => {
            window.removeEventListener("message", handleMessage);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", finishWaveformGesture);
            window.removeEventListener("pointerup", finishHeightResize);
            resizeObserver?.disconnect();
            cancelAnimationFrame(animationFrame);
            stopSource();
            audioContext?.close();
        };
    });

    function handleKeyDown(event: KeyboardEvent) {
        const target = event.target as HTMLElement | null;
        if (target?.matches("button, input, textarea, select")) return;
        if ((event.key === " " || event.code === "Space") && audioBuffer) {
            event.preventDefault();
            togglePlay();
        }
    }

    function resetPlayback() {
        cancelAnimationFrame(animationFrame);
        stopSource();
        isPlaying = false;
        isSeeking = false;
        currentTime = 0;
        pauseOffset = 0;
    }

    function handleMessage(event: MessageEvent) {
        const message = event.data;
        switch (message.type) {
            case "loading":
                resetPlayback();
                viewState = "loading";
                filePath = message.filePath || "";
                metadata = null;
                samples = [];
                peakLevels = [];
                audioBuffer = null;
                decodeTimeMs = 0;
                totalTimeMs = 0;
                duration = 0;
                pageIndex = 0;
                pageCount = 1;
                pageStart = 0;
                pageEnd = 0;
                pageDuration = 0;
                pendingPageIndex = 0;
                zoom = 1;
                zoomInput = "1.0";
                loadError = null;
                isLoadingSamples = true;
                loadStartTime = Date.now();
                break;
            case "metadata":
                viewState = "loading";
                loadError = null;
                filePath = message.filePath || "";
                metadata = message.metadata;
                duration = metadata?.duration || 0;
                pageCount = message.pageCount || 1;
                isLoadingSamples = true;
                break;
            case "pageLoading":
                resetPlayback();
                loadStartTime = Date.now();
                isLoadingSamples = true;
                samples = [];
                peakLevels = [];
                audioBuffer = null;
                pendingPageIndex = message.pageIndex || 0;
                pageStart = message.pageStart || 0;
                pageEnd = message.pageEnd || 0;
                currentTime = pageStart;
                pauseOffset = pageStart;
                zoom = 1;
                zoomInput = "1.0";
                if (canvasContainer) canvasContainer.scrollLeft = 0;
                break;
            case "samples":
                viewState = "ready";
                isLoadingSamples = false;
                decodeTimeMs = message.decodeTimeMs || 0;
                totalTimeMs = Date.now() - loadStartTime;
                loadError = null;
                pageIndex = message.pageIndex || 0;
                pendingPageIndex = pageIndex;
                pageCount = message.pageCount || pageCount;
                pageStart = message.pageStart || 0;
                pageEnd = message.pageEnd ?? duration;
                pageDuration = message.pageDuration ?? Math.max(0, pageEnd - pageStart);
                currentTime = pageStart;
                pauseOffset = pageStart;
                samples = (message.samples || []).map((channel: unknown) =>
                    channel instanceof Float32Array ? channel : new Float32Array(channel as ArrayLike<number>)
                );
                peakLevels = (message.peakLevels || []).map((level: any) => ({
                    samplesPerBucket: level.samplesPerBucket,
                    min: level.min.map((channel: unknown) => channel instanceof Float32Array ? channel : new Float32Array(channel as ArrayLike<number>)),
                    max: level.max.map((channel: unknown) => channel instanceof Float32Array ? channel : new Float32Array(channel as ArrayLike<number>)),
                }));
                initAudio();
                break;
            case "error":
                resetPlayback();
                viewState = "error";
                isLoadingSamples = false;
                metadata = null;
                samples = [];
                peakLevels = [];
                audioBuffer = null;
                loadError = {
                    title: message.title || "Failed to load audio",
                    message: message.message || "Unknown error",
                    code: message.code,
                };
                break;
        }
    }

    function initAudio() {
        if (!metadata || samples.length === 0) return;
        audioContext ??= new (window.AudioContext || (window as any).webkitAudioContext)();
        if (!gainNode) {
            gainNode = audioContext.createGain();
            gainNode.gain.value = volume / 100;
            gainNode.connect(audioContext.destination);
        }
        const length = Math.min(...samples.map((channel) => channel.length));
        audioBuffer = audioContext.createBuffer(samples.length, length, metadata.sampleRate);
        samples.forEach((channel, index) => audioBuffer?.copyToChannel(channel.subarray(0, length), index));
        requestAnimationFrame(renderWaveforms);
    }

    function pickPeakLevel(samplesPerPixel: number): WaveformPeakLevel | null {
        let best: WaveformPeakLevel | null = null;
        for (const level of peakLevels) {
            if (level.samplesPerBucket <= samplesPerPixel && (!best || level.samplesPerBucket > best.samplesPerBucket)) {
                best = level;
            }
        }
        return best;
    }

    function minMaxFromSamples(data: Float32Array, startIndex: number, endIndex: number): [number, number] {
        let min = 0;
        let max = 0;
        for (let index = startIndex; index < endIndex && index < data.length; index++) {
            min = Math.min(min, data[index]);
            max = Math.max(max, data[index]);
        }
        return [min, max];
    }

    function minMaxFromLevel(level: WaveformPeakLevel, channel: number, startIndex: number, endIndex: number): [number, number] {
        const levelMin = level.min[channel];
        const levelMax = level.max[channel];
        const startBucket = Math.floor(startIndex / level.samplesPerBucket);
        const endBucket = Math.min(levelMin.length, Math.max(startBucket + 1, Math.ceil(endIndex / level.samplesPerBucket)));
        let min = 0;
        let max = 0;
        for (let bucket = startBucket; bucket < endBucket; bucket++) {
            min = Math.min(min, levelMin[bucket]);
            max = Math.max(max, levelMax[bucket]);
        }
        return [min, max];
    }

    function renderWaveforms() {
        if (!waveformCanvas || !progressCanvas || !canvasContainer || samples.length === 0) return;
        const viewportWidth = canvasContainer.clientWidth;
        if (viewportWidth === 0) return;
        canvasWidth = Math.max(viewportWidth, Math.round(viewportWidth * zoom));
        drawWaveformCanvas(waveformCanvas, false);
        drawWaveformCanvas(progressCanvas, true);
    }

    function getTimeTicks(startTime: number, endTime: number, width: number): Array<{ time: number; left: number; major: boolean }> {
        const visibleDuration = endTime - startTime;
        if (visibleDuration <= 0 || width <= 0) return [];
        const secondsPerPixel = visibleDuration / width;
        const targetSeconds = secondsPerPixel * 80;
        const intervals = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];
        const interval = intervals.find((value) => value >= targetSeconds) || intervals[intervals.length - 1];
        const ticks: Array<{ time: number; left: number; major: boolean }> = [];
        const firstIndex = Math.ceil(startTime / interval);
        const lastIndex = Math.floor(endTime / interval);
        for (let index = firstIndex; index <= lastIndex; index++) {
            const time = index * interval;
            ticks.push({ time, left: ((time - startTime) / visibleDuration) * 100, major: index % 5 === 0 });
        }
        if (ticks.length === 0 || Math.abs(ticks[ticks.length - 1].time - endTime) > interval * 0.25) {
            ticks.push({ time: endTime, left: 100, major: true });
        }
        return ticks;
    }

    function formatAxisTime(seconds: number): string {
        if (seconds < 1) return `${seconds.toFixed(3)}s`;
        if (seconds < 10) return `${seconds.toFixed(1)}s`;
        return `${seconds.toFixed(0)}s`;
    }

    function observeCanvasContainer(container: HTMLDivElement | undefined) {
        if (!container || !resizeObserver || container === observedContainer) return;
        if (observedContainer) resizeObserver.unobserve(observedContainer);
        resizeObserver.observe(container);
        observedContainer = container;
    }

    function drawWaveformCanvas(target: HTMLCanvasElement, played: boolean) {
        const height = samples.length * channelHeight;
        const devicePixelRatio = window.devicePixelRatio || 1;
        const renderWidth = Math.min(canvasWidth, Math.floor(MAX_CANVAS_BITMAP_WIDTH / devicePixelRatio));
        target.width = Math.round(renderWidth * devicePixelRatio);
        target.height = Math.round(height * devicePixelRatio);
        target.style.width = `${canvasWidth}px`;
        target.style.height = `${height}px`;
        const context = target.getContext("2d");
        if (!context) return;
        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        context.clearRect(0, 0, renderWidth, height);

        samples.forEach((data, channel) => {
            const centerY = channel * channelHeight + channelHeight / 2;
            const amplitude = channelHeight * 0.4;
            const samplesPerPixel = data.length / renderWidth;
            const peakLevel = pickPeakLevel(samplesPerPixel);
            const channelColor = CHANNEL_COLORS[channel % CHANNEL_COLORS.length];
            context.fillStyle = played ? channelColor.played : channelColor.idle;

            for (let x = 0; x < renderWidth; x++) {
                const startIndex = Math.floor(x * samplesPerPixel);
                const endIndex = Math.max(startIndex + 1, Math.floor((x + 1) * samplesPerPixel));
                const [min, max] = peakLevel
                    ? minMaxFromLevel(peakLevel, channel, startIndex, endIndex)
                    : minMaxFromSamples(data, startIndex, endIndex);
                const top = centerY - max * amplitude;
                const bottom = centerY - min * amplitude;
                context.fillRect(x, top, 1, Math.max(1, bottom - top));
            }
        });
    }

    function stopSource() {
        sourceGeneration++;
        if (sourceNode) {
            sourceNode.onended = null;
            try { sourceNode.stop(); } catch { /* already stopped */ }
            sourceNode.disconnect();
            sourceNode = null;
        }
    }

    async function play() {
        if (!audioBuffer || !audioContext || pageDuration <= 0) return;
        if (pauseOffset >= pageEnd) {
            pauseOffset = pageStart;
            currentTime = pageStart;
        }
        await audioContext.resume();
        stopSource();
        const generation = sourceGeneration;
        sourceNode = audioContext.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(gainNode || audioContext.destination);
        sourceNode.start(0, Math.max(0, pauseOffset - pageStart));
        startTime = audioContext.currentTime - pauseOffset;
        isPlaying = true;
        sourceNode.onended = () => {
            if (generation !== sourceGeneration || !isPlaying) return;
            isPlaying = false;
            currentTime = pageEnd;
            pauseOffset = pageEnd;
            cancelAnimationFrame(animationFrame);
        };
        updatePlayback();
    }

    function pause() {
        if (!isPlaying || !audioContext) return;
        pauseOffset = Math.min(pageEnd, Math.max(pageStart, audioContext.currentTime - startTime));
        currentTime = pauseOffset;
        isPlaying = false;
        cancelAnimationFrame(animationFrame);
        stopSource();
    }

    function togglePlay() {
        if (isPlaying) pause(); else void play();
    }

    function handleVolumeInput(event: Event) {
        volume = Number((event.currentTarget as HTMLInputElement).value);
        if (gainNode && audioContext) {
            gainNode.gain.setValueAtTime(volume / 100, audioContext.currentTime);
        }
    }

    function updatePlayback() {
        if (!isPlaying || !audioContext) return;
        currentTime = Math.min(pageEnd, audioContext.currentTime - startTime);
        pauseOffset = currentTime;
        keepPlayheadVisible();
        if (currentTime < pageEnd) animationFrame = requestAnimationFrame(updatePlayback);
    }

    function keepPlayheadVisible() {
        if (zoom <= 1 || !canvasContainer || manualViewport) return;
        const playheadX = progressRatio * canvasWidth;
        const left = canvasContainer.scrollLeft;
        const right = left + canvasContainer.clientWidth;
        if (playheadX < left + 24 || playheadX > right - 40) {
            canvasContainer.scrollLeft = Math.max(0, playheadX - canvasContainer.clientWidth * 0.22);
        }
    }

    function timeFromPointer(event: PointerEvent): number {
        const rect = canvasContainer.getBoundingClientRect();
        const absoluteX = event.clientX - rect.left + canvasContainer.scrollLeft;
        return Math.max(pageStart, Math.min(pageEnd, pageStart + (absoluteX / canvasWidth) * pageDuration));
    }

    function beginWaveformGesture(event: PointerEvent) {
        if (!audioBuffer || pageDuration <= 0) return;
        event.preventDefault();
        pointerIsDown = true;
        isPanning = false;
        pointerStartX = event.clientX;
        pointerStartY = event.clientY;
        pointerStartScrollLeft = canvasContainer.scrollLeft;

        const rect = canvasContainer.getBoundingClientRect();
        const pointerX = event.clientX - rect.left + canvasContainer.scrollLeft;
        const playheadX = progressRatio * canvasWidth;
        if (Math.abs(pointerX - playheadX) <= 8) {
            resumeAfterSeek = isPlaying;
            if (isPlaying) pause();
            isSeeking = true;
            setSeekTime(timeFromPointer(event));
        }
    }

    function handleWaveformKeyDown(event: KeyboardEvent) {
        if (!audioBuffer || pageDuration <= 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (isPlaying) pause();
        if (event.key === "Home") setSeekTime(pageStart);
        else if (event.key === "End") setSeekTime(pageEnd);
        else setSeekTime(currentTime + (event.key === "ArrowRight" ? 1 : -1));
    }

    function handlePointerMove(event: PointerEvent) {
        if (isResizingHeight) {
            const deltaPerChannel = (event.clientY - resizeStartY) / Math.max(1, samples.length);
            channelHeight = Math.round(Math.max(MIN_CHANNEL_HEIGHT, Math.min(MAX_CHANNEL_HEIGHT, resizeStartHeight + deltaPerChannel)));
            renderWaveforms();
            return;
        }
        if (isSeeking) {
            setSeekTime(timeFromPointer(event));
            return;
        }
        if (!pointerIsDown) return;
        const deltaX = event.clientX - pointerStartX;
        const deltaY = event.clientY - pointerStartY;
        if (!isPanning && Math.hypot(deltaX, deltaY) >= PAN_THRESHOLD) {
            isPanning = true;
            manualViewport = true;
        }
        if (isPanning) canvasContainer.scrollLeft = pointerStartScrollLeft - deltaX;
    }

    function finishWaveformGesture(event: PointerEvent) {
        const pointerDistance = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY);
        const scrollDistance = Math.abs(canvasContainer.scrollLeft - pointerStartScrollLeft);
        const didPan = isPanning || pointerDistance >= PAN_THRESHOLD || scrollDistance >= 1;
        if (isSeeking) {
            isSeeking = false;
            if (resumeAfterSeek) void play();
            resumeAfterSeek = false;
        } else if (pointerIsDown && !didPan) {
            manualViewport = false;
            seekWithoutChangingPlayback(timeFromPointer(event));
        }
        pointerIsDown = false;
        isPanning = false;
    }

    function seekWithoutChangingPlayback(time: number) {
        const wasPlaying = isPlaying;
        if (wasPlaying) pause();
        setSeekTime(time);
        if (wasPlaying) void play();
    }

    function beginHeightResize(event: PointerEvent) {
        event.preventDefault();
        event.stopPropagation();
        isResizingHeight = true;
        resizeStartY = event.clientY;
        resizeStartHeight = channelHeight;
    }

    function finishHeightResize() {
        isResizingHeight = false;
    }

    function setSeekTime(time: number) {
        currentTime = Math.max(pageStart, Math.min(pageEnd, time));
        pauseOffset = currentTime;
    }

    function loadPage(nextPageIndex: number) {
        if (isLoadingSamples || nextPageIndex < 0 || nextPageIndex >= pageCount || nextPageIndex === pageIndex) return;
        pendingPageIndex = nextPageIndex;
        vscode?.postMessage({ type: "loadPage", pageIndex: nextPageIndex });
    }

    function handleWheel(event: WheelEvent) {
        event.preventDefault();
        const rect = canvasContainer.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const timeRatio = (canvasContainer.scrollLeft + pointerX) / canvasWidth;
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
        setZoom(nextZoom, timeRatio, pointerX);
    }

    function setZoom(nextZoom: number, anchorRatio = 0.5, anchorX = canvasContainer?.clientWidth / 2 || 0) {
        const normalizedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
        zoomInput = normalizedZoom.toFixed(1);
        if (normalizedZoom === zoom) return;
        zoom = normalizedZoom;
        requestAnimationFrame(() => {
            renderWaveforms();
            canvasContainer.scrollLeft = Math.max(0, anchorRatio * canvasWidth - anchorX);
        });
    }

    function applyZoomInput() {
        const parsedZoom = Number.parseFloat(zoomInput.trim().replace(/x$/i, ""));
        if (!Number.isFinite(parsedZoom)) {
            zoomInput = zoom.toFixed(1);
            return;
        }
        setZoom(parsedZoom);
    }

    function handleZoomInputKeyDown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault();
            applyZoomInput();
            (event.currentTarget as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
            zoomInput = zoom.toFixed(1);
            (event.currentTarget as HTMLInputElement).blur();
        }
    }

    function zoomIn() { setZoom(Math.min(MAX_ZOOM, zoom * 1.5)); }
    function zoomOut() { setZoom(Math.max(MIN_ZOOM, zoom / 1.5)); }
    function resetZoom() {
        setZoom(1, 0, 0);
        requestAnimationFrame(() => {
            canvasContainer.scrollLeft = 0;
        });
    }

    function formatClock(seconds: number, precise = false): string {
        if (!Number.isFinite(seconds)) return precise ? "0:00.0" : "0:00";
        const minutes = Math.floor(seconds / 60);
        const remaining = seconds - minutes * 60;
        return `${minutes}:${remaining.toFixed(precise ? 1 : 0).padStart(precise ? 4 : 2, "0")}`;
    }

    function formatSeconds(seconds: number): string {
        return `${Number.isFinite(seconds) ? seconds.toFixed(3) : "0.000"}s`;
    }

    function formatMilliseconds(milliseconds: number): string {
        return Number.isFinite(milliseconds) ? `${milliseconds.toFixed(0)} ms` : "-";
    }

    function formatSize(bytes: number): string {
        if (!bytes || !Number.isFinite(bytes)) return "-";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(3)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(3)} MB`;
    }

    function getFileName(path: string): string {
        return path.split(/[\\/]/).pop() || path;
    }

    function handleFileUpload() {
        loadStartTime = Date.now();
        loadError = null;
        viewState = "loading";
        vscode?.postMessage({ type: "selectFile" });
    }

    $: waveformHeight = samples.length > 0 ? samples.length * channelHeight : 128;
    $: timeTicks = getTimeTicks(pageStart, pageEnd, canvasWidth);
    $: observeCanvasContainer(canvasContainer);
    $: progressRatio = pageDuration > 0 ? Math.max(0, Math.min(1, (currentTime - pageStart) / pageDuration)) : 0;
    $: metadataItems = metadata ? [
        ["文件大小 (file size)", formatSize(metadata.fileSize)],
        ["容器 (container)", metadata.container || "-"],
        ["通道数 (channels)", String(metadata.numChannels || "-")],
        ["编码 (codec)", metadata.codec || "-"],
        ["采样率 (sample rate)", metadata.sampleRate ? `${metadata.sampleRate.toLocaleString()} Hz` : "-"],
        ["样本格式 (sample format)", metadata.sampleFormat || "-"],
        ["时长 (duration)", `${Number.isFinite(duration) ? duration.toFixed(3) : "0.000"} 秒`],
        ["码率 (bit rate)", metadata.bitRate ? `${Math.round(metadata.bitRate / 1000)} kbps` : "-"],
    ] : [];
</script>

<main class="app-shell">
    {#if viewState === "ready" || viewState === "loading"}
        <header class="file-header">
            <div class="title-row">
                <div class="file-copy">
                    <h1>{getFileName(filePath) || "正在载入音频"}</h1>
                    <p title={filePath}>{filePath}</p>
                </div>
                <div class="timing-badges" aria-label="处理耗时">
                    <span>总计 {formatMilliseconds(totalTimeMs)}</span>
                    <span>解码 {formatMilliseconds(decodeTimeMs)}</span>
                </div>
            </div>

            {#if metadata}
                <section class="metadata-grid" aria-label="音频元数据">
                    {#each metadataItems as item}
                        <div class="metadata-item">
                            <span>{item[0]}</span>
                            <strong>{item[1]}</strong>
                        </div>
                    {/each}
                </section>
            {/if}
        </header>

        <section class="waveform-card">
            <div class="player-toolbar">
                <div class="transport">
                    <button class="play-button" on:click={togglePlay} disabled={!audioBuffer} aria-label={isPlaying ? "暂停" : "播放"}>
                        {#if isPlaying}<Pause size={17} fill="currentColor" />{:else}<Play size={17} fill="currentColor" />{/if}
                    </button>
                    <span class="clock current">{formatSeconds(currentTime)}</span>
                    <span class="clock-separator">/</span>
                    <span class="clock">{formatSeconds(duration)}</span>
                </div>

                <label class="volume-control" title={`音量 ${volume}%`}>
                    <span>音量</span>
                    <input type="range" min="0" max="100" step="1" value={volume} on:input={handleVolumeInput} aria-label="音量" />
                    <output>{volume}%</output>
                </label>

                <div class="toolbar-actions">
                    <div class="page-controls" aria-label="音频分页">
                        <button on:click={() => loadPage(pageIndex - 1)} disabled={isLoadingSamples || pageIndex <= 0} aria-label="上一段"><ChevronLeft size={16} /></button>
                        <span title={`${formatSeconds(pageStart)} - ${formatSeconds(pageEnd)}`}>
                            {isLoadingSamples ? pendingPageIndex + 1 : pageIndex + 1} / {pageCount}
                        </span>
                        <button on:click={() => loadPage(pageIndex + 1)} disabled={isLoadingSamples || pageIndex >= pageCount - 1} aria-label="下一段"><ChevronRight size={16} /></button>
                    </div>
                    <div class="zoom-controls">
                        <button on:click={zoomOut} disabled={zoom <= MIN_ZOOM} aria-label="缩小"><ZoomOut size={16} /></button>
                        <label class="zoom-input" title="输入 1–50 的缩放倍数">
                            <input bind:value={zoomInput} on:blur={applyZoomInput} on:keydown={handleZoomInputKeyDown} inputmode="decimal" aria-label="缩放倍数" />
                            <span>×</span>
                        </label>
                        <button on:click={zoomIn} disabled={zoom >= MAX_ZOOM} aria-label="放大"><ZoomIn size={16} /></button>
                        <button on:click={resetZoom} disabled={zoom === 1} aria-label="重置缩放"><RotateCcw size={15} /></button>
                    </div>
                </div>
            </div>

            <div class="waveform-body">
                {#if samples.length > 0}
                    <div class="track-column" style={`height:${waveformHeight + TIME_AXIS_HEIGHT}px`}>
                        <div class="track-axis-label">时间</div>
                        <div class="track-labels" aria-label="通道轨道" style={`height:${waveformHeight}px`}>
                        {#each samples as _, channel}
                            <div style={`height:${channelHeight}px`}><span style={`background:${CHANNEL_COLORS[channel % 2].played}`}></span>ch-{channel}</div>
                        {/each}
                        </div>
                    </div>
                {/if}
                <div
                    bind:this={canvasContainer}
                    class="waveform-viewport"
                    class:is-seeking={isSeeking}
                    class:is-panning={isPanning}
                    style={`height:${waveformHeight + TIME_AXIS_HEIGHT}px`}
                    role="slider"
                    tabindex="0"
                    aria-label="播放进度"
                    aria-valuemin={pageStart}
                    aria-valuemax={pageEnd}
                    aria-valuenow={currentTime}
                    aria-valuetext={`${formatSeconds(currentTime)} / ${formatSeconds(duration)}`}
                    on:wheel={handleWheel}
                    on:pointerdown={beginWaveformGesture}
                    on:keydown={handleWaveformKeyDown}
                >
                    {#if isLoadingSamples}
                        <div class="state-panel">
                            <div class="spinner"></div>
                            <div><strong>{metadata ? "正在生成波形数据…" : "正在打开音频文件…"}</strong><span>元数据会先显示，PCM 解码完成后即可播放。</span></div>
                        </div>
                    {:else if samples.length > 0}
                        <div class="timeline-stage" style={`width:${canvasWidth}px;height:${waveformHeight + TIME_AXIS_HEIGHT}px`}>
                            <div class="time-axis" style={`height:${TIME_AXIS_HEIGHT}px`}>
                                {#each timeTicks as tick}
                                    <div class:major={tick.major} class="time-tick" style={`left:${tick.left}%`}>
                                        <span>{formatAxisTime(tick.time)}</span>
                                    </div>
                                {/each}
                            </div>
                            <div class="canvas-stage" style={`top:${TIME_AXIS_HEIGHT}px;width:${canvasWidth}px;height:${waveformHeight}px`}>
                                <canvas bind:this={waveformCanvas} class="waveform-layer"></canvas>
                                <div class="progress-clip" style={`width:${progressRatio * 100}%`}>
                                    <canvas bind:this={progressCanvas} class="waveform-layer"></canvas>
                                </div>
                                {#each samples as _, channel}
                                    <div class="channel-divider" style={`top:${(channel + 1) * channelHeight}px`}></div>
                                {/each}
                            </div>
                            <div class="playhead" style={`left:${progressRatio * 100}%`}></div>
                        </div>
                    {:else}
                        <div class="state-panel"><strong>没有可显示的波形数据</strong></div>
                    {/if}
                </div>
            </div>
            {#if samples.length > 0}
                <button
                    type="button"
                    class="height-resizer"
                    class:is-resizing={isResizingHeight}
                    aria-label="调整通道轨道高度"
                    on:pointerdown={beginHeightResize}
                ><span></span></button>
            {/if}

            <div class="waveform-hint">
                <span>当前区间 {formatSeconds(pageStart)} – {formatSeconds(pageEnd)}</span>
                <span>点击或拖动垂直播放头调整进度 · 滚轮缩放 · 空格播放/暂停</span>
            </div>
        </section>
    {:else if viewState === "error" && loadError}
        <div class="home-container">
            <div class="intro-section error-panel">
                <h1>{loadError.title}</h1>
                <p>{loadError.message}</p>
                {#if loadError.code}<code>{loadError.code}</code>{/if}
            </div>
            <FileUpload on:select={handleFileUpload} />
        </div>
    {:else}
        <div class="home-container">
            <div class="intro-section"><h1>正在初始化音频预览…</h1><p>即将读取音频文件并准备波形显示。</p></div>
        </div>
    {/if}
</main>

<style>
    :global(:root) {
        --surface: #ffffff;
        --surface-muted: #f7f9f8;
        --border: #dfe7e2;
        --text: #17211b;
        --muted: #68756d;
        --accent: #2f855a;
        --accent-dark: #246b48;
        --accent-soft: #edf8f1;
    }

    .app-shell { min-height: 100%; padding: 20px; color: var(--text); background: #f3f6f4; overflow: auto; }
    .file-header, .waveform-card { max-width: 1440px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 8px 28px rgba(31, 65, 45, 0.06); }
    .file-header { padding: 18px 20px 20px; }
    .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
    .file-copy { min-width: 0; }
    .file-copy h1 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 700; }
    .file-copy p { margin: 5px 0 0; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .timing-badges { display: flex; flex: none; gap: 7px; }
    .timing-badges span { padding: 5px 9px; border-radius: 999px; background: var(--surface-muted); color: var(--muted); font-size: 11px; }
    .metadata-grid { display: inline-grid; width: fit-content; max-width: 100%; grid-template-columns: repeat(2, minmax(260px, max-content)); gap: 1px; margin-top: 17px; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--border); }
    .metadata-item { display: flex; align-items: center; justify-content: space-between; min-width: 0; padding: 10px 13px; background: var(--surface-muted); }
    .metadata-item span { color: #111827; font-family: "Segoe UI Variable", "Inter", "Noto Sans SC", "Microsoft YaHei", sans-serif; font-size: 12px; font-weight: 700; letter-spacing: .01em; }
    .metadata-item strong { margin-left: 16px; overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .waveform-card { margin-top: 14px; overflow: hidden; }
    .player-toolbar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 24px; padding: 11px 14px; }
    .transport, .zoom-controls, .page-controls, .toolbar-actions { display: flex; align-items: center; }
    button { font: inherit; }
    .play-button { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; margin-right: 11px; border: 0; border-radius: 50%; background: var(--accent); color: #fff; cursor: pointer; box-shadow: 0 3px 10px rgba(47, 133, 90, 0.25); }
    .play-button:hover:not(:disabled) { background: var(--accent-dark); }
    .play-button:disabled { cursor: wait; opacity: .45; }
    .volume-control { display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--muted); font-size: 10px; }
    .volume-control input { width: 88px; height: 4px; margin: 0; accent-color: var(--accent); cursor: pointer; }
    .volume-control output { width: 31px; color: #536158; font: 600 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
    .clock { min-width: 58px; color: var(--muted); font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .clock.current { color: var(--accent-dark); }
    .clock-separator { margin: 0 5px; color: #a7b0aa; }
    .toolbar-actions { justify-content: flex-end; gap: 12px; }
    .zoom-controls, .page-controls { gap: 4px; }
    .zoom-controls button, .page-controls button { display: inline-flex; align-items: center; justify-content: center; width: 29px; height: 29px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: #56635b; cursor: pointer; }
    .zoom-controls button:hover:not(:disabled), .page-controls button:hover:not(:disabled) { border-color: #b8d3c1; background: var(--accent-soft); color: var(--accent-dark); }
    .zoom-controls button:disabled, .page-controls button:disabled { cursor: default; opacity: .35; }
    .zoom-input { display: flex; align-items: center; width: 52px; height: 27px; border: 1px solid var(--border); border-radius: 6px; background: #fff; }
    .zoom-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    .zoom-input input { width: 34px; min-width: 0; padding: 0 2px 0 6px; border: 0; outline: 0; background: transparent; color: #536158; font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
    .zoom-input span { width: auto; color: var(--muted); font-size: 11px; }
    .page-controls span { min-width: 48px; color: var(--muted); font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
    .waveform-body { display: flex; width: 100%; background: #fff; }
    .track-column { flex: 0 0 58px; background: #fff; }
    .track-axis-label { height: 24px; display: flex; align-items: center; justify-content: center; color: #7a867e; font-size: 10px; }
    .track-labels { color: #657269; }
    .track-labels div { display: flex; align-items: center; gap: 6px; padding: 0 8px; font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .track-labels span { width: 7px; height: 7px; flex: none; border-radius: 50%; }
    .waveform-viewport { position: relative; width: 100%; min-height: 128px; overflow-x: auto; overflow-y: hidden; background: #fff; cursor: crosshair; touch-action: none; scrollbar-color: #b9c6be transparent; scrollbar-width: thin; }
    .waveform-viewport.is-seeking { cursor: ew-resize; }
    .waveform-viewport.is-panning { cursor: grabbing; user-select: none; }
    .timeline-stage { position: relative; min-width: 100%; }
    .time-axis { position: absolute; inset: 0 0 auto; background: #fff; pointer-events: none; }
    .time-tick { position: absolute; bottom: 0; width: 1px; height: 6px; background: #aebbb3; }
    .time-tick.major { height: 9px; background: #839087; }
    .time-tick span { position: absolute; top: 2px; left: 3px; color: #758179; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .time-tick:last-child span { left: auto; right: 3px; }
    .canvas-stage { position: absolute; left: 0; min-width: 100%; }
    .waveform-layer { position: absolute; inset: 0; display: block; }
    .progress-clip { position: absolute; inset: 0 auto 0 0; overflow: hidden; pointer-events: none; }
    .channel-divider { display: none; }
    .channel-divider:last-of-type { display: none; }
    .playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: #000; pointer-events: none; transform: translateX(-.5px); }
    .height-resizer { display: flex; width: 100%; min-width: 100%; align-items: center; justify-content: center; height: 13px; padding: 0; border: 0; border-radius: 0; background: #fff; cursor: ns-resize; touch-action: none; }
    .height-resizer span { width: 38px; height: 3px; border-radius: 999px; background: #b9c6be; }
    .height-resizer:hover span, .height-resizer.is-resizing span { background: var(--accent); }
    .waveform-hint { display: flex; justify-content: center; gap: 16px; padding: 8px 14px; color: #7a867e; font-size: 11px; text-align: center; }
    .state-panel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 18px; color: var(--muted); text-align: left; }
    .state-panel strong, .state-panel span { display: block; }
    .state-panel strong { color: #39463e; font-size: 13px; }
    .state-panel span { margin-top: 3px; font-size: 11px; }
    .spinner { width: 20px; height: 20px; border: 2px solid #cfe5d7; border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    .home-container { min-height: calc(100vh - 40px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
    .intro-section { text-align: center; }
    .intro-section h1 { margin: 0 0 8px; font-size: 24px; }
    .intro-section p { max-width: 520px; margin: 0; color: var(--muted); font-size: 14px; }
    .error-panel h1 { color: #b42318; }
    .error-panel code { display: inline-block; margin-top: 10px; color: #b42318; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 720px) {
        .app-shell { padding: 10px; }
        .title-row { display: block; }
        .timing-badges { margin-top: 12px; }
        .metadata-grid { grid-template-columns: 1fr; }
        .player-toolbar { grid-template-columns: 1fr; gap: 10px; }
        .transport, .zoom-controls, .volume-control { justify-content: center; }
    }
</style>
