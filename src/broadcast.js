const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readAdminConfig } = require("./adminStore");
const { listTracks, resolveInside } = require("./music");
const { writeSystemLog } = require("./systemLog");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
const VOICE_DELAY_MIN_MS = 20_000;
const VOICE_DELAY_MAX_MS = 25_000;
const VOICE_BRIDGE_MIN_SECONDS = 3;

class BroadcastStream {
  constructor(config) {
    this.config = config;
    this.clients = new Set();
    this.queue = [];
    this.musicQueue = [];
    this.activeMusicItems = [];
    this.activeMusicIndex = -1;
    this.activeMusicProcess = null;
    this.activeLiveProcess = null;
    this.activeLiveSegment = null;
    this.liveInterruptedForMusic = false;
    this.interruptMusicAfterCurrent = false;
    this.musicInterrupted = false;
    this.voiceBridgeAfterMusicInterrupt = false;
    this.currentPlayItem = null;
    this.currentMusic = null;
    this.running = false;
    this.currentTrackIndex = 0;
    this.currentTrackOffset = 0;
    this.audioBitrate = "192k";
    this.nextVoiceAllowedAt = 0;
    this.voiceReadyInterruptTimer = null;
    this.lastMusicEnqueueError = "";
    this.durationCache = new Map();
    this.lastStatus = {
      mode: "idle",
      title: "",
      queueLength: 0,
      musicQueueLength: 0,
      musicQueue: [],
      currentPlay: null,
      updatedAt: new Date().toISOString(),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((error) => {
      console.error(`Broadcast loop stopped: ${error.message}`);
      this.running = false;
      setTimeout(() => this.start(), 3000);
    });
  }

  openClient(request, response) {
    response.writeHead(200, streamHeaders());

    this.clients.add(response);
    this.interruptLiveForQueuedContent();
    this.start();
    request.on("close", () => {
      this.clients.delete(response);
    });
  }

  writeHead(response) {
    response.writeHead(200, streamHeaders());
    response.end();
  }

  enqueueVoice(payload, options = {}) {
    const voicePath = this.resolveAudioUrl(payload?.audioUrl);
    if (!voicePath) return false;

    this.queue.push({
      payload,
      voicePath,
      delayAfterMs: Number.isFinite(options.delayAfterMs) ? options.delayAfterMs : randomBetween(VOICE_DELAY_MIN_MS, VOICE_DELAY_MAX_MS),
      onStart: typeof options.onStart === "function" ? options.onStart : null,
      onEnd: typeof options.onEnd === "function" ? options.onEnd : null,
      onError: typeof options.onError === "function" ? options.onError : null,
      preludeSeconds: Number.isFinite(options.preludeSeconds) ? Math.max(0, options.preludeSeconds) : null,
      postludeSeconds: Number.isFinite(options.postludeSeconds) ? Math.max(0, options.postludeSeconds) : null,
      createdAt: Date.now(),
    });
    this.log("voice_queued", {
      title: payload?.title || payload?.topic || "Voice",
      source: payload?.source || "unknown",
      queueLength: this.queue.length,
      currentPlay: this.currentPlayItem?.file || null,
    });
    if (this.currentPlayItem && this.activeMusicProcess) {
      this.interruptMusicAfterCurrent = true;
    } else if (this.activeLiveProcess && this.clients.size > 0 && Date.now() >= this.nextVoiceAllowedAt) {
      this.liveInterruptedForMusic = true;
      this.activeLiveProcess.kill("SIGTERM");
    }
    this.updateStatus({
      mode: this.lastStatus.mode,
      title: this.lastStatus.title,
      queueLength: this.queue.length,
    });
    this.scheduleVoiceReadyInterrupt();
    this.start();
    return true;
  }

  enqueueMusic(file) {
    const musicPath = this.resolveMusicFile(file);
    this.lastMusicEnqueueError = "";
    if (!musicPath) {
      this.lastMusicEnqueueError = "Track file is not available";
      return false;
    }
    const normalizedFile = String(file || "");
    if (this.isMusicFileBusy(normalizedFile)) {
      this.lastMusicEnqueueError = "Track is already playing or queued";
      return false;
    }
    this.musicQueue.push({
      id: `play:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      file: normalizedFile,
      musicPath,
      title: path.basename(normalizedFile, path.extname(normalizedFile)).replace(/[_-]+/g, " ").trim(),
      createdAt: Date.now(),
    });
    this.log("play_queued", {
      file: normalizedFile,
      queueLength: this.musicQueue.length,
      currentPlay: this.currentPlayItem?.file || null,
    });
    this.updateStatus({
      mode: this.lastStatus.mode,
      title: this.lastStatus.title,
      queueLength: this.queue.length,
      musicQueueLength: this.getPublicMusicQueueLength(),
      musicQueue: this.getPublicMusicQueue(),
    });
    this.interruptLiveForQueuedContent();
    this.start();
    return true;
  }

  interruptLiveForQueuedContent() {
    if (!this.activeLiveProcess || this.clients.size <= 0) return;
    const voiceReady = this.queue.length > 0 && Date.now() >= this.nextVoiceAllowedAt;
    const musicReady = this.musicQueue.length > 0;
    if (!voiceReady && !musicReady) {
      this.scheduleVoiceReadyInterrupt();
      return;
    }
    this.liveInterruptedForMusic = true;
    this.activeLiveProcess.kill("SIGTERM");
  }

  scheduleVoiceReadyInterrupt() {
    this.clearVoiceReadyInterrupt();
    if (!this.queue.length || this.clients.size <= 0 || this.currentPlayItem || this.activeMusicProcess) return;

    const delayMs = Math.max(0, this.nextVoiceAllowedAt - Date.now());
    this.voiceReadyInterruptTimer = setTimeout(() => {
      this.voiceReadyInterruptTimer = null;
      if (!this.queue.length || this.clients.size <= 0 || this.currentPlayItem || this.activeMusicProcess) return;
      if (Date.now() < this.nextVoiceAllowedAt) {
        this.scheduleVoiceReadyInterrupt();
        return;
      }
      if (this.activeLiveProcess) {
        this.liveInterruptedForMusic = true;
        this.log("live_interrupted_for_voice", {
          queueLength: this.queue.length,
          waitedMs: Math.max(0, Date.now() - this.nextVoiceAllowedAt),
        });
        this.activeLiveProcess.kill("SIGTERM");
      } else {
        this.start();
      }
    }, delayMs);
  }

  clearVoiceReadyInterrupt() {
    if (!this.voiceReadyInterruptTimer) return;
    clearTimeout(this.voiceReadyInterruptTimer);
    this.voiceReadyInterruptTimer = null;
  }

  voicePreludeSecondsUntilReady() {
    const delaySeconds = Math.max(0, (this.nextVoiceAllowedAt - Date.now()) / 1000);
    return Math.max(VOICE_BRIDGE_MIN_SECONDS, delaySeconds);
  }

  clearQueue() {
    const cleared = this.queue.length;
    this.queue = [];
    this.nextVoiceAllowedAt = 0;
    this.clearVoiceReadyInterrupt();
    this.log("voice_queue_cleared", { cleared });
    this.updateStatus({
      mode: this.lastStatus.mode,
      title: this.lastStatus.title,
      queueLength: 0,
      musicQueueLength: this.getPublicMusicQueueLength(),
    });
    return cleared;
  }

  resetBroadcast(reason = "admin_reset") {
    const clearedVoice = this.queue.length;
    const clearedMusic = this.musicQueue.length + this.activeMusicItems.length;
    this.queue = [];
    this.musicQueue = [];
    this.activeMusicItems = [];
    this.activeMusicIndex = -1;
    this.currentPlayItem = null;
    this.currentMusic = null;
    this.liveInterruptedForMusic = false;
    this.interruptMusicAfterCurrent = false;
    this.musicInterrupted = false;
    this.voiceBridgeAfterMusicInterrupt = false;
    this.nextVoiceAllowedAt = 0;
    this.clearVoiceReadyInterrupt();
    this.stopActiveProcesses();
    this.updateStatus({
      mode: "resetting",
      title: "Broadcast reset",
      queueLength: 0,
      musicQueueLength: 0,
      musicQueue: [],
      currentPlay: null,
    });
    this.log("broadcast_reset", { reason, clearedVoice, clearedMusic });
    this.start();
    return { clearedVoice, clearedMusic, stream: this.getStatus() };
  }

  stopBroadcast(reason = "admin_stop") {
    const clearedVoice = this.queue.length;
    const clearedMusic = this.musicQueue.length + this.activeMusicItems.length;
    this.running = false;
    this.queue = [];
    this.musicQueue = [];
    this.activeMusicItems = [];
    this.activeMusicIndex = -1;
    this.currentPlayItem = null;
    this.currentMusic = null;
    this.clearVoiceReadyInterrupt();
    this.stopActiveProcesses();
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.updateStatus({
      mode: "stopped",
      title: "Broadcast stopped",
      queueLength: 0,
      musicQueueLength: 0,
      musicQueue: [],
      currentPlay: null,
    });
    this.log("broadcast_stopped", { reason, clearedVoice, clearedMusic });
    return { clearedVoice, clearedMusic, stream: this.getStatus() };
  }

  stopActiveProcesses() {
    for (const process of [this.activeLiveProcess, this.activeMusicProcess]) {
      if (process && !process.killed) process.kill("SIGTERM");
    }
    this.activeLiveProcess = null;
    this.activeMusicProcess = null;
  }

  getStatus() {
    return {
      ...this.lastStatus,
      listeners: this.clients.size,
      musicQueueLength: this.getPublicMusicQueueLength(),
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.currentPlayItem ? this.toPublicMusicItem(this.currentPlayItem) : null,
      currentMusic: this.getPublicCurrentMusic(),
      nextVoiceInMs: this.queue.length > 0 ? Math.max(0, this.nextVoiceAllowedAt - Date.now()) : 0,
    };
  }

  async syncMusicFiles() {
    this.durationCache.clear();
    const [liveTracks, playTracks] = await Promise.all([
      listTracks(this.config.liveMusicDir, { urlPrefix: "/music/live" }),
      listTracks(this.config.playMusicDir, { urlPrefix: "/music/play" }),
    ]);
    const playFiles = new Set(playTracks.map((track) => track.file));
    const beforeQueue = this.musicQueue.length;
    this.musicQueue = this.musicQueue.filter((item) => playFiles.has(item.file));
    this.activeMusicItems = this.activeMusicItems.filter((item) => playFiles.has(item.file));
    this.updateStatus({
      mode: this.lastStatus.mode,
      title: this.lastStatus.title,
      queueLength: this.queue.length,
      musicQueueLength: this.getPublicMusicQueueLength(),
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.currentPlayItem ? this.toPublicMusicItem(this.currentPlayItem) : null,
    });
    const result = {
      liveTracks,
      playTracks,
      removedQueued: beforeQueue - this.musicQueue.length,
    };
    this.log("music_synced", {
      liveTracks: liveTracks.length,
      playTracks: playTracks.length,
      removedQueued: result.removedQueued,
    });
    return result;
  }

  async loop() {
    while (this.running) {
      const tracks = await this.readTracks();
      if (!tracks.length) {
        this.updateStatus({ mode: "waiting_music", title: "No music files", queueLength: this.queue.length });
        await delay(2000);
        continue;
      }

      this.currentTrackIndex %= tracks.length;
      const canPlayVoice = this.queue.length > 0 && this.clients.size > 0 && Date.now() >= this.nextVoiceAllowedAt;
      if (this.queue.length > 0 && this.clients.size === 0) {
        this.updateStatus({ mode: "voice_waiting_listener", title: "Voice queued, waiting for listener", queueLength: this.queue.length });
      }

      if (this.musicQueue.length > 0 && this.clients.size > 0) {
        await this.streamMusicQueue(tracks);
        this.updateStatus({ mode: "music", title: "Music playlist", queueLength: this.queue.length, musicQueueLength: this.getPublicMusicQueueLength(), musicQueue: this.getPublicMusicQueue(), currentPlay: null });
        continue;
      }

      if (canPlayVoice) {
        this.clearVoiceReadyInterrupt();
        const nextVoice = this.queue.shift();
        this.voiceBridgeAfterMusicInterrupt = false;
        await this.streamVoiceSegment(tracks, nextVoice, this.resolveVoiceTiming(nextVoice, 3, 3));
        this.nextVoiceAllowedAt = Date.now() + nextVoice.delayAfterMs;
        this.updateStatus({ mode: "music_between_voice", title: "Music between voice items", queueLength: this.queue.length, musicQueueLength: this.getPublicMusicQueueLength() });
        this.scheduleVoiceReadyInterrupt();
        continue;
      }

      if (this.musicQueue.length > 0 && this.clients.size === 0) {
        this.updateStatus({ mode: "music_insert_waiting_listener", title: "Music insert queued, waiting for listener", queueLength: this.queue.length, musicQueueLength: this.getPublicMusicQueueLength(), musicQueue: this.getPublicMusicQueue() });
      }

      await this.streamMusicSegment(tracks);
    }
  }

  async legacyStreamMusicQueue(tracks) {
    let savedIndex = this.currentTrackIndex % tracks.length;
    let savedOffset = Math.max(0, this.currentTrackOffset);
    let savedTrack = tracks[savedIndex];
    let savedPath = resolveInside(this.config.liveMusicDir, savedTrack.file);
    let savedDuration = await this.probeDuration(savedPath);
    if (savedOffset >= savedDuration - 1) {
      savedIndex = (savedIndex + 1) % tracks.length;
      savedOffset = 0;
      savedTrack = tracks[savedIndex];
      savedPath = resolveInside(this.config.liveMusicDir, savedTrack.file);
      savedDuration = await this.probeDuration(savedPath);
    }

    const first = this.musicQueue.shift();
    if (!first) return;

    let current = first;
    let currentDuration = await this.probeDuration(current.musicPath);
    const fadeSeconds = Math.max(1, Math.min(3, currentDuration / 3, Math.max(1, savedDuration - savedOffset)));
    let returnIndex = savedIndex;
    let returnTrack = savedTrack;
    let returnPath = savedPath;
    let returnOffset = savedOffset + fadeSeconds;
    if (returnOffset >= savedDuration - 0.5) {
      returnIndex = (savedIndex + 1) % tracks.length;
      returnTrack = tracks[returnIndex];
      returnPath = resolveInside(this.config.liveMusicDir, returnTrack.file);
      returnOffset = 0;
      savedDuration = await this.probeDuration(returnPath);
    }

    this.currentPlayItem = current;
    this.updateStatus({
      mode: "music_transition",
      title: `Переход к треку: ${current.title}`,
      queueLength: this.queue.length,
      musicQueueLength: this.musicQueue.length,
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.toPublicMusicItem(current),
    });
    await this.streamCrossfade(savedPath, savedOffset, current.musicPath, 0, fadeSeconds, `${savedTrack.title} -> ${current.title}`);

    let currentStart = fadeSeconds;
    let returnedToLive = false;
    while (true) {
      const middleDuration = Math.max(0, currentDuration - currentStart - fadeSeconds);
      if (middleDuration > 0.15) {
        this.currentPlayItem = current;
        this.updateStatus({
          mode: "music_insert",
          title: current.title,
          queueLength: this.queue.length,
          musicQueueLength: this.musicQueue.length,
          musicQueue: this.getPublicMusicQueue(),
          currentPlay: this.toPublicMusicItem(current),
        });
        await this.streamSingleMusic(current.musicPath, currentStart, middleDuration, current.title);
      }

      const next = this.musicQueue.shift() || null;
      if (!next) {
        this.updateStatus({
          mode: "music_transition",
          title: `Возврат к live: ${returnTrack.title}`,
          queueLength: this.queue.length,
          musicQueueLength: this.musicQueue.length,
          musicQueue: this.getPublicMusicQueue(),
          currentPlay: this.currentPlayItem ? this.toPublicMusicItem(this.currentPlayItem) : null,
        });
        await this.streamCrossfade(current.musicPath, Math.max(0, currentDuration - fadeSeconds), returnPath, returnOffset, fadeSeconds, `${current.title} -> ${returnTrack.title}`);
        returnedToLive = true;
        break;
      }

      const nextDuration = await this.probeDuration(next.musicPath);
      this.currentPlayItem = next;
      this.log("transition_play_to_play", {
        from: current.file,
        to: next.file,
        fadeSeconds: nextFade,
      });
      this.updateStatus({
        mode: "music_transition",
        title: `Переход к треку: ${next.title}`,
        queueLength: this.queue.length,
        musicQueueLength: this.musicQueue.length,
        musicQueue: this.getPublicMusicQueue(),
        currentPlay: this.toPublicMusicItem(next),
      });
      await this.streamCrossfade(current.musicPath, Math.max(0, currentDuration - fadeSeconds), next.musicPath, 0, fadeSeconds, `${current.title} -> ${next.title}`);
      current = next;
      currentDuration = nextDuration;
      currentStart = fadeSeconds;
    }

    if (!returnedToLive) {
      this.updateStatus({
      mode: "music_transition",
      title: `Возврат к live: ${returnTrack.title}`,
      queueLength: this.queue.length,
      musicQueueLength: this.musicQueue.length,
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.currentPlayItem ? this.toPublicMusicItem(this.currentPlayItem) : null,
      });
      await this.streamCrossfade(current.musicPath, Math.max(0, currentDuration - fadeSeconds), returnPath, returnOffset, fadeSeconds, `${current.title} -> ${returnTrack.title}`);
    }

    this.currentPlayItem = null;
    this.currentTrackIndex = returnIndex;
    this.currentTrackOffset = returnOffset + fadeSeconds;
    if (this.currentTrackOffset >= savedDuration - 0.05) {
      this.currentTrackIndex = (returnIndex + 1) % tracks.length;
      this.currentTrackOffset = 0;
    }
  }

  async streamMusicQueue(tracks) {
    let current = this.musicQueue.shift();
    if (!current) return;

    this.activeMusicItems = [];
    this.activeMusicIndex = -1;
    this.interruptMusicAfterCurrent = false;
    this.musicInterrupted = false;

    let live = await this.getLiveState(tracks);
    let currentDuration = await this.probeDuration(current.musicPath);
    let fadeSeconds = this.pickFadeSeconds(currentDuration, live.duration - live.offset);

    await this.transitionLiveToPlay(live, current, fadeSeconds);
    live = await this.advanceLiveState(tracks, live, fadeSeconds);
    let playStart = fadeSeconds;

    while (current) {
      this.currentPlayItem = current;
      this.updateStatus({
        mode: "music_insert",
        title: current.title,
        queueLength: this.queue.length,
        musicQueueLength: this.getPublicMusicQueueLength(),
        musicQueue: this.getPublicMusicQueue(),
        currentPlay: this.toPublicMusicItem(current),
      });

      const middleDuration = Math.max(0, currentDuration - playStart - fadeSeconds);
      if (middleDuration > 0.15) {
        this.setCurrentMusic({
          kind: "play",
          file: current.file,
          title: current.title,
          durationSeconds: currentDuration,
          positionSeconds: playStart,
        });
        await this.streamSingleMusic(current.musicPath, playStart, middleDuration, current.title);
      }

      const shouldBridgeVoice = this.queue.length > 0 && this.clients.size > 0;
      if (shouldBridgeVoice) {
        live = await this.getLiveState(tracks, live.index, live.offset);
        fadeSeconds = this.pickFadeSeconds(currentDuration, live.duration - live.offset);
        await this.transitionPlayToLive(current, currentDuration, live, fadeSeconds);
        live = await this.advanceLiveState(tracks, live, fadeSeconds);
        this.currentPlayItem = null;
        this.currentTrackIndex = live.index;
        this.currentTrackOffset = live.offset;

        const nextVoice = this.queue.shift();
        this.clearVoiceReadyInterrupt();
        await this.streamVoiceSegment(tracks, nextVoice, this.resolveVoiceTiming(nextVoice, this.voicePreludeSecondsUntilReady(), 3));
        this.nextVoiceAllowedAt = Date.now() + nextVoice.delayAfterMs;
        this.updateStatus({
          mode: "music_between_voice",
          title: "Music bridge after voice",
          queueLength: this.queue.length,
          musicQueueLength: this.getPublicMusicQueueLength(),
          musicQueue: this.getPublicMusicQueue(),
          currentPlay: null,
        });
        this.scheduleVoiceReadyInterrupt();

        tracks = await this.readTracks();
        if (!tracks.length) break;
        live = await this.getLiveState(tracks);
        current = this.musicQueue.shift();
        if (!current) break;
        currentDuration = await this.probeDuration(current.musicPath);
        fadeSeconds = this.pickFadeSeconds(currentDuration, live.duration - live.offset);
        await this.transitionLiveToPlay(live, current, fadeSeconds);
        live = await this.advanceLiveState(tracks, live, fadeSeconds);
        playStart = fadeSeconds;
        continue;
      }

      const next = this.musicQueue.shift();
      if (!next) {
        live = await this.getLiveState(tracks, live.index, live.offset);
        fadeSeconds = this.pickFadeSeconds(currentDuration, live.duration - live.offset);
        await this.transitionPlayToLive(current, currentDuration, live, fadeSeconds);
        live = await this.advanceLiveState(tracks, live, fadeSeconds);
        this.currentTrackIndex = live.index;
        this.currentTrackOffset = live.offset;
        if (this.queue.length > 0) {
          this.voiceBridgeAfterMusicInterrupt = true;
        }
        const shouldPlayTrailingVoice = this.queue.length > 0 && this.clients.size > 0;
        if (shouldPlayTrailingVoice) {
          this.voiceBridgeAfterMusicInterrupt = false;
          this.currentPlayItem = null;
          const nextVoice = this.queue.shift();
          this.clearVoiceReadyInterrupt();
          await this.streamVoiceSegment(tracks, nextVoice, this.resolveVoiceTiming(nextVoice, this.voicePreludeSecondsUntilReady(), 3));
          this.nextVoiceAllowedAt = Date.now() + nextVoice.delayAfterMs;
          this.updateStatus({
            mode: "music_between_voice",
            title: "Music bridge after voice",
            queueLength: this.queue.length,
            musicQueueLength: this.getPublicMusicQueueLength(),
            musicQueue: this.getPublicMusicQueue(),
            currentPlay: null,
          });
          this.scheduleVoiceReadyInterrupt();
        }
        break;
      }

      const nextDuration = await this.probeDuration(next.musicPath);
      const nextFade = this.pickFadeSeconds(Math.min(currentDuration, nextDuration), Number.POSITIVE_INFINITY);
      this.currentPlayItem = next;
      this.updateStatus({
        mode: "music_transition",
        title: `${current.title} -> ${next.title}`,
        queueLength: this.queue.length,
        musicQueueLength: this.getPublicMusicQueueLength(),
        musicQueue: this.getPublicMusicQueue(),
        currentPlay: this.toPublicMusicItem(next),
      });
      await this.streamCrossfade(current.musicPath, Math.max(0, currentDuration - nextFade), next.musicPath, 0, nextFade, `${current.title} -> ${next.title}`);
      current = next;
      currentDuration = nextDuration;
      fadeSeconds = nextFade;
      playStart = nextFade;
    }

    this.currentPlayItem = null;
    this.activeMusicProcess = null;
    this.interruptMusicAfterCurrent = false;
    this.musicInterrupted = false;
    this.activeMusicItems = [];
    this.activeMusicIndex = -1;
    this.currentMusic = null;
  }

  async transitionLiveToPlay(live, item, fadeSeconds) {
    this.currentPlayItem = item;
    this.log("transition_live_to_play", {
      live: live.track.file,
      play: item.file,
      fadeSeconds,
    });
    this.updateStatus({
      mode: "music_transition",
      title: `Live -> ${item.title}`,
      queueLength: this.queue.length,
      musicQueueLength: this.getPublicMusicQueueLength(),
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.toPublicMusicItem(item),
    });
    await this.streamCrossfade(live.path, live.offset, item.musicPath, 0, fadeSeconds, `${live.track.title} -> ${item.title}`);
  }

  async transitionPlayToLive(item, itemDuration, live, fadeSeconds) {
    this.log("transition_play_to_live", {
      play: item.file,
      live: live.track.file,
      fadeSeconds,
    });
    this.updateStatus({
      mode: "music_transition",
      title: `${item.title} -> Live`,
      queueLength: this.queue.length,
      musicQueueLength: this.getPublicMusicQueueLength(),
      musicQueue: this.getPublicMusicQueue(),
      currentPlay: this.toPublicMusicItem(item),
    });
    await this.streamCrossfade(item.musicPath, Math.max(0, itemDuration - fadeSeconds), live.path, live.offset, fadeSeconds, `${item.title} -> ${live.track.title}`);
  }

  pickFadeSeconds(playDuration, liveRemaining) {
    const safePlay = Number.isFinite(playDuration) ? playDuration : 3;
    const safeLive = Number.isFinite(liveRemaining) ? liveRemaining : 3;
    return Math.max(1.2, Math.min(3, safePlay / 4, Math.max(1.2, safeLive)));
  }

  resolveVoiceTiming(item, fallbackPreludeSeconds, fallbackPostludeSeconds) {
    return {
      preludeSeconds: Number.isFinite(item.preludeSeconds) ? item.preludeSeconds : fallbackPreludeSeconds,
      postludeSeconds: Number.isFinite(item.postludeSeconds) ? item.postludeSeconds : fallbackPostludeSeconds,
    };
  }

  schedulePlayQueueStatus(items, durations, fadeSeconds, liveLeadSeconds = 0) {
    const timers = [];
    let startMs = liveLeadSeconds * 1000;
    items.forEach((item, index) => {
      const timer = setTimeout(() => {
        this.activeMusicIndex = index;
        this.currentPlayItem = item;
        this.updateStatus({
          mode: "music_insert",
          title: item.title,
          queueLength: this.queue.length,
          musicQueueLength: this.getPublicMusicQueueLength(),
          musicQueue: this.getPublicMusicQueue(),
          currentPlay: this.toPublicMusicItem(item),
        });
      }, startMs);
      timers.push(timer);
      const interruptAtMs = startMs + Math.max(0.5, durations[index] - fadeSeconds) * 1000;
      const endTimer = setTimeout(() => {
        if (!this.interruptMusicAfterCurrent || !this.activeMusicProcess || this.currentPlayItem?.id !== item.id) return;
        const remaining = this.activeMusicItems.slice(index + 1);
        if (remaining.length) {
          this.musicQueue = [...remaining, ...this.musicQueue];
        }
        this.activeMusicItems = this.activeMusicItems.slice(0, index + 1);
        this.musicInterrupted = true;
        this.voiceBridgeAfterMusicInterrupt = true;
        this.interruptMusicAfterCurrent = false;
        this.activeMusicProcess.kill("SIGTERM");
      }, interruptAtMs);
      timers.push(endTimer);
      startMs += Math.max(0, durations[index] - fadeSeconds) * 1000;
    });
    return () => timers.forEach((timer) => clearTimeout(timer));
  }

  async streamPlayQueue(options) {
    const fade = Math.max(0.5, options.fadeSeconds);
    const liveLead = Math.max(0, options.liveLeadSeconds || 0);
    const liveOutDuration = liveLead + fade;
    const filterParts = [
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${liveOutDuration.toFixed(3)},asetpts=PTS-STARTPTS[liveOut]`,
    ];
    const labels = ["liveOut"];
    options.items.forEach((item, index) => {
      const inputIndex = index + 1;
      const label = `play${index}`;
      filterParts.push(`[${inputIndex}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[${label}]`);
      labels.push(label);
    });
    const liveInInput = options.items.length + 1;
    filterParts.push(`[${liveInInput}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${fade.toFixed(3)},asetpts=PTS-STARTPTS[liveIn]`);
    labels.push("liveIn");

    let previous = labels[0];
    for (let index = 1; index < labels.length; index += 1) {
      const output = index === labels.length - 1 ? "mixed" : `xfade${index}`;
      filterParts.push(`[${previous}][${labels[index]}]acrossfade=d=${fade.toFixed(3)}:c1=tri:c2=tri[${output}]`);
      previous = output;
    }
    filterParts.push("[mixed]alimiter=limit=0.98[out]");

    const playInputs = [];
    for (const item of options.items) {
      playInputs.push("-re", "-i", item.musicPath);
    }

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-re",
      "-ss", Math.max(0, options.liveOutStart).toFixed(3),
      "-t", liveOutDuration.toFixed(3),
      "-i", options.liveOutPath,
      ...playInputs,
      "-re",
      "-ss", Math.max(0, options.liveInStart).toFixed(3),
      "-t", fade.toFixed(3),
      "-i", options.liveInPath,
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];

    const totalDuration = liveLead + options.durations.reduce((sum, duration) => sum + duration, 0) + fade * 2;
    return this.runFfmpeg(args, totalDuration * 1000 + 20_000, {
      onProcess: (process) => {
        this.activeMusicProcess = process;
      },
    });
  }

  async readTracks() {
    try {
      return await listTracks(this.config.liveMusicDir, { urlPrefix: "/music/live" });
    } catch {
      return [];
    }
  }

  async streamMusicSegment(tracks) {
    const track = tracks[this.currentTrackIndex];
    const musicPath = resolveInside(this.config.liveMusicDir, track.file);
    const segmentStartOffset = Math.max(0, this.currentTrackOffset);
    const trackDuration = await this.probeDuration(musicPath);
    if (segmentStartOffset >= trackDuration - 0.05) {
      this.currentTrackIndex = (this.currentTrackIndex + 1) % tracks.length;
      this.currentTrackOffset = 0;
      return;
    }
    const segmentDuration = Math.max(0.1, trackDuration - segmentStartOffset);
    const segmentStartedAt = Date.now();
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-re",
      "-ss", String(segmentStartOffset),
      "-t", segmentDuration.toFixed(3),
      "-i", musicPath,
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];

    this.updateStatus({ mode: "music", title: track.title, queueLength: this.queue.length });
    this.setCurrentMusic({
      kind: "live",
      file: track.file,
      title: track.title,
      durationSeconds: trackDuration,
      positionSeconds: segmentStartOffset,
    });
    this.activeLiveSegment = {
      trackIndex: this.currentTrackIndex,
      offset: segmentStartOffset,
      startedAt: segmentStartedAt,
    };
    const result = await this.runFfmpeg(args, segmentDuration * 1000 + 8000, {
      onProcess: (process) => {
        this.activeLiveProcess = process;
        this.scheduleVoiceReadyInterrupt();
      },
    });
    this.activeLiveProcess = null;
    this.activeLiveSegment = null;
    this.clearVoiceReadyInterrupt();

    if (this.liveInterruptedForMusic) {
      const elapsed = Math.max(0.1, Math.min(segmentDuration, (Date.now() - segmentStartedAt) / 1000));
      this.currentTrackOffset = segmentStartOffset + elapsed;
      this.liveInterruptedForMusic = false;
      return;
    }

    this.currentTrackOffset = segmentStartOffset + segmentDuration;
    if (!result.ok || result.bytes < 1024) {
      this.currentTrackIndex = (this.currentTrackIndex + 1) % tracks.length;
      this.currentTrackOffset = 0;
      return;
    }
    if (this.currentTrackOffset >= trackDuration - 0.05) {
      this.currentTrackIndex = (this.currentTrackIndex + 1) % tracks.length;
      this.currentTrackOffset = 0;
    }
  }

  async streamMusicInsert(tracks, item) {
    let savedIndex = this.currentTrackIndex % tracks.length;
    let savedOffset = Math.max(0, this.currentTrackOffset);
    let savedTrack = tracks[savedIndex];
    let savedPath = resolveInside(this.config.liveMusicDir, savedTrack.file);
    const insertDuration = await this.probeDuration(item.musicPath);
    let savedDuration = await this.probeDuration(savedPath);
    if (savedOffset >= savedDuration - 1) {
      savedIndex = (savedIndex + 1) % tracks.length;
      savedOffset = 0;
      savedTrack = tracks[savedIndex];
      savedPath = resolveInside(this.config.liveMusicDir, savedTrack.file);
      savedDuration = await this.probeDuration(savedPath);
    }
    const fadeSeconds = Math.max(1, Math.min(3, insertDuration / 3, Math.max(1, savedDuration - savedOffset)));
    let returnIndex = savedIndex;
    let returnTrack = savedTrack;
    let returnPath = savedPath;
    let returnOffset = savedOffset + fadeSeconds;
    if (returnOffset >= savedDuration - 0.5) {
      returnIndex = (savedIndex + 1) % tracks.length;
      returnTrack = tracks[returnIndex];
      returnPath = resolveInside(this.config.liveMusicDir, returnTrack.file);
      returnOffset = 0;
      savedDuration = await this.probeDuration(returnPath);
    }
    const middleStart = fadeSeconds;
    const middleDuration = Math.max(0, insertDuration - fadeSeconds * 2);

    this.updateStatus({
      mode: "music_transition",
      title: `Переход к треку: ${item.title}`,
      queueLength: this.queue.length,
      musicQueueLength: this.musicQueue.length,
    });
    await this.streamPlayInsert({
      liveOutPath: savedPath,
      liveOutStart: savedOffset,
      playPath: item.musicPath,
      liveInPath: returnPath,
      liveInStart: returnOffset,
      fadeSeconds,
      playDuration: insertDuration,
      title: item.title,
    });

    this.currentTrackIndex = returnIndex;
    this.currentTrackOffset = returnOffset + fadeSeconds;
    if (this.currentTrackOffset >= savedDuration - 0.05) {
      this.currentTrackIndex = (savedIndex + 1) % tracks.length;
      this.currentTrackOffset = 0;
    }
  }

  async streamPlayInsert(options) {
    const fade = Math.max(0.5, options.fadeSeconds);
    const duration = Math.max(fade * 2, options.playDuration);
    const middleDuration = Math.max(0, duration - fade * 2);
    const playEndStart = Math.max(0, duration - fade);

    const filter = [
      `[1:a]asplit=3[playStartSrc][playMiddleSrc][playEndSrc]`,
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${fade.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${fade.toFixed(3)}[liveOut]`,
      `[playStartSrc]aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=0:duration=${fade.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)}[playIn]`,
      `[liveOut][playIn]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[first]`,
      `[playMiddleSrc]aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=${fade.toFixed(3)}:duration=${middleDuration.toFixed(3)},asetpts=PTS-STARTPTS[middle]`,
      `[playEndSrc]aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=${playEndStart.toFixed(3)}:duration=${fade.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${fade.toFixed(3)}[playOut]`,
      `[2:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${fade.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)}[liveIn]`,
      `[playOut][liveIn]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[last]`,
      `[first][middle][last]concat=n=3:v=0:a=1,alimiter=limit=0.98[out]`,
    ].join(";");

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-re",
      "-ss", Math.max(0, options.liveOutStart).toFixed(3),
      "-t", fade.toFixed(3),
      "-i", options.liveOutPath,
      "-re",
      "-i", options.playPath,
      "-re",
      "-ss", Math.max(0, options.liveInStart).toFixed(3),
      "-t", fade.toFixed(3),
      "-i", options.liveInPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];

    this.updateStatus({
      mode: "music_insert",
      title: options.title,
      queueLength: this.queue.length,
      musicQueueLength: this.musicQueue.length,
    });
    const result = await this.runFfmpeg(args, duration * 1000 + 12_000);
    if (!result.ok || result.bytes < 8192) console.warn(`music insert failed: ${options.title}; ${result.stderr}`);
  }

  async streamSingleMusic(filePath, start, duration, title) {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-re",
      "-ss", Math.max(0, start).toFixed(3),
      "-t", Math.max(0.1, duration).toFixed(3),
      "-i", filePath,
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];
    const result = await this.runFfmpeg(args, duration * 1000 + 8000);
    if (!result.ok || result.bytes < 1024) console.warn(`music insert failed: ${title}; ${result.stderr}`);
  }

  async streamCrossfade(fromPath, fromStart, toPath, toStart, duration, title) {
    const seconds = Math.max(0.5, duration);
    const filter = [
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${seconds.toFixed(3)}[from]`,
      `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${seconds.toFixed(3)}[to]`,
      `[from][to]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.98[out]`,
    ].join(";");
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-re",
      "-ss", Math.max(0, fromStart).toFixed(3),
      "-t", seconds.toFixed(3),
      "-i", fromPath,
      "-re",
      "-ss", Math.max(0, toStart).toFixed(3),
      "-t", seconds.toFixed(3),
      "-i", toPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];
    const result = await this.runFfmpeg(args, seconds * 1000 + 8000);
    if (!result.ok || result.bytes < 1024) console.warn(`music crossfade failed: ${title}; ${result.stderr}`);
  }

  async streamVoiceSegment(tracks, item, options = {}) {
    const admin = await readAdminConfig(this.config);
    const voiceDuration = await this.probeDuration(item.voicePath);
    const preludeSeconds = Number.isFinite(item.preludeSeconds)
      ? Math.max(0, Number(item.preludeSeconds))
      : Math.max(0, Number(admin.audioMix?.preludeSeconds ?? options.preludeSeconds) || 0);
    const postludeSeconds = Number.isFinite(item.postludeSeconds)
      ? Math.max(0, Number(item.postludeSeconds))
      : Math.max(0, Number(admin.audioMix?.postludeSeconds ?? options.postludeSeconds) || 0);
    const duckFadeSeconds = Math.max(0.2, Number(admin.audioMix?.duckFadeSeconds ?? 1.6) || 1.6);
    const restoreFadeSeconds = Math.max(0.2, Number(admin.audioMix?.restoreFadeSeconds ?? 1.4) || 1.4);
    const duckStart = preludeSeconds;
    const voiceStart = duckStart + duckFadeSeconds;
    const voiceEnd = voiceStart + voiceDuration + 0.35;
    const totalDuration = Math.max(4, voiceEnd + restoreFadeSeconds + postludeSeconds + 0.9);
    const musicBedSegments = await this.buildMusicBedSegments(tracks, totalDuration);
    this.setCurrentMusicBed(musicBedSegments);
    const normalMusic = clampGain(admin.audioMix?.musicLevel ?? 0.72);
    const voiceLevel = clampGain(admin.audioMix?.voiceLevel ?? 1);
    const voiceGain = clampGain(voiceLevel * 2.4);
    const duckMusic = clamp(normalMusic * (admin.audioMix?.duckingRatio ?? 0.18));
    const volumeExpr = [
      `if(lt(t,${duckStart.toFixed(3)}),${normalMusic},`,
      `if(lt(t,${voiceStart.toFixed(3)}),${normalMusic}-(${normalMusic}-${duckMusic})*((t-${duckStart.toFixed(3)})/${duckFadeSeconds.toFixed(3)}),`,
      `if(lt(t,${voiceEnd.toFixed(3)}),${duckMusic},`,
      `if(lt(t,${(voiceEnd + restoreFadeSeconds).toFixed(3)}),${duckMusic}+(${normalMusic}-${duckMusic})*((t-${voiceEnd.toFixed(3)})/${restoreFadeSeconds.toFixed(3)}),${normalMusic}))))`,
    ].join("");

    const filter = [
      buildMusicBedFilter(musicBedSegments, volumeExpr),
      `[${musicBedSegments.length}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${Math.round(voiceStart * 1000)}|${Math.round(voiceStart * 1000)},volume=${voiceGain}[voice]`,
      `[music][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98[out]`,
    ].join(";");

    const musicInputs = [];
    for (const segment of musicBedSegments) {
      musicInputs.push(
        "-re",
        "-ss", segment.start.toFixed(3),
        "-t", segment.duration.toFixed(3),
        "-i", segment.path,
      );
    }

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      ...musicInputs,
      "-i", item.voicePath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-vn",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", this.audioBitrate,
      "-f", "mp3",
      "-write_xing", "0",
      "pipe:1",
    ];

    const voiceTitle = item.payload?.title || item.payload?.topic || "Voice";
    let onStartPromise = Promise.resolve();
    const timers = [];
    const setVoiceOnAir = () => {
      this.updateStatus({
        mode: "voice",
        title: voiceTitle,
        queueLength: this.queue.length,
        voiceStartsInMs: 0,
      });
      this.log("voice_audio_start", {
        title: voiceTitle,
        source: item.payload?.source || "unknown",
        durationSeconds: voiceDuration,
      });
      if (item.onStart) {
        onStartPromise = item.onStart(item.payload).catch((error) => console.warn(`voice onStart failed: ${error.message}`));
      }
      console.log(`Broadcast voice audio start: ${voiceTitle}`);
    };

    if (voiceStart > 0.05) {
      this.updateStatus({
        mode: "voice_prelude",
        title: `Live before voice: ${voiceTitle}`,
        queueLength: this.queue.length,
        voiceStartsInMs: Math.round(voiceStart * 1000),
      });
      this.log("voice_prelude_start", {
        title: voiceTitle,
        source: item.payload?.source || "unknown",
        preludeSeconds,
        voiceStartsInSeconds: voiceStart,
      });
      timers.push(setTimeout(() => {
        this.updateStatus({
          mode: "voice_ducking",
          title: `Ducking before voice: ${voiceTitle}`,
          queueLength: this.queue.length,
          voiceStartsInMs: Math.round(duckFadeSeconds * 1000),
        });
      }, Math.max(0, duckStart * 1000)));
      timers.push(setTimeout(setVoiceOnAir, Math.max(0, voiceStart * 1000)));
    } else {
      setVoiceOnAir();
    }

    console.log(`Broadcast voice segment start: ${voiceTitle}; prelude=${preludeSeconds}s; voiceStart=${voiceStart}s; voiceDuration=${voiceDuration}s`);
    const result = await this.runFfmpeg(args, totalDuration * 1000 + 12_000);
    timers.forEach((timer) => clearTimeout(timer));
    console.log(`Broadcast voice segment end: ${voiceTitle}; ok=${result.ok}; bytes=${result.bytes}`);
    if (result.ok && result.bytes > 8192) {
      await onStartPromise;
      this.log("voice_segment_end", {
        title: voiceTitle,
        ok: true,
        bytes: result.bytes,
      });
      if (item.onEnd) await item.onEnd(item.payload).catch((error) => console.warn(`voice onEnd failed: ${error.message}`));
    } else if (item.onError) {
      const error = new Error(result.stderr || "Voice broadcast did not produce enough audio");
      this.log("voice_segment_error", {
        title: voiceTitle,
        ok: false,
        bytes: result.bytes,
        error: error.message,
      });
      await item.onError(error, item.payload).catch((handlerError) => console.warn(`voice onError failed: ${handlerError.message}`));
    }
    this.advanceMusicCursorToSegmentsEnd(musicBedSegments);
  }

  async buildMusicBedSegments(tracks, seconds) {
    const segments = [];
    let remaining = seconds;
    let trackIndex = this.currentTrackIndex % tracks.length;
    let offset = Math.max(0, this.currentTrackOffset);
    let guard = 0;

    while (remaining > 0.05 && guard < tracks.length * 20) {
      const track = tracks[trackIndex];
      const trackPath = resolveInside(this.config.liveMusicDir, track.file);
      const trackDuration = await this.probeDuration(trackPath);

      if (offset >= trackDuration - 0.05) {
        trackIndex = (trackIndex + 1) % tracks.length;
        offset = 0;
        guard += 1;
        continue;
      }

      const duration = Math.min(remaining, trackDuration - offset);
      segments.push({
        trackIndex,
        path: trackPath,
        file: track.file,
        title: track.title,
        start: offset,
        duration,
        trackDuration,
      });

      remaining -= duration;
      trackIndex = (trackIndex + 1) % tracks.length;
      offset = 0;
      guard += 1;
    }

    if (!segments.length) {
      const track = tracks[this.currentTrackIndex % tracks.length];
      const trackPath = resolveInside(this.config.liveMusicDir, track.file);
      segments.push({
        trackIndex: this.currentTrackIndex % tracks.length,
        path: trackPath,
        file: track.file,
        title: track.title,
        start: 0,
        duration: seconds,
        trackDuration: seconds,
      });
    }

    return segments;
  }

  async getLiveState(tracks, index = this.currentTrackIndex, offset = this.currentTrackOffset) {
    let trackIndex = Math.max(0, index) % tracks.length;
    let trackOffset = Math.max(0, offset);
    let guard = 0;

    while (guard < tracks.length * 2) {
      const track = tracks[trackIndex];
      const filePath = resolveInside(this.config.liveMusicDir, track.file);
      const duration = await this.probeDuration(filePath);
      if (trackOffset < duration - 0.05) {
        return {
          index: trackIndex,
          offset: trackOffset,
          track,
          path: filePath,
          duration,
        };
      }
      trackIndex = (trackIndex + 1) % tracks.length;
      trackOffset = 0;
      guard += 1;
    }

    const track = tracks[trackIndex];
    const filePath = resolveInside(this.config.liveMusicDir, track.file);
    return {
      index: trackIndex,
      offset: 0,
      track,
      path: filePath,
      duration: await this.probeDuration(filePath),
    };
  }

  async advanceLiveState(tracks, state, seconds) {
    let trackIndex = state.index;
    let offset = state.offset + Math.max(0, seconds);

    for (let guard = 0; guard < tracks.length * 4; guard += 1) {
      const track = tracks[trackIndex % tracks.length];
      const filePath = resolveInside(this.config.liveMusicDir, track.file);
      const duration = await this.probeDuration(filePath);
      if (offset < duration - 0.05) {
        return {
          index: trackIndex % tracks.length,
          offset,
          track,
          path: filePath,
          duration,
        };
      }
      offset -= duration;
      trackIndex = (trackIndex + 1) % tracks.length;
    }

    return this.getLiveState(tracks, trackIndex, 0);
  }

  advanceMusicCursorToSegmentsEnd(segments) {
    const last = segments[segments.length - 1];
    if (!last) return;

    this.currentTrackIndex = last.trackIndex;
    this.currentTrackOffset = last.start + last.duration;

    if (this.currentTrackOffset >= last.trackDuration - 0.05) {
      this.currentTrackIndex += 1;
      this.currentTrackOffset = 0;
    }
  }

  runFfmpeg(args, timeoutMs, options = {}) {
    return new Promise((resolve) => {
      const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      if (typeof options.onProcess === "function") options.onProcess(ffmpeg);
      let bytes = 0;
      let stderr = "";
      const timer = setTimeout(() => ffmpeg.kill("SIGKILL"), timeoutMs);

      ffmpeg.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        this.write(chunk);
      });
      ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      ffmpeg.on("error", (error) => {
        clearTimeout(timer);
        console.error(`ffmpeg error: ${error.message}`);
        resolve({ ok: false, bytes, stderr: error.message });
      });
      ffmpeg.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && stderr.trim()) console.warn(`ffmpeg exited ${code}: ${stderr.trim()}`);
        resolve({ ok: code === 0, bytes, stderr });
      });
    });
  }

  write(chunk) {
    for (const client of this.clients) {
      try {
        client.write(chunk);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async probeDuration(filePath) {
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats?.isFile()) return 15;
    const cacheKey = `${filePath}:${stats.mtimeMs}:${stats.size}`;
    if (this.durationCache.has(cacheKey)) return this.durationCache.get(cacheKey);

    return new Promise((resolve) => {
      const probe = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timer = setTimeout(() => probe.kill("SIGKILL"), 5000);
      probe.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });
      probe.on("close", () => {
        clearTimeout(timer);
        const duration = Number.parseFloat(output);
        const value = Number.isFinite(duration) && duration > 0 ? duration : 15;
        this.durationCache.set(cacheKey, value);
        resolve(value);
      });
      probe.on("error", () => {
        clearTimeout(timer);
        resolve(15);
      });
    });
  }

  resolveAudioUrl(audioUrl) {
    if (!audioUrl) return null;
    let pathname = String(audioUrl);
    try {
      pathname = /^https?:\/\//i.test(pathname) ? new URL(pathname).pathname : pathname.split(/[?#]/)[0];
      pathname = decodeURIComponent(pathname);
    } catch {
      return null;
    }

    try {
      if (pathname.startsWith("/archive/")) {
        const filePath = resolveInside(this.config.archiveDir, pathname.slice("/archive/".length));
        return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? filePath : null;
      }
      if (pathname.startsWith("/cache/announcements/")) {
        const filePath = resolveInside(this.config.cacheDir, pathname.slice("/cache/announcements/".length));
        return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? filePath : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  updateStatus(patch) {
    this.lastStatus = {
      ...this.lastStatus,
      ...patch,
      queueLength: Number.isFinite(patch.queueLength) ? patch.queueLength : this.queue.length,
      musicQueueLength: Number.isFinite(patch.musicQueueLength) ? patch.musicQueueLength : this.getPublicMusicQueueLength(),
      musicQueue: Array.isArray(patch.musicQueue) ? patch.musicQueue : this.getPublicMusicQueue(),
      currentPlay: Object.prototype.hasOwnProperty.call(patch, "currentPlay")
        ? patch.currentPlay
        : this.currentPlayItem ? this.toPublicMusicItem(this.currentPlayItem) : null,
      updatedAt: new Date().toISOString(),
    };
  }

  log(event, data = {}) {
    writeSystemLog(this.config, event, data).catch(() => {});
  }

  getPublicMusicQueue() {
    const activeTail = this.activeMusicItems.slice(Math.max(0, this.activeMusicIndex + 1));
    return [...activeTail, ...this.musicQueue].map((item) => this.toPublicMusicItem(item));
  }

  getPublicMusicQueueLength() {
    return this.getPublicMusicQueue().length;
  }

  toPublicMusicItem(item) {
    return {
      id: item.id,
      file: item.file,
      title: item.title,
      createdAt: item.createdAt,
    };
  }

  setCurrentMusic(item) {
    if (!item) {
      this.currentMusic = null;
      return;
    }
    this.currentMusic = {
      kind: item.kind || "music",
      file: item.file || "",
      title: item.title || "Music",
      durationSeconds: Number.isFinite(item.durationSeconds) ? Math.max(0, item.durationSeconds) : 0,
      positionSeconds: Number.isFinite(item.positionSeconds) ? Math.max(0, item.positionSeconds) : 0,
      startedAt: Date.now(),
    };
  }

  setCurrentMusicBed(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      this.currentMusic = null;
      return;
    }

    this.currentMusic = {
      kind: "live-bed",
      segments: segments.map((segment) => ({
        file: segment.file || "",
        title: segment.title || "Live music",
        durationSeconds: Number.isFinite(segment.trackDuration) ? Math.max(0, segment.trackDuration) : 0,
        positionSeconds: Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0,
        segmentDuration: Number.isFinite(segment.duration) ? Math.max(0, segment.duration) : 0,
      })),
      startedAt: Date.now(),
    };
  }

  getPublicCurrentMusic() {
    if (!this.currentMusic) return null;
    const elapsed = Math.max(0, (Date.now() - this.currentMusic.startedAt) / 1000);
    if (Array.isArray(this.currentMusic.segments) && this.currentMusic.segments.length) {
      let segmentElapsed = elapsed;
      let activeSegment = this.currentMusic.segments[this.currentMusic.segments.length - 1];

      for (const segment of this.currentMusic.segments) {
        if (segmentElapsed <= segment.segmentDuration) {
          activeSegment = segment;
          break;
        }
        segmentElapsed -= segment.segmentDuration;
      }

      const duration = activeSegment.durationSeconds;
      const position = duration > 0
        ? Math.min(duration, activeSegment.positionSeconds + segmentElapsed)
        : activeSegment.positionSeconds + segmentElapsed;
      return {
        kind: this.currentMusic.kind,
        file: activeSegment.file,
        title: activeSegment.title,
        durationSeconds: duration,
        positionSeconds: position,
        remainingSeconds: duration > 0 ? Math.max(0, duration - position) : 0,
        progress: duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0,
      };
    }

    const duration = this.currentMusic.durationSeconds;
    const position = duration > 0
      ? Math.min(duration, this.currentMusic.positionSeconds + elapsed)
      : this.currentMusic.positionSeconds + elapsed;
    return {
      kind: this.currentMusic.kind,
      file: this.currentMusic.file,
      title: this.currentMusic.title,
      durationSeconds: duration,
      positionSeconds: position,
      remainingSeconds: duration > 0 ? Math.max(0, duration - position) : 0,
      progress: duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0,
    };
  }

  resolveMusicFile(file) {
    if (!file) return null;
    try {
      const filePath = resolveInside(this.config.playMusicDir, String(file));
      return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? filePath : null;
    } catch {
      return null;
    }
  }

  isMusicFileBusy(file) {
    const activeTail = this.activeMusicItems.slice(Math.max(0, this.activeMusicIndex + 1));
    return this.currentPlayItem?.file === file
      || activeTail.some((item) => item.file === file)
      || this.musicQueue.some((item) => item.file === file);
  }
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 1);
}

function clampGain(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 3);
}

function buildMusicBedFilter(segments, volumeExpr) {
  const prepared = segments.map((segment, index) => {
    return `[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=duration=${segment.duration.toFixed(3)},asetpts=PTS-STARTPTS[m${index}]`;
  });

  if (segments.length === 1) {
    return `${prepared[0]};[m0]volume='${volumeExpr}':eval=frame[music]`;
  }

  const labels = segments.map((_, index) => `[m${index}]`).join("");
  return `${prepared.join(";")};${labels}concat=n=${segments.length}:v=0:a=1[musicRaw];[musicRaw]volume='${volumeExpr}':eval=frame[music]`;
}

function streamHeaders() {
  return {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
    "Access-Control-Allow-Origin": "*",
  };
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { BroadcastStream };
