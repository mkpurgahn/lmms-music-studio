// Studio Audition client: gapless intro->loop & loudness-matched A/B player,
// 1-based UI bars + 0-based/1-based Feedback v2, Studio feedback POST, and Desktop LMMS launch bridge.

function barSeconds(bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4, denominator = meter && meter[1] ? meter[1] : 4;
  return 240 * numerator / (denominator * bpm);
}

function barBeatAt(seconds, bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4;
  const bar = barSeconds(bpm, meter);
  const position = seconds / bar;
  const whole = Math.floor(position + 1e-9);
  const beat = Math.min(numerator, Math.floor((position - whole) * numerator + 1e-9) + 1);
  return { bar: whole, beat, position };
}

function wrapSongTime(elapsed, introSeconds, loopSeconds) {
  if (elapsed < introSeconds || !(loopSeconds > 0)) return elapsed;
  return introSeconds + ((elapsed - introSeconds) % loopSeconds);
}

function startPlan(songFrame, introFrames, loopFrames) {
  const frame = Math.max(0, Math.round(songFrame));
  if (frame < introFrames) return { introOffset: frame, loopDelay: introFrames - frame, loopOffset: 0 };
  return { introOffset: null, loopDelay: 0, loopOffset: loopFrames > 0 ? (frame - introFrames) % loopFrames : 0 };
}

function sectionAt(position, sections) {
  let found = null;
  for (const section of sections || []) {
    if (position + 1e-9 >= section.startBar && position < section.startBar + section.bars - 1e-9) found = section;
  }
  return found;
}

function secondsToNextBar(seconds, bpm, meter) {
  const bar = barSeconds(bpm, meter);
  const next = Math.ceil(seconds / bar - 1e-6) * bar;
  return Math.max(0, next - seconds);
}

function stingerTime(now, songSeconds, bpm, meter, rate, quantise) {
  let at = now + 0.02;
  if (quantise) {
    let wait = secondsToNextBar(songSeconds, bpm, meter);
    if (wait < 0.01) wait += barSeconds(bpm, meter);
    at = now + wait;
  }
  return Math.round(at * rate) / rate;
}

function matchPicked(needed, picked) {
  const files = {}, missing = [], ambiguous = [];
  const lower = text => text.toLowerCase();
  const baseOf = text => lower(text).split('/').pop();
  for (const src of needed) {
    const want = lower(src);
    let hits = [];
    picked.forEach((file, index) => { if (file.path && lower(file.path).split('/').slice(1).join('/') === want) hits.push(index); });
    if (!hits.length) {
      const loose = [];
      picked.forEach((file, index) => { if (!file.path && lower(file.name) === baseOf(src)) loose.push(index); });
      if (loose.length && needed.filter(other => baseOf(other) === baseOf(src)).length > 1) { ambiguous.push(src); continue; }
      hits = loose;
    }
    if (hits.length === 1) files[src] = hits[0];
    else if (hits.length > 1) ambiguous.push(src);
    else missing.push(src);
  }
  return { files, missing, ambiguous };
}

function auditionPage() {
  const $ = id => document.getElementById(id);
  const appEl = $('studio-app');
  const cfgEl = $('audition-config');
  const rawConfig = (appEl && appEl.dataset && appEl.dataset.studioConfig) || (cfgEl && cfgEl.textContent) || '{}';
  const config = JSON.parse(rawConfig);

  const bodyDataset = (document.body && document.body.dataset) ? document.body.dataset : {};
  const studioToken = bodyDataset.studioToken || '';
  const studioSession = bodyDataset.studioSession || config.session || config.name || 'audition';
  const isStudioHttp = Boolean(studioToken);

  const make = (tag, props, text) => {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    if (text !== undefined) el.textContent = text;
    return el;
  };

  const sr = config.sampleRate;
  const timed = Boolean(config.bpm);
  const isGame = config.kind === 'game';
  const storeKey = 'lmms-audition:' + config.pageId;
  const state = {
    ctx: null,
    buffers: {},
    playing: false,
    startCtx: 0,
    startSong: 0,
    pausedAt: 0,
    sources: [],
    nodes: {},
    mode: config.layers.length ? 'layers' : 'mix',
    active: 0,
    notes: [],
    ratings: {},
    layers: Object.fromEntries(config.layers.map(layer => [layer.name, { db: 0, muted: false, solo: false }])),
  };

  const dbToGain = value => Math.pow(10, value / 20);
  const fmt = seconds => {
    const m = Math.floor(seconds / 60), s = seconds - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  };
  const status = (text, error) => {
    const el = $('status');
    el.textContent = text;
    el.className = 'status' + (error ? ' err' : '');
  };

  $('title').textContent = config.title;
  document.title = config.title;
  const facts = [];
  if (timed) facts.push(config.bpm + ' bpm', config.timeSignature.join('/'));
  if (config.intro) facts.push('intro ' + config.intro.bars + ' bars');
  if (config.loop) facts.push('loop ' + config.loop.bars + ' bars from Bar ' + (config.loop.startBar + 1));
  if (timed) facts.push('bars shown from Bar 1');
  $('subtitle').textContent = facts.join(' | ');

  const needed = [];
  if (config.intro) needed.push(config.intro.src);
  if (config.loop) needed.push(config.loop.src);
  for (const layer of config.layers) needed.push(layer.src);
  for (const stinger of config.stingers) needed.push(stinger.src);
  for (const file of config.compare) needed.push(file.src);

  const introSeconds = () => config.intro ? state.buffers[config.intro.src].duration : 0;
  const loopSeconds = () => isGame ? state.buffers[config.loop.src].duration : state.buffers[config.compare[state.active].src].duration;
  const spanSeconds = () => introSeconds() + loopSeconds();

  function makeContext() {
    try { return new AudioContext({ sampleRate: sr }); } catch (error) { return new AudioContext(); }
  }

  async function decodeAll(read) {
    state.ctx = state.ctx || makeContext();
    const frames = {};
    for (const src of needed) {
      if (state.buffers[src]) continue;
      const data = await read(src);
      state.buffers[src] = await state.ctx.decodeAudioData(data);
      frames[src] = state.buffers[src].length;
    }
    if (!isGame && config.compare.length > 1) {
      const longest = Math.max.apply(null, config.compare.map(file => state.buffers[file.src].length));
      for (const file of config.compare) {
        const buffer = state.buffers[file.src];
        if (buffer.length === longest) continue;
        const padded = state.ctx.createBuffer(buffer.numberOfChannels, longest, buffer.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) padded.copyToChannel(buffer.getChannelData(c), c);
        state.buffers[file.src] = padded;
        state.padded = true;
      }
      if (state.padded) $('compareinfo').textContent += ' Shorter files are padded with silence to the longest so all stay in step.';
    }
    buildGraph();
    $('loader').dataset.ready = 'yes';
    $('loader').dataset.frames = JSON.stringify(frames);
    $('loader').dataset.playFrames = JSON.stringify(Object.fromEntries(needed.map(src => [src, state.buffers[src].length])));
    $('loader').dataset.contextRate = String(state.ctx.sampleRate);
    status('Ready. ' + needed.length + ' file' + (needed.length === 1 ? '' : 's') + ' decoded at ' + state.ctx.sampleRate + ' Hz' +
      (state.ctx.sampleRate !== sr ? ' (the browser resampled from ' + sr + ' Hz)' : '') + '.');
    $('play').disabled = false;
    $('restart').disabled = false;
    drawTimeline();
    if (location.hash === '#selftest' && isGame) {
      selfTest().then(
        result => { $('loader').dataset.selftest = JSON.stringify(result); },
        error => { $('loader').dataset.selftest = JSON.stringify({ error: String(error && error.message || error) }); }
      );
    }
  }

  async function selfTest() {
    const rate = state.ctx.sampleRate, intro = config.intro ? state.buffers[config.intro.src] : null, loop = state.buffers[config.loop.src];
    const introFrames = intro ? intro.length : 0, span = Math.round(rate / 2);
    const expected = (frame, channel) => frame < introFrames ? intro.getChannelData(channel)[frame] : loop.getChannelData(channel)[(frame - introFrames) % loop.length];
    async function render(startFrame, keys) {
      const offline = new OfflineAudioContext(2, span * 2, rate);
      scheduleGame(rate, 0, startFrame / rate, (buffer, key, looped) => {
        if (!keys.includes(key) && !(keys.includes('layers') && key !== 'intro' && key !== 'mix')) return null;
        const node = offline.createBufferSource();
        node.buffer = buffer;
        if (looped) { node.loop = true; node.loopStart = 0; node.loopEnd = buffer.duration; }
        node.connect(offline.destination);
        return node;
      });
      return offline.startRendering();
    }
    function compare(rendered, startFrame) {
      let maxDiff = 0;
      for (let c = 0; c < 2; c++) {
        const data = rendered.getChannelData(c);
        for (let i = 0; i < data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(data[i] - expected(startFrame + i, Math.min(c, loop.numberOfChannels - 1))));
      }
      return maxDiff;
    }
    const result = { sampleRate: rate, introFrames, loopFrames: loop.length };
    if (intro) { const start = introFrames - span; result.introJoinMaxDiff = compare(await render(start, ['intro', 'mix']), start); }
    const seam = introFrames + loop.length - span;
    result.loopSeamMaxDiff = compare(await render(seam, ['intro', 'mix']), seam);
    if (config.layers.length) {
      const start = introFrames + Math.max(0, Math.min(loop.length - 2 * span, rate));
      const layered = await render(start, ['layers']);
      let error = 0, reference = 0;
      for (let c = 0; c < 2; c++) {
        const data = layered.getChannelData(c);
        for (let i = 0; i < data.length; i++) { const want = expected(start + i, c); error += (data[i] - want) ** 2; reference += want * want; }
      }
      result.layersVsMixDb = reference > 0 ? (error > 0 ? 10 * Math.log10(error / reference) : -200) : null;
    }
    return result;
  }

  async function fetchAll() {
    try {
      await decodeAll(async src => {
        const response = await fetch(src);
        if (!response.ok) throw new Error(src + ': HTTP ' + response.status);
        return response.arrayBuffer();
      });
    } catch (error) {
      status('Could not load the audio (' + error.message + '). Choose the files below instead.', true);
      $('picker').classList.remove('hidden');
    }
  }

  function fromPicker(list) {
    const files = Array.from(list);
    const match = matchPicked(needed, files.map(file => ({ name: file.name, path: file.webkitRelativePath || '' })));
    if (match.ambiguous.length) { status('These files share a name with another file the page needs: ' + match.ambiguous.join(', ') + '. Use Choose folder and pick the folder that holds this page.', true); return; }
    if (match.missing.length) { status('Missing: ' + match.missing.join(', ') + '. Pick the folder that holds this page.', true); return; }
    status('Decoding...');
    decodeAll(src => files[match.files[src]].arrayBuffer()).catch(error => status('Could not decode the audio: ' + error.message, true));
  }

  $('pickfolder').onclick = () => $('folderinput').click();
  $('pickfiles').onclick = () => $('filesinput').click();
  $('folderinput').onchange = event => fromPicker(event.target.files);
  $('filesinput').onchange = event => fromPicker(event.target.files);

  function buildGraph() {
    const ctx = state.ctx, nodes = state.nodes;
    nodes.master = ctx.createGain(); nodes.master.connect(ctx.destination);
    nodes.intro = ctx.createGain(); nodes.intro.connect(nodes.master);
    nodes.mix = ctx.createGain(); nodes.mix.connect(nodes.master);
    nodes.layerBus = ctx.createGain(); nodes.layerBus.connect(nodes.master);
    nodes.stingers = ctx.createGain(); nodes.stingers.connect(nodes.master);
    nodes.layer = {};
    for (const layer of config.layers) { nodes.layer[layer.name] = ctx.createGain(); nodes.layer[layer.name].connect(nodes.layerBus); }
    nodes.compare = config.compare.map(() => { const gain = ctx.createGain(); gain.connect(nodes.master); return gain; });
    applyGains(true);
  }

  function setGain(node, value, now) {
    const ctx = state.ctx;
    if (now) node.gain.value = value;
    else { node.gain.cancelScheduledValues(ctx.currentTime); node.gain.setTargetAtTime(value, ctx.currentTime, 0.012); }
  }

  function updateModeBadge() {
    const badge = $('mode-banner');
    if (!badge) return;
    badge.textContent = state.mode === 'mix'
      ? 'Master Mix (authoritative post-master output)'
      : 'Stems (isolated pre-master tracks)';
    badge.className = 'mode-badge' + (state.mode === 'mix' ? ' mix' : '');
  }

  function applyGains(now) {
    updateModeBadge();
    if (!state.ctx) return;
    const nodes = state.nodes;
    setGain(nodes.master, dbToGain(Number($('master').value)), now);
    if (isGame) {
      const layered = state.mode === 'layers' && config.layers.length > 0;
      setGain(nodes.mix, layered ? 0 : 1, now);
      setGain(nodes.layerBus, layered ? 1 : 0, now);
      const anySolo = Object.values(state.layers).some(layer => layer.solo);
      for (const layer of config.layers) {
        const s = state.layers[layer.name];
        setGain(nodes.layer[layer.name], (anySolo ? s.solo : !s.muted) ? dbToGain(s.db) : 0, now);
      }
    }
    config.compare.forEach((file, index) => setGain(nodes.compare[index], index === state.active ? dbToGain(file.gainDb) : 0, now));
  }

  function source(buffer, destination, loop) {
    const node = state.ctx.createBufferSource();
    node.buffer = buffer;
    if (loop) { node.loop = true; node.loopStart = 0; node.loopEnd = buffer.duration; }
    node.connect(destination);
    state.sources.push(node);
    return node;
  }

  function stopAll() {
    for (const node of state.sources) { try { node.stop(); } catch (error) { /* already stopped */ } node.disconnect(); }
    state.sources = [];
  }

  function scheduleGame(rate, when, songSeconds, makeSource) {
    const introFrames = config.intro ? state.buffers[config.intro.src].length : 0;
    const loopBuffer = state.buffers[config.loop.src];
    const plan = startPlan(songSeconds * rate, introFrames, loopBuffer.length);
    if (config.intro && plan.introOffset !== null) makeSource(state.buffers[config.intro.src], 'intro', false)?.start(when, plan.introOffset / rate);
    const loopWhen = when + plan.loopDelay / rate, loopOffset = plan.loopOffset / rate;
    makeSource(loopBuffer, 'mix', true)?.start(loopWhen, loopOffset);
    for (const layer of config.layers) makeSource(state.buffers[layer.src], layer.name, true)?.start(loopWhen, loopOffset);
  }

  function startAt(songSeconds) {
    const ctx = state.ctx;
    stopAll();
    const when = Math.ceil((ctx.currentTime + 0.06) * ctx.sampleRate) / ctx.sampleRate;
    const rate = ctx.sampleRate;
    if (isGame) {
      scheduleGame(rate, when, songSeconds, (buffer, key, loop) =>
        source(buffer, key === 'intro' ? state.nodes.intro : key === 'mix' ? state.nodes.mix : state.nodes.layer[key], loop));
    } else {
      config.compare.forEach((file, index) => {
        const buffer = state.buffers[file.src];
        source(buffer, state.nodes.compare[index], true).start(when, (Math.round(songSeconds * rate) % buffer.length) / rate);
      });
    }
    state.startCtx = when;
    state.startSong = songSeconds;
    state.playing = true;
    $('play').textContent = 'Pause';
  }

  function songTime(now) {
    if (!state.ctx) return 0;
    if (!state.playing) return state.pausedAt;
    const elapsed = Math.max(0, (now === undefined ? state.ctx.currentTime : now) - state.startCtx) + state.startSong;
    return wrapSongTime(elapsed, introSeconds(), loopSeconds());
  }

  function stingerStart(now) {
    return stingerTime(now, songTime(now), config.bpm, config.timeSignature, state.ctx.sampleRate, state.playing && timed && $('quantise').checked);
  }

  async function play(from) {
    if (!state.ctx) return;
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    startAt(from === undefined ? state.pausedAt : from);
  }

  function pause() {
    state.pausedAt = songTime();
    stopAll();
    state.playing = false;
    $('play').textContent = 'Play';
  }

  function seek(seconds) {
    if (state.playing) play(seconds);
    else state.pausedAt = seconds;
  }

  $('play').onclick = () => state.playing ? pause() : play();
  $('restart').onclick = () => play(0);
  $('master').oninput = () => { $('masterdb').textContent = Number($('master').value).toFixed(1) + ' dB'; applyGains(); };
  $('timeline').onclick = event => {
    if (!state.ctx || !needed.every(src => state.buffers[src])) return;
    const box = $('timeline').getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * spanSeconds());
  };

  function where(seconds) {
    const info = { seconds: Number(seconds.toFixed(3)), bar: null, displayBar: null, beat: null, section: null };
    if (timed) {
      const at = barBeatAt(seconds, config.bpm, config.timeSignature);
      info.bar = at.bar;
      info.displayBar = at.bar + 1;
      info.beat = at.beat;
      const section = sectionAt(at.position, config.sections);
      info.section = section ? section.name : null;
    }
    return info;
  }

  function describe(info) {
    const shownBar = info.displayBar !== null && info.displayBar !== undefined
      ? info.displayBar
      : (info.bar !== null && info.bar !== undefined ? info.bar + 1 : null);
    return fmt(info.seconds) + (shownBar !== null ? '  Bar ' + shownBar + '.' + info.beat : '');
  }

  function drawTimeline() {
    const bar = $('timeline');
    for (const mark of Array.from(bar.querySelectorAll('.mark'))) mark.remove();
    const span = spanSeconds();
    if (!span) return;
    const marks = timed ? config.sections.map(section => ({ at: section.startBar * barSeconds(config.bpm, config.timeSignature), label: section.name })) : [];
    if (config.intro && !marks.some(mark => Math.abs(mark.at - introSeconds()) < 1e-3)) marks.push({ at: introSeconds(), label: 'loop' });
    for (const mark of marks) {
      if (mark.at >= span) continue;
      const el = make('div', { className: 'mark' }, mark.label);
      el.style.left = (100 * mark.at / span) + '%';
      bar.appendChild(el);
    }
  }

  function tick() {
    if (state.ctx && needed.every(src => state.buffers[src])) {
      const seconds = songTime();
      const info = where(seconds);
      $('clock').textContent = fmt(seconds);
      $('pos').textContent = info.displayBar !== null ? 'Bar ' + info.displayBar + ' | Beat ' + info.beat : '';
      $('secname').textContent = info.section || '';
      const fraction = Math.min(1, seconds / spanSeconds());
      $('fill').style.width = (100 * fraction) + '%';
      $('head').style.left = 'calc(' + (100 * fraction) + '% - 1px)';
      $('notewhere').textContent = 'at ' + describe(info) + (info.section ? ' in ' + info.section : '');
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  if (config.layers.length) {
    $('layerpanel').classList.remove('hidden');
    const modeButtons = () => {
      $('modemix').className = state.mode === 'mix' ? 'on' : '';
      $('modelayers').className = state.mode === 'layers' ? 'on' : '';
      updateModeBadge();
    };
    $('modemix').onclick = () => { state.mode = 'mix'; modeButtons(); applyGains(); };
    $('modelayers').onclick = () => { state.mode = 'layers'; modeButtons(); applyGains(); };
    modeButtons();
    for (const layer of config.layers) {
      const s = state.layers[layer.name];
      const row = make('div', { className: 'layer' });
      const name = make('span', { title: layer.tracks.join(', ') }, layer.name);
      const fader = make('input', { type: 'range', min: '-40', max: '6', step: '0.5', value: '0' });
      const readout = make('span', { className: 'db' }, '0.0 dB');
      const mute = make('button', { type: 'button' }, 'M');
      const solo = make('button', { type: 'button' }, 'S');
      fader.oninput = () => { s.db = Number(fader.value); readout.textContent = s.db.toFixed(1) + ' dB'; applyGains(); };
      mute.onclick = () => { s.muted = !s.muted; mute.className = s.muted ? 'on' : ''; applyGains(); };
      solo.onclick = () => { s.solo = !s.solo; solo.className = s.solo ? 'on' : ''; if (state.mode !== 'layers') { state.mode = 'layers'; modeButtons(); } applyGains(); };
      row.append(name, fader, readout, mute, solo);
      $('layers').appendChild(row);
    }
  }

  if (config.compare.length) {
    $('comparepanel').classList.remove('hidden');
    const buttons = config.compare.map((file, index) => {
      const button = make('button', { type: 'button', title: file.src }, file.label + ': ' + file.src.split('/').pop());
      button.onclick = () => { state.active = index; buttons.forEach((b, i) => { b.className = i === index ? 'on' : ''; }); applyGains(); drawTimeline(); };
      $('comparebuttons').appendChild(button);
      return button;
    });
    buttons[0].className = 'on';
    $('compareinfo').textContent = config.compare.length > 1 ? 'Levels matched to the quietest file: ' + config.compare.map(file => file.label + ' ' +
      (file.lufs === null ? 'not measured' : file.lufs.toFixed(1) + ' LUFS, ' + (file.gainDb > 0 ? '+' : '') + file.gainDb.toFixed(1) + ' dB')).join('; ') +
      '. All files play in sync; switching keeps the position.' : '';
  }

  if (config.stingers.length) {
    $('stingerpanel').classList.remove('hidden');
    for (const stinger of config.stingers) {
      const button = make('button', { type: 'button', title: 'Cut from Bar ' + (stinger.startBar + 1) + ', ' + stinger.bars + ' bars' }, stinger.name);
      button.onclick = async () => {
        if (!state.ctx) return;
        if (state.ctx.state === 'suspended') await state.ctx.resume();
        source(state.buffers[stinger.src], state.nodes.stingers, false).start(stingerStart(state.ctx.currentTime));
      };
      $('stingers').appendChild(button);
    }
  }

  function drawSections() {
    const box = $('sections');
    box.textContent = '';
    for (const section of config.sections) {
      const row = make('div', { className: 'sec' });
      const jump = make('button', { type: 'button' }, section.name + ' (Bar ' + (section.startBar + 1) + ', ' + section.bars + ' bars)');
      jump.onclick = () => { const at = section.startBar * barSeconds(config.bpm, config.timeSignature); if (state.playing) play(at); else seek(at); };
      const stars = make('span', { className: 'stars' });
      for (let value = 1; value <= 5; value++) {
        const star = make('button', { type: 'button', title: 'Rate ' + section.name + ' ' + value + ' of 5', className: state.ratings[section.name] >= value ? 'on' : '' }, String(value));
        star.onclick = () => { state.ratings[section.name] = state.ratings[section.name] === value ? null : value; persist(); drawSections(); };
        stars.appendChild(star);
      }
      row.append(jump, stars);
      box.appendChild(row);
    }
  }
  if (config.sections.length && timed) { $('sectionpanel').classList.remove('hidden'); drawSections(); }
  if (config.spectrogram) { $('specpanel').classList.remove('hidden'); $('spec').src = config.spectrogram; }

  function snapshot() {
    const info = where(songTime());
    const soloedLanes = [];
    const mutedLanes = [];
    if (config.layers.length && state.mode === 'layers') {
      for (const layer of config.layers) {
        const s = state.layers[layer.name];
        if (s.solo) soloedLanes.push(layer.name);
        if (s.muted) mutedLanes.push(layer.name);
      }
    }
    const note = {
      seconds: info.seconds,
      bar: info.bar,
      displayBar: info.displayBar,
      beat: info.beat,
      section: info.section,
      soloedLanes,
      mutedLanes,
    };
    if (config.layers.length) {
      note.mode = state.mode;
      if (state.mode === 'layers') note.layers = Object.fromEntries(config.layers.map(layer => [layer.name, Object.assign({}, state.layers[layer.name])]));
    }
    if (config.compare.length) note.compare = config.compare[state.active].label;
    return note;
  }

  function drawNotes() {
    const list = $('notes');
    list.textContent = '';
    state.notes.slice().sort((a, b) => a.seconds - b.seconds).forEach(note => {
      const item = make('li');
      const when = make('span', { className: 'when', title: 'Jump here' }, describe(note) + (note.compare ? ' [' + note.compare + ']' : ''));
      when.onclick = () => {
        if (note.compare) {
          const index = config.compare.findIndex(file => file.label === note.compare);
          if (index >= 0) $('comparebuttons').children[index].click();
        }
        if (state.playing) play(note.seconds); else seek(note.seconds);
      };
      const text = make('span', { className: 'text' }, (note.rating ? '[' + note.rating + '/5] ' : '') + note.text);
      const remove = make('button', { type: 'button', title: 'Delete note' }, 'Remove');
      remove.onclick = () => { state.notes = state.notes.filter(other => other !== note); persist(); drawNotes(); };
      item.append(when, text, remove);
      list.appendChild(item);
    });
  }

  function addNote() {
    const text = $('notetext').value.trim();
    if (!text) { $('notetext').focus(); return; }
    const note = snapshot();
    note.text = text;
    note.rating = $('noterating').value ? Number($('noterating').value) : null;
    state.notes.push(note);
    $('notetext').value = '';
    $('noterating').value = '';
    persist();
    drawNotes();
  }

  $('addnote').onclick = addNote;
  $('notetext').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addNote(); } };

  function feedback() {
    return {
      schema: config.schema || 'lmms-mcp/audition-feedback',
      version: 2,
      kind: 'audition',
      title: config.title,
      source: config.source,
      page: config.pageName,
      projectFile: config.projectFile || null,
      projectSha256: config.projectSha256 || null,
      files: needed,
      bpm: config.bpm,
      timeSignature: config.timeSignature,
      introBars: config.intro ? config.intro.bars : 0,
      savedAt: new Date().toISOString(),
      sections: config.sections.map(section => ({
        name: section.name,
        startBar: section.startBar,
        displayStartBar: section.startBar + 1,
        bars: section.bars,
        rating: state.ratings[section.name] || null,
      })),
      notes: state.notes.slice().sort((a, b) => a.seconds - b.seconds),
    };
  }

  $('save').onclick = () => {
    const blob = new Blob([JSON.stringify(feedback(), null, 2) + '\n'], { type: 'application/json' });
    const link = make('a', { href: URL.createObjectURL(blob), download: config.feedbackName });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    $('savestatus').textContent = 'Saved ' + config.feedbackName + '. Move it into the workspace and ask the agent to read_feedback, or use Copy and paste it into the chat.';
  };

  $('copy').onclick = async () => {
    const text = JSON.stringify(feedback(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $('savestatus').textContent = 'Copied. Paste it into the chat; the agent passes it to read_feedback as text.';
    } catch (error) {
      $('notetext').value = text;
      $('notetext').select();
      $('savestatus').textContent = 'The browser blocked the clipboard. The feedback is selected in the note box; copy it with Ctrl+C.';
    }
  };

  const sendBtn = $('send-feedback');
  if (sendBtn) {
    if (!isStudioHttp) {
      sendBtn.disabled = true;
      sendBtn.title = 'Open via Studio URL to save feedback directly to the workspace';
    }
    sendBtn.onclick = async () => {
      if (!isStudioHttp) return;
      try {
        const res = await fetch('/api/studio/feedback', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-studio-token': studioToken,
          },
          body: JSON.stringify({
            session: studioSession,
            feedback: feedback(),
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        $('savestatus').textContent = 'Saved to workspace (' + payload.file + ') \u2014 tell your LLM to apply your notes';
      } catch (err) {
        $('savestatus').textContent = 'Could not send feedback: ' + (err.message || err);
      }
    };
  }

  const openLmmsBtn = $('open-lmms');
  if (openLmmsBtn) {
    if (!config.projectFile) {
      openLmmsBtn.classList.add('hidden');
    } else if (!isStudioHttp) {
      openLmmsBtn.disabled = true;
      openLmmsBtn.title = 'Open via Studio URL to launch Desktop LMMS';
    }
    openLmmsBtn.onclick = async () => {
      if (!isStudioHttp || !config.projectFile) return;
      try {
        const res = await fetch('/api/studio/open-lmms', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-studio-token': studioToken,
          },
          body: JSON.stringify({
            session: studioSession,
            project: config.projectFile,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        $('savestatus').textContent = 'Opened ' + payload.project + ' in Desktop LMMS. After saving, tell your LLM to run sync_from_lmms.';
      } catch (err) {
        $('savestatus').textContent = 'Could not open in LMMS: ' + (err.message || err);
      }
    };
  }

  function persist() {
    try { localStorage.setItem(storeKey, JSON.stringify({ notes: state.notes, ratings: state.ratings })); } catch (error) { /* storage unavailable */ }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (saved) {
      state.notes = (saved.notes || []).map(n => ({
        ...n,
        displayBar: n.displayBar !== undefined && n.displayBar !== null ? n.displayBar : (n.bar !== null && n.bar !== undefined ? n.bar + 1 : null),
        soloedLanes: Array.isArray(n.soloedLanes) ? n.soloedLanes : [],
        mutedLanes: Array.isArray(n.mutedLanes) ? n.mutedLanes : [],
      }));
      state.ratings = saved.ratings || {};
      drawNotes();
      if (timed) drawSections();
    }
  } catch (error) { /* storage unavailable */ }

  document.addEventListener('keydown', event => {
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if (typing) return;
    if (event.code === 'Space') { event.preventDefault(); if (!$('play').disabled) $('play').click(); }
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); $('notetext').focus(); }
  });

  if (location.protocol === 'file:') {
    status('Opened from disk. Choose the folder that holds this page to load the audio.');
    $('picker').classList.remove('hidden');
  } else {
    fetchAll();
  }
}

auditionPage();
