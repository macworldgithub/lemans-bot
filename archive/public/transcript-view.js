// Live transcript renderer shared by index.html and monitor.html.
// Lines are keyed by OpenAI item id, so a caller line opened at speech start
// stays in place while its words stream in after the bot has started replying.
(function () {
  class TranscriptView {
    constructor(container, { botName = 'Chloe', userName = 'Caller' } = {}) {
      this.el = container;
      this.names = { bot: botName, user: userName };
      this.lines = new Map();
      this.startedAt = null;
    }

    clear(startedAt = Date.now()) {
      this.el.textContent = '';
      this.lines.clear();
      this.startedAt = startedAt;
    }

    // Rebuild from a stored transcript (monitor snapshot / call switch).
    load(lines, startedAt) {
      this.clear(startedAt);
      for (const l of lines) {
        const line = this.ensure(l.role, l.id, l.ts);
        line.text = l.text;
        line.final = l.final;
        line.interrupted = l.interrupted;
        line.speaker = l.speaker || null;
        this.render(line);
      }
      this.scroll(true);
    }

    apply(e) {
      const stick = this.nearBottom();
      const line = this.ensure(e.role, e.id, e.ts);
      if (e.kind === 'delta') line.text += e.text || '';
      else if (e.kind === 'final') {
        line.text = e.text ?? line.text;
        line.final = true;
      } else if (e.kind === 'interrupted') line.interrupted = true;
      else if (e.kind === 'speaker') line.speaker = e.speaker || null;
      this.render(line);
      this.scroll(stick);
    }

    // Marks lines that never got a final event (call ended mid-turn).
    finalizeAll() {
      for (const line of this.lines.values()) {
        if (!line.final) {
          line.final = true;
          this.render(line);
        }
      }
    }

    toPlainText() {
      return [...this.lines.values()]
        .map((l) => {
          const who = this.names[l.role];
          const t = this.stamp(l.ts);
          const text = l.text.trim() || '(no speech recognised)';
          const spk = l.speaker ? ` [${speakerLabel(l.speaker)}]` : '';
          return `[${t}] ${who}: ${text}${l.interrupted ? ' [interrupted]' : ''}${spk}`;
        })
        .join('\n');
    }

    // ── internals ────────────────────────────────────────────────────────
    ensure(role, id, ts) {
      const key = role + ':' + id;
      let line = this.lines.get(key);
      if (line) return line;
      if (this.startedAt == null) this.startedAt = ts || Date.now();

      const row = document.createElement('div');
      row.className = 'tv-msg tv-' + role;
      const meta = document.createElement('div');
      meta.className = 'tv-meta';
      const who = document.createElement('span');
      who.className = 'tv-who';
      who.textContent = this.names[role];
      const time = document.createElement('span');
      time.className = 'tv-time';
      time.textContent = this.stamp(ts);
      const tag = document.createElement('span');
      tag.className = 'tv-tag';
      meta.append(who, time, tag);
      const body = document.createElement('div');
      body.className = 'tv-text';
      row.append(meta, body);
      this.el.appendChild(row);

      line = { role, id, ts: ts || Date.now(), text: '', final: false, interrupted: false, speaker: null, row, body, tag };
      this.lines.set(key, line);
      return line;
    }

    render(line) {
      const hasText = line.text.trim().length > 0;
      if (hasText) line.body.textContent = line.text;
      else if (line.final) line.body.textContent = '(no speech recognised)';
      else line.body.textContent = line.role === 'user' ? 'listening…' : '…';
      line.row.classList.toggle('tv-pending', !line.final);
      line.row.classList.toggle('tv-empty', !hasText);
      line.row.classList.toggle('tv-interrupted', line.interrupted);
      const ignored = line.speaker?.decision === 'rejected';
      line.row.classList.toggle('tv-ignored', ignored);
      line.tag.classList.toggle('tv-tag-ok', !!line.speaker && !ignored);
      line.tag.textContent = line.interrupted
        ? 'interrupted'
        : line.speaker
          ? speakerLabel(line.speaker)
          : '';
      line.tag.title = line.speaker
        ? `voice similarity ${line.speaker.score ?? 'n/a'} (needs ${line.speaker.threshold ?? 'n/a'}), ${line.speaker.durationSec}s of speech`
        : '';
    }

    stamp(ts) {
      const s = Math.max(0, Math.round(((ts || Date.now()) - (this.startedAt || ts || Date.now())) / 1000));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    nearBottom() {
      return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 60;
    }

    scroll(stick) {
      if (stick) this.el.scrollTop = this.el.scrollHeight;
    }
  }

  // Speaker-lock verdict for a caller turn, e.g. "✓ voice 0.62" / "ignored · other voice 0.18".
  function speakerLabel(v) {
    switch (v.reason) {
      case 'match':         return `✓ voice ${v.score}`;
      case 'other-speaker': return `ignored · other voice ${v.score} < ${v.threshold}`;
      case 'enrolling':     return 'learning caller voice';
      case 'too-short':     return 'too short to check';
      default:              return 'voice check unavailable';
    }
  }

  function downloadText(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.TranscriptView = TranscriptView;
  window.downloadText = downloadText;
})();
