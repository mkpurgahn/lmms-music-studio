// Studio Timeline client: WebAudio sample-accurate stem/mix clock, 512 MiB decoded buffer budget
// with on-demand lazy decode and LRU eviction, Unified Feedback v2, and Desktop LMMS launch bridge.
(function () {
  var MAX_DECODED_BYTES = 512 * 1024 * 1024;
  var $ = function (id) { return document.getElementById(id); };
  var appEl = $('studio-app');
  var dataEl = $('data');
  var rawJson = (appEl && appEl.dataset && appEl.dataset.studioConfig) || (dataEl && dataEl.textContent) || '{}';
  var D = JSON.parse(rawJson);

  var bodyDataset = (document.body && document.body.dataset) ? document.body.dataset : {};
  var studioToken = bodyDataset.studioToken || '';
  var studioSession = bodyDataset.studioSession || D.session || '';
  var isStudioHttp = Boolean(studioToken);

  var meter = Array.isArray(D.timeSignature) && D.timeSignature.length === 2 ? D.timeSignature : [4, 4];
  var barSeconds = 240 * meter[0] / (meter[1] * D.bpm);
  var total = Math.max(0.05, Number(D.seconds) || 1);
  var sampleRateHint = Number(D.sampleRate) || 48000;
  var budgetCap = Number(D.maxDecodedBytes) > 0 ? Number(D.maxDecodedBytes) : MAX_DECODED_BYTES;

  var board = $('board');
  var state = {
    mode: (D.lanes && D.lanes.length) ? 'stems' : 'mix',
    loop: null,
    notes: [],
    ratings: {},
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pct(sec) {
    return (sec / total * 100) + '%';
  }

  function resolveAssetUrl(rawUrl) {
    if (!rawUrl) return '';
    if (isStudioHttp) {
      if (rawUrl.charAt(0) === '/') return rawUrl;
      return '/' + rawUrl.replace(/^\/+/, '');
    }
    return rawUrl;
  }

  function barBeatAt(seconds) {
    var num = meter[0] || 4;
    var pos = Math.max(0, seconds) / barSeconds;
    var whole = Math.floor(pos + 1e-9);
    var beat = Math.min(num, Math.floor((pos - whole) * num + 1e-9) + 1);
    return { bar: whole, displayBar: whole + 1, beat: beat, position: pos };
  }

  function sectionAtBar(barPos) {
    var list = D.sections || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (barPos + 1e-9 >= s.startBar && barPos < s.startBar + s.bars - 1e-9) return s.name;
    }
    return null;
  }

  function estimateBytes(lane) {
    if (typeof lane.decodedBytes === 'number' && lane.decodedBytes > 0) return lane.decodedBytes;
    var frames = typeof lane.frames === 'number' && lane.frames > 0 ? lane.frames : Math.ceil(total * sampleRateHint);
    var ch = typeof lane.channels === 'number' && lane.channels > 0 ? lane.channels : 2;
    return frames * ch * 4;
  }

  function planInitialBudget(items, maxBytes) {
    var ordered = items.slice().sort(function (a, b) {
      var pa = a.isMix ? 0 : (a.solo ? 1 : (!a.mute ? 2 : 3));
      var pb = b.isMix ? 0 : (b.solo ? 1 : (!b.mute ? 2 : 3));
      return pa - pb || a.index - b.index;
    });
    var used = 0;
    var eager = {};
    for (var i = 0; i < ordered.length; i++) {
      var item = ordered[i];
      var bytes = estimateBytes(item.lane);
      if (used + bytes <= maxBytes) {
        eager[item.id] = true;
        used += bytes;
      } else {
        eager[item.id] = false;
      }
    }
    return { eager: eager, plannedBytes: used };
  }

  function planEviction(items, target, neededBytes, maxBytes) {
    var current = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].loaded) current += items[i].decodedBytes;
    }
    if (current + neededBytes <= maxBytes) {
      return { canLoad: true, evict: [] };
    }
    var neededToFree = (current + neededBytes) - maxBytes;
    var anySolo = items.some(function (p) { return !p.isMix && p.solo; });
    var candidates = items.filter(function (p) {
      return p.loaded && p.id !== target.id;
    }).sort(function (a, b) {
      var aAudible = a.isMix ? state.mode === 'mix' : (state.mode === 'stems' && !a.mute && (!anySolo || a.solo));
      var bAudible = b.isMix ? state.mode === 'mix' : (state.mode === 'stems' && !b.mute && (!anySolo || b.solo));
      if (aAudible !== bAudible) return aAudible ? 1 : -1;
      if (a.isMix !== b.isMix) return a.isMix ? 1 : -1;
      return a.lastUsedAt - b.lastUsedAt;
    });
    var evict = [];
    var freed = 0;
    for (var j = 0; j < candidates.length && freed < neededToFree; j++) {
      evict.push(candidates[j]);
      freed += candidates[j].decodedBytes;
    }
    if (current - freed + neededBytes > maxBytes) {
      return { canLoad: false, evict: [] };
    }
    return { canLoad: true, evict: evict };
  }

  function addRow(label, cls) {
    var side = el('div', 'side');
    side.appendChild(el('span', 'label', label));
    var track = el('div', 'track ' + cls);
    board.appendChild(side);
    board.appendChild(track);
    return track;
  }

  var ruler = addRow('Bars', 'ruler');
  var totalBars = Math.max(1, Number(D.bars) || 1);
  var step = totalBars > 64 ? 8 : totalBars > 24 ? 4 : totalBars > 12 ? 2 : 1;
  for (var b = 0; b < totalBars; b += step) {
    var mark = el('i');
    mark.style.left = pct(b * barSeconds);
    ruler.appendChild(mark);
    var numLabel = el('span', '', String(b + 1));
    numLabel.style.left = pct(b * barSeconds);
    ruler.appendChild(numLabel);
  }

  var loopSelect = $('loop');
  if (D.sections && D.sections.length) {
    var secRow = addRow('Sections', 'blocks sec');
    D.sections.forEach(function (s, idx) {
      var block = el('div', '', s.name);
      block.style.left = pct(s.startBar * barSeconds);
      block.style.width = pct(s.bars * barSeconds);
      block.title = s.name + ': Bars ' + (s.startBar + 1) + ' to ' + (s.startBar + s.bars) + '. Click to jump, double-click to loop.';
      block.addEventListener('click', function (ev) {
        ev.stopPropagation();
        seek(s.startBar * barSeconds);
      });
      block.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        if (loopSelect) {
          loopSelect.value = String(idx);
          applyLoopSelection();
        }
      });
      secRow.appendChild(block);
      if (loopSelect) {
        var opt = el('option', '', s.name + ' (Bar ' + (s.startBar + 1) + ')');
        opt.value = String(idx);
        loopSelect.appendChild(opt);
      }
    });
  }

  if (D.effects && D.effects.length) {
    var fxRow = addRow('DJ effects', 'blocks fx');
    D.effects.forEach(function (fx) {
      var block = el('div', '', String(fx.type || '').replace(/_/g, ' '));
      block.style.left = pct(fx.startBar * barSeconds);
      block.style.width = 'max(' + pct(fx.bars * barSeconds) + ',10px)';
      block.title = fx.type + ' at Bar ' + (fx.startBar + 1) + ' for ' + fx.bars + ' bars' + (fx.detail ? ': ' + fx.detail : '');
      fxRow.appendChild(block);
    });
  }

  function wave(peaks, color) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    var pts = Array.isArray(peaks) && peaks.length ? peaks : [0, 0];
    svg.setAttribute('viewBox', '0 0 ' + pts.length + ' 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    var top = '';
    var bottom = '';
    for (var i = 0; i < pts.length; i++) {
      var h = Math.max(pts[i], 0.6) / 2;
      top += (i ? 'L' : 'M') + i + ' ' + (50 - h) + ' ';
      bottom = 'L' + i + ' ' + (50 + h) + ' ' + bottom;
    }
    var pathNode = document.createElementNS(NS, 'path');
    pathNode.setAttribute('d', top + bottom + 'Z');
    pathNode.setAttribute('fill', color);
    svg.appendChild(pathNode);
    return svg;
  }

  var players = [];
  var useCounter = 0;

  function addLane(lane, isMix) {
    var side = el('div', 'side');
    var colorVar = 'var(--' + (isMix ? 'accent' : (lane.family || 'harmony')) + ')';
    side.style.setProperty('--c', colorVar);
    var nameSpan = el('span', 'name', lane.name);
    side.appendChild(nameSpan);
    var lazyBadge = el('span', 'lazy-tag hidden', 'lazy');
    side.appendChild(lazyBadge);
    side.title = lane.name;

    var track = el('div', 'track');
    track.appendChild(wave(lane.peaks, colorVar));

    var p = {
      id: (isMix ? 'mix:' : 'stem:') + players.length + ':' + lane.name,
      index: players.length,
      lane: lane,
      url: resolveAssetUrl(lane.url),
      isMix: isMix,
      mute: false,
      solo: false,
      volume: 1,
      buffer: null,
      loaded: false,
      loadingPromise: null,
      decodedBytes: estimateBytes(lane),
      lastUsedAt: ++useCounter,
      gainNode: null,
      sourceNode: null,
      track: track,
      lazyBadge: lazyBadge,
      buttons: null,
    };

    if (!isMix) {
      var mBtn = el('button', 'm', 'M');
      mBtn.type = 'button';
      mBtn.title = 'Mute';
      mBtn.addEventListener('click', function () {
        p.mute = !p.mute;
        mBtn.classList.toggle('on', p.mute);
        p.lastUsedAt = ++useCounter;
        if (!p.mute && !p.loaded) {
          void ensureDecodedAndJoin(p);
        }
        applyLevels(false);
      });

      var sBtn = el('button', 's', 'S');
      sBtn.type = 'button';
      sBtn.title = 'Solo';
      sBtn.addEventListener('click', function () {
        p.solo = !p.solo;
        sBtn.classList.toggle('on', p.solo);
        p.lastUsedAt = ++useCounter;
        if (p.solo && state.mode !== 'stems' && D.lanes && D.lanes.length) {
          state.mode = 'stems';
        }
        if (p.solo && !p.loaded) {
          void ensureDecodedAndJoin(p);
        }
        applyLevels(false);
      });

      var volInput = el('input');
      volInput.type = 'range';
      volInput.min = '0';
      volInput.max = '100';
      volInput.value = '100';
      volInput.title = 'Volume';
      volInput.addEventListener('input', function () {
        p.volume = Number(volInput.value) / 100;
        p.lastUsedAt = ++useCounter;
        applyLevels(false);
      });

      side.appendChild(mBtn);
      side.appendChild(sBtn);
      side.appendChild(volInput);
      p.buttons = [mBtn, sBtn];
    }

    board.appendChild(side);
    board.appendChild(track);
    players.push(p);
  }

  if (D.mix) addLane(D.mix, true);
  (D.lanes || []).forEach(function (l) { addLane(l, false); });

  // ---------- WebAudio Engine & 512 MiB Budget ----------
  var ctx = null;
  var masterGain = null;
  var mixGain = null;
  var stemsBusGain = null;
  var playing = false;
  var startCtxTime = 0;
  var startSongSec = 0;
  var pausedAtSec = 0;
  var pickedBuffers = null;

  function setStatus(msg, isError) {
    var st = $('status');
    if (!st) return;
    st.textContent = msg;
    st.className = isError ? 'hint err' : 'hint';
  }

  function totalDecodedBytes() {
    var sum = 0;
    for (var i = 0; i < players.length; i++) {
      if (players[i].loaded && players[i].buffer) sum += players[i].decodedBytes;
    }
    return sum;
  }

  function updateBudgetTelemetry() {
    var decoded = totalDecodedBytes();
    var loadedCount = 0;
    var lazyCount = 0;
    for (var i = 0; i < players.length; i++) {
      if (players[i].loaded) {
        loadedCount++;
        players[i].lazyBadge.classList.add('hidden');
      } else {
        lazyCount++;
        players[i].lazyBadge.classList.remove('hidden');
      }
    }
    var targets = [board, document.body].filter(Boolean);
    targets.forEach(function (t) {
      if (!t.dataset) return;
      t.dataset.maxDecodedBytes = String(budgetCap);
      t.dataset.decodedBytes = String(decoded);
      t.dataset.loadedLanes = String(loadedCount);
      t.dataset.lazyLanes = String(lazyCount);
    });
  }

  function ensureAudioGraph() {
    if (ctx) return ctx;
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      ctx = new AudioCtx({ sampleRate: sampleRateHint });
    } catch (e) {
      ctx = new AudioCtx();
    }
    masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
    mixGain = ctx.createGain();
    mixGain.connect(masterGain);
    stemsBusGain = ctx.createGain();
    stemsBusGain.connect(masterGain);
    players.forEach(function (p) {
      p.gainNode = ctx.createGain();
      p.gainNode.connect(p.isMix ? mixGain : stemsBusGain);
    });
    applyLevels(true);
    return ctx;
  }

  function setSmoothGain(gainNode, val, immediate) {
    if (!gainNode || !ctx) return;
    if (immediate || !playing) {
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.value = val;
    } else {
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setTargetAtTime(val, ctx.currentTime, 0.012);
    }
  }

  function modeBannerText() {
    return state.mode === 'mix'
      ? 'Master Mix (authoritative post-master output)'
      : 'Stems (isolated pre-master tracks)';
  }

  function applyLevels(immediate) {
    var anySolo = players.some(function (p) { return !p.isMix && p.solo; });
    players.forEach(function (p) {
      var audible = p.isMix
        ? state.mode === 'mix'
        : state.mode === 'stems' && !p.mute && (!anySolo || p.solo);
      p.track.classList.toggle('dim', !audible);
      if (p.gainNode) {
        setSmoothGain(p.gainNode, audible ? p.volume : 0, immediate);
      }
    });
    if (mixGain && stemsBusGain) {
      setSmoothGain(mixGain, state.mode === 'mix' ? 1 : 0, immediate);
      setSmoothGain(stemsBusGain, state.mode === 'stems' ? 1 : 0, immediate);
    }
    var modeBtn = $('mode');
    if (modeBtn) {
      modeBtn.textContent = state.mode === 'mix' ? 'Switch to Stems' : 'Switch to Master Mix';
      modeBtn.classList.toggle('on', state.mode === 'mix');
    }
    var banner = $('mode-banner');
    if (banner) {
      banner.textContent = modeBannerText();
      banner.className = 'mode-badge' + (state.mode === 'mix' ? ' mix' : '');
    }
  }

  async function readRawArrayBuffer(p) {
    if (pickedBuffers && pickedBuffers[p.lane.url]) {
      return pickedBuffers[p.lane.url].slice(0);
    }
    var res = await fetch(p.url);
    if (!res.ok) throw new Error(p.lane.name + ': HTTP ' + res.status);
    return res.arrayBuffer();
  }

  function evictPlayer(p) {
    if (p.sourceNode) {
      try { p.sourceNode.stop(); } catch (e) { /* ignore */ }
      p.sourceNode.disconnect();
      p.sourceNode = null;
    }
    p.buffer = null;
    p.loaded = false;
  }

  async function decodePlayer(p) {
    if (p.loaded && p.buffer) return p.buffer;
    if (p.loadingPromise) return p.loadingPromise;
    var activeCtx = ensureAudioGraph();
    if (!activeCtx) throw new Error('WebAudio AudioContext is unavailable');

    var estBytes = estimateBytes(p.lane);
    var eviction = planEviction(players, p, estBytes, budgetCap);
    if (!eviction.canLoad) {
      throw new Error('Track "' + p.lane.name + '" exceeds the 512 MiB decoded audio budget');
    }
    eviction.evict.forEach(evictPlayer);
    updateBudgetTelemetry();

    p.loadingPromise = (async function () {
      try {
        var raw = await readRawArrayBuffer(p);
        var audioBuf = await activeCtx.decodeAudioData(raw);
        var actualBytes = audioBuf.length * audioBuf.numberOfChannels * 4;
        var postCheck = planEviction(players, p, actualBytes, budgetCap);
        if (!postCheck.canLoad) {
          throw new Error('Decoded track "' + p.lane.name + '" exceeds 512 MiB budget');
        }
        postCheck.evict.forEach(evictPlayer);
        p.buffer = audioBuf;
        p.decodedBytes = actualBytes;
        p.loaded = true;
        p.lastUsedAt = ++useCounter;
        updateBudgetTelemetry();
        return audioBuf;
      } finally {
        p.loadingPromise = null;
      }
    })();
    return p.loadingPromise;
  }

  async function loadInitialBuffers() {
    if (!players.length || (typeof location !== 'undefined' && location.protocol === 'file:')) {
      updateBudgetTelemetry();
      return;
    }
    ensureAudioGraph();
    if (!ctx) return;
    var plan = planInitialBudget(players, budgetCap);
    var errors = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!plan.eager[p.id]) {
        p.loaded = false;
        continue;
      }
      try {
        await decodePlayer(p);
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }
    updateBudgetTelemetry();
    if (board && board.dataset) board.dataset.ready = errors.length ? 'partial' : 'yes';
    if (document.body && document.body.dataset) document.body.dataset.ready = errors.length ? 'partial' : 'yes';
    if (errors.length) {
      setStatus('Audio load issue: ' + errors[0], true);
    } else {
      var lazyCount = players.filter(function (p) { return !p.loaded; }).length;
      setStatus(
        D.lanes.length + ' lanes | ' + totalBars + ' bars at ' + D.bpm + ' bpm (' + meter[0] + '/' + meter[1] + ')' +
        (lazyCount ? ' | ' + lazyCount + ' stems kept lazy under 512 MiB budget' : '') +
        '. Space: Play/Pause, N: Pin note.',
        false
      );
    }
    if (typeof location !== 'undefined' && location.hash === '#selftest') {
      runSelfTest().then(function (res) {
        var json = JSON.stringify(res);
        if (board && board.dataset) board.dataset.selftest = json;
        if (document.body && document.body.dataset) document.body.dataset.selftest = json;
      });
    }
  }

  async function runSelfTest() {
    var OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var rate = ctx ? ctx.sampleRate : sampleRateHint;
    var loadedStems = players.filter(function (p) { return !p.isMix && p.loaded && p.buffer; });
    var maxStemDriftSamples = 0;
    if (OfflineCtx && loadedStems.length > 0) {
      var frames = Math.min(Math.round(rate * 0.25), loadedStems[0].buffer.length);
      if (frames > 0) {
        var off = new OfflineCtx(2, frames, rate);
        loadedStems.forEach(function (p) {
          var src = off.createBufferSource();
          src.buffer = p.buffer;
          src.connect(off.destination);
          src.start(0, 0);
        });
        var rendered = await off.startRendering();
        var ch0 = rendered.getChannelData(0);
        for (var i = 0; i < ch0.length; i++) {
          var expected = 0;
          for (var s = 0; s < loadedStems.length; s++) {
            expected += loadedStems[s].buffer.getChannelData(0)[i] || 0;
          }
          if (Math.abs(ch0[i] - expected) > 1e-4) {
            maxStemDriftSamples++;
          }
        }
      }
    }
    return {
      ok: maxStemDriftSamples === 0,
      sampleRate: rate,
      decodedBytes: totalDecodedBytes(),
      maxDecodedBytes: budgetCap,
      loadedLanes: players.filter(function (p) { return p.loaded; }).length,
      lazyLanes: players.filter(function (p) { return !p.loaded; }).length,
      maxStemDriftSamples: maxStemDriftSamples,
    };
  }

  function stopSources() {
    players.forEach(function (p) {
      if (p.sourceNode) {
        try { p.sourceNode.stop(); } catch (e) { /* already stopped */ }
        p.sourceNode.disconnect();
        p.sourceNode = null;
      }
    });
  }

  function loopBounds() {
    if (!state.loop) return null;
    var start = state.loop.startBar * barSeconds;
    var end = Math.min(total, (state.loop.startBar + state.loop.bars) * barSeconds);
    return end > start ? { start: start, end: end } : null;
  }

  function songClockAt(ctxNow) {
    if (!ctx || !playing) return pausedAtSec;
    var elapsed = Math.max(0, ctxNow - startCtxTime);
    var bounds = loopBounds();
    if (bounds) {
      var span = bounds.end - bounds.start;
      var rel = (startSongSec - bounds.start) + elapsed;
      return bounds.start + ((rel % span) + span) % span;
    }
    return Math.min(total, startSongSec + elapsed);
  }

  function clock() {
    return ctx ? songClockAt(ctx.currentTime) : pausedAtSec;
  }

  function schedulePlayerSource(p, whenCtx, offsetSec) {
    if (!p.loaded || !p.buffer || !ctx) return;
    var rate = ctx.sampleRate;
    var src = ctx.createBufferSource();
    src.buffer = p.buffer;
    var bounds = loopBounds();
    if (bounds && bounds.end <= p.buffer.duration + 1e-3) {
      src.loop = true;
      src.loopStart = Math.round(bounds.start * rate) / rate;
      src.loopEnd = Math.min(p.buffer.duration, Math.round(bounds.end * rate) / rate);
    }
    src.connect(p.gainNode);
    var clampedOffset = Math.max(0, Math.min(Math.max(0, p.buffer.duration - 1 / rate), Math.round(offsetSec * rate) / rate));
    src.start(whenCtx, clampedOffset);
    p.sourceNode = src;
  }

  async function ensureDecodedAndJoin(p) {
    try {
      await decodePlayer(p);
      if (playing && ctx) {
        var rate = ctx.sampleRate;
        var joinWhen = Math.ceil((ctx.currentTime + 0.04) * rate) / rate;
        var joinSongSec = songClockAt(joinWhen);
        if (p.sourceNode) {
          try { p.sourceNode.stop(); } catch (e) { /* ignore */ }
          p.sourceNode.disconnect();
        }
        schedulePlayerSource(p, joinWhen, joinSongSec);
      }
      applyLevels(false);
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  }

  async function playFrom(fromSec) {
    var activeCtx = ensureAudioGraph();
    if (!activeCtx) {
      setStatus('WebAudio is unavailable in this environment.', true);
      return;
    }
    if (activeCtx.state === 'suspended') {
      await activeCtx.resume();
    }
    if (!players.some(function (p) { return p.loaded; })) {
      await loadInitialBuffers();
    }
    stopSources();

    var bounds = loopBounds();
    var targetSec = fromSec === undefined ? pausedAtSec : fromSec;
    if (bounds && (targetSec < bounds.start || targetSec >= bounds.end)) {
      targetSec = bounds.start;
    }
    targetSec = Math.max(0, Math.min(Math.max(0, total - 0.01), targetSec));

    var rate = activeCtx.sampleRate;
    var when = Math.ceil((activeCtx.currentTime + 0.04) * rate) / rate;
    var alignedSongSec = Math.round(targetSec * rate) / rate;

    players.forEach(function (p) {
      if (p.loaded && p.buffer) {
        schedulePlayerSource(p, when, alignedSongSec);
      }
    });

    startCtxTime = when;
    startSongSec = alignedSongSec;
    pausedAtSec = alignedSongSec;
    playing = true;
    applyLevels(true);
    var playBtn = $('play');
    if (playBtn) playBtn.textContent = 'Pause';
  }

  function pause() {
    pausedAtSec = clock();
    playing = false;
    stopSources();
    var playBtn = $('play');
    if (playBtn) playBtn.textContent = 'Play';
  }

  function seek(sec) {
    var clamped = Math.max(0, Math.min(Math.max(0, total - 0.01), sec));
    pausedAtSec = clamped;
    if (playing) {
      void playFrom(clamped);
    } else {
      paint();
    }
  }

  function paint() {
    var t = clock();
    var head = $('head');
    var firstTrack = board ? board.querySelector('.track') : null;
    if (head && firstTrack && head.parentNode) {
      var box = firstTrack.getBoundingClientRect();
      var wrap = head.parentNode.getBoundingClientRect();
      head.style.left = (box.left - wrap.left + box.width * Math.min(1, t / total)) + 'px';
    }
    var pos = barBeatAt(t);
    var tenths = Math.floor(t * 10) % 10;
    var sec = Math.floor(t) % 60;
    var min = Math.floor(t / 60);
    var clockEl = $('clock');
    if (clockEl) {
      clockEl.textContent = 'Bar ' + pos.displayBar + ' | Beat ' + pos.beat + ' | ' + min + ':' + (sec < 10 ? '0' : '') + sec + '.' + tenths;
    }
  }

  function frame() {
    if (playing && !state.loop && clock() >= total - 0.005) {
      pause();
      pausedAtSec = 0;
    }
    paint();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(frame);
    }
  }

  if (board) {
    board.addEventListener('click', function (ev) {
      var track = ev.target && ev.target.closest ? ev.target.closest('.track') : null;
      if (!track) return;
      var rect = track.getBoundingClientRect();
      if (rect.width > 0) {
        seek((ev.clientX - rect.left) / rect.width * total);
      }
    });
  }

  var playBtn = $('play');
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      if (playing) pause();
      else void playFrom(pausedAtSec);
    });
  }

  var startBtn = $('start');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      seek(0);
    });
  }

  var modeBtn = $('mode');
  if (modeBtn) {
    modeBtn.addEventListener('click', function () {
      if (!D.mix || !D.lanes || !D.lanes.length) return;
      state.mode = state.mode === 'mix' ? 'stems' : 'mix';
      if (state.mode === 'mix') {
        var mixPlayer = players.find(function (p) { return p.isMix; });
        if (mixPlayer && !mixPlayer.loaded) void ensureDecodedAndJoin(mixPlayer);
      }
      applyLevels(false);
    });
  }

  function applyLoopSelection() {
    if (!loopSelect) return;
    state.loop = loopSelect.value === '' ? null : D.sections[Number(loopSelect.value)];
    var blocks = document.querySelectorAll('.blocks.sec div');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].classList.toggle('on', String(i) === loopSelect.value);
    }
    if (state.loop) {
      seek(state.loop.startBar * barSeconds);
    } else if (playing) {
      void playFrom(clock());
    }
  }

  if (loopSelect) {
    loopSelect.addEventListener('change', applyLoopSelection);
  }

  var unsoloBtn = $('unsolo');
  if (unsoloBtn) {
    unsoloBtn.addEventListener('click', function () {
      players.forEach(function (p) {
        p.mute = false;
        p.solo = false;
        if (p.buttons) {
          p.buttons.forEach(function (b) { b.classList.remove('on'); });
        }
      });
      applyLevels(false);
    });
  }

  // ---------- Unified Feedback v2 ----------
  var storeKey = 'lmms-timeline-notes-v2:' + (D.session || D.title || 'timeline');
  function storeNotes() {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ notes: state.notes, ratings: state.ratings }));
    } catch (e) { /* storage unavailable */ }
  }

  function normaliseStoredNote(n) {
    var sec = typeof n.seconds === 'number' && isFinite(n.seconds) ? Number(n.seconds.toFixed(3)) : 0;
    var at = barBeatAt(sec);
    var zeroBar = Number.isInteger(n.bar) && n.bar >= 0 ? n.bar : at.bar;
    return {
      seconds: sec,
      bar: zeroBar,
      displayBar: zeroBar + 1,
      beat: Number.isInteger(n.beat) && n.beat >= 1 ? n.beat : at.beat,
      section: typeof n.section === 'string' ? n.section : sectionAtBar(zeroBar),
      text: String(n.text || '').trim(),
      rating: Number.isInteger(n.rating) && n.rating >= 1 && n.rating <= 5 ? n.rating : null,
      mode: n.mode || state.mode,
      soloedLanes: Array.isArray(n.soloedLanes) ? n.soloedLanes : (Array.isArray(n.solo) ? n.solo : []),
      mutedLanes: Array.isArray(n.mutedLanes) ? n.mutedLanes : (Array.isArray(n.muted) ? n.muted : []),
    };
  }

  try {
    var rawStored = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (rawStored && Array.isArray(rawStored.notes)) {
      state.notes = rawStored.notes.map(normaliseStoredNote).filter(function (n) { return Boolean(n.text || n.rating); });
      state.ratings = rawStored.ratings || {};
    }
  } catch (e) { /* ignore */ }

  function buildFeedback() {
    var files = [];
    if (D.mix && D.mix.url) files.push(D.mix.url);
    (D.lanes || []).forEach(function (l) { if (l.url) files.push(l.url); });
    return {
      schema: 'lmms-mcp/audition-feedback',
      version: 2,
      kind: 'timeline',
      title: D.title || 'Timeline',
      source: D.source || D.projectFile || null,
      page: D.pageName || null,
      projectFile: D.projectFile || null,
      projectSha256: D.projectSha256 || null,
      files: files,
      bpm: D.bpm,
      timeSignature: meter,
      introBars: 0,
      savedAt: new Date().toISOString(),
      sections: (D.sections || []).map(function (s) {
        return {
          name: s.name,
          startBar: s.startBar,
          displayStartBar: s.startBar + 1,
          bars: s.bars,
          rating: state.ratings[s.name] || null,
        };
      }),
      notes: state.notes.slice().sort(function (a, b) { return a.seconds - b.seconds; }),
    };
  }

  function drawNotes() {
    var list = $('notes');
    if (!list) return;
    list.innerHTML = '';
    if (!state.notes.length) {
      list.appendChild(el('li', 'hint', 'No notes yet. Type a note or press Add note here (N) to pin feedback at the playhead bar.'));
      return;
    }
    state.notes.forEach(function (n, idx) {
      var summary = 'Bar ' + n.displayBar + '.' + n.beat +
        (n.section ? ' (' + n.section + ')' : '') +
        (n.rating ? ' [' + n.rating + '/5]' : '') +
        ': ' + n.text +
        (n.soloedLanes.length ? ' [solo: ' + n.soloedLanes.join(', ') + ']' : '') +
        (n.mutedLanes.length ? ' [muted: ' + n.mutedLanes.join(', ') + ']' : '');
      var li = el('li', '', summary);
      var go = el('button', '', 'Go');
      go.type = 'button';
      go.addEventListener('click', function () { seek(n.seconds); });
      var rmBtn = el('button', '', 'Remove');
      rmBtn.type = 'button';
      rmBtn.addEventListener('click', function () {
        state.notes.splice(idx, 1);
        storeNotes();
        drawNotes();
      });
      li.appendChild(go);
      li.appendChild(rmBtn);
      list.appendChild(li);
    });
  }

  function addNoteAtPlayhead() {
    var t = clock();
    var pos = barBeatAt(t);
    var noteBox = $('notetext');
    var ratingSel = $('noterating');
    var text = noteBox ? noteBox.value.trim() : '';
    var ratingVal = ratingSel && ratingSel.value ? Number(ratingSel.value) : null;

    if (!text && !ratingVal) {
      if (typeof window !== 'undefined' && typeof window.prompt === 'function' && !noteBox) {
        var prompted = window.prompt('Note for Bar ' + pos.displayBar + ' (what is wrong or what you want):');
        if (prompted) text = prompted.trim();
      } else if (noteBox) {
        noteBox.focus();
        setStatus('Type feedback for Bar ' + pos.displayBar + ' in the note box, then click Add note here.', false);
        return;
      }
    }
    if (!text && !ratingVal) return;

    var entry = {
      seconds: Number(t.toFixed(3)),
      bar: pos.bar,
      displayBar: pos.displayBar,
      beat: pos.beat,
      section: sectionAtBar(pos.position),
      text: text,
      rating: ratingVal,
      mode: state.mode,
      soloedLanes: players.filter(function (p) { return !p.isMix && p.solo; }).map(function (p) { return p.lane.name; }),
      mutedLanes: players.filter(function (p) { return !p.isMix && p.mute; }).map(function (p) { return p.lane.name; }),
    };
    state.notes.push(entry);
    state.notes.sort(function (a, b) { return a.seconds - b.seconds; });
    if (noteBox) noteBox.value = '';
    if (ratingSel) ratingSel.value = '';
    storeNotes();
    drawNotes();
    setStatus('Pinned note at Bar ' + entry.displayBar + ' (project bar ' + entry.bar + ').', false);
  }

  var noteBtn = $('note');
  if (noteBtn) {
    noteBtn.addEventListener('click', addNoteAtPlayhead);
  }
  var noteTextEl = $('notetext');
  if (noteTextEl) {
    noteTextEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        addNoteAtPlayhead();
      }
    });
  }

  var copyBtn = $('copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text = JSON.stringify(buildFeedback(), null, 2);
      var done = function () {
        setStatus(state.notes.length + ' notes copied as Feedback v2 JSON.', false);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          if (noteTextEl) { noteTextEl.value = text; noteTextEl.select(); }
          setStatus('Clipboard blocked; Feedback v2 JSON placed in note box for Ctrl+C.', false);
        });
      } else if (noteTextEl) {
        noteTextEl.value = text;
        noteTextEl.select();
      }
    });
  }

  var saveBtn = $('save');
  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      var fname = D.feedbackName || ((studioSession || 'timeline') + '-feedback.json');
      var blob = new Blob([JSON.stringify(buildFeedback(), null, 2) + '\n'], { type: 'application/json' });
      var a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      setStatus('Downloaded ' + fname + '.', false);
    });
  }

  var sendBtn = $('send-feedback');
  if (sendBtn) {
    if (!isStudioHttp) {
      sendBtn.disabled = true;
      sendBtn.title = 'Open via the local Studio server (/studio/timeline) to save directly to workspace';
    }
    sendBtn.addEventListener('click', async function () {
      if (!isStudioHttp) return;
      try {
        var res = await fetch('/api/studio/feedback', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-studio-token': studioToken,
          },
          body: JSON.stringify({
            session: studioSession,
            feedback: buildFeedback(),
          }),
        });
        var payload = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        var confirmMsg = 'Saved to workspace (' + payload.file + ') \u2014 tell your LLM to apply your notes';
        setStatus(confirmMsg, false);
        var fbStatus = $('feedback-status');
        if (fbStatus) fbStatus.textContent = confirmMsg;
      } catch (err) {
        setStatus('Could not send feedback: ' + (err.message || err), true);
      }
    });
  }

  var openLmmsBtn = $('open-lmms');
  if (openLmmsBtn) {
    if (!D.projectFile) {
      openLmmsBtn.classList.add('hidden');
    } else if (!isStudioHttp) {
      openLmmsBtn.disabled = true;
      openLmmsBtn.title = 'Open via Studio URL to launch Desktop LMMS';
    }
    openLmmsBtn.addEventListener('click', async function () {
      if (!isStudioHttp || !D.projectFile) return;
      try {
        var res = await fetch('/api/studio/open-lmms', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-studio-token': studioToken,
          },
          body: JSON.stringify({
            session: studioSession,
            project: D.projectFile,
          }),
        });
        var payload = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        setStatus('Opened ' + payload.project + ' in Desktop LMMS. After saving, tell your LLM to run sync_from_lmms.', false);
      } catch (err) {
        setStatus('Could not open in LMMS: ' + (err.message || err), true);
      }
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.key === ' ') {
      ev.preventDefault();
      if (playBtn) playBtn.click();
    } else if (ev.key === 'n' || ev.key === 'N') {
      ev.preventDefault();
      addNoteAtPlayhead();
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      seek(clock() + barSeconds);
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      seek(clock() - barSeconds);
    }
  });

  applyLevels(true);
  drawNotes();
  updateBudgetTelemetry();
  void loadInitialBuffers();
  frame();
})();
