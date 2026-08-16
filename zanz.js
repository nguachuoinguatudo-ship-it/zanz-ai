(function () {
  'use strict';

  var LS_KEY = 'zanz_gemini_key';
  var DEFAULT_MODEL = 'gemini-2.5-flash';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function getKey() { return lsGet(LS_KEY).trim(); }

  function mapGeminiModel(zanzModel) {
    var m = String(zanzModel || '').toLowerCase();
    if (m === 'gemini-2.5-pro' || m === 'gemini-2.5-flash' || m === 'gemini-2.5-flash-lite') {
      return m;
    }
    if (m.indexOf('haiku') !== -1 || m.indexOf('mini') !== -1 || m.indexOf('nano') !== -1 ||
        m.indexOf('lite') !== -1 || m.indexOf('flash') !== -1) {
      return 'gemini-2.5-flash-lite';
    }
    if (m.indexOf('thinking') !== -1 || m.indexOf('opus') !== -1 || m.indexOf('o3') !== -1 ||
        m.indexOf('o4') !== -1 || m.indexOf('gpt-5') !== -1 || m.indexOf('gpt-4.1') !== -1 ||
        m.indexOf('gpt-4o') !== -1 || m.indexOf('sonnet') !== -1) {
      return 'gemini-2.5-pro';
    }
    return DEFAULT_MODEL;
  }

  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  function jsonResponse(obj, status) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }));
  }

  function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(function (p) { return p && p.type === 'text' && typeof p.text === 'string'; })
        .map(function (p) { return p.text; })
        .join('\n');
    }
    return '';
  }

  function geminiRequestBody(body) {
    var contents = [];
    var msgs = (body && body.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      var text = contentToText(m.content).trim();
      if (!text) continue;
      var role = m.role === 'assistant' ? 'model' : 'user';
      var last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts[0].text += '\n\n' + text;
      } else {
        contents.push({ role: role, parts: [{ text: text }] });
      }
    }
    return { contents: contents, generationConfig: { temperature: 0.7 } };
  }

  function sseLine(obj) {
    return 'data: ' + JSON.stringify(obj) + '\n\n';
  }

  function geminiChat(init) {
    var key = getKey();
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    var model = mapGeminiModel(body.model);

    var title = '';
    var msgs = (body.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i] && msgs[i].role === 'user') {
        title = contentToText(msgs[i].content).trim().replace(/\s+/g, ' ').slice(0, 48);
        if (title) break;
      }
    }

    var useProxy = window.ZANZ_API_PROXY === true;
    var url = useProxy
      ? '/api/chat'
      : 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) +
        ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key);

    var proxyBody = JSON.stringify({
      model: model,
      contents: geminiRequestBody(body).contents,
      generationConfig: geminiRequestBody(body).generationConfig
    });

    var signal = (init && init.signal) || undefined;

    return origFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: useProxy ? proxyBody : JSON.stringify(geminiRequestBody(body)),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (errText) {
          return jsonResponse(
            { type: 'ERR_STREAM_NETWORK', message: 'Gemini API ' + resp.status + ': ' + errText.slice(0, 400) },
            resp.status
          );
        });
      }
      if (!resp.body) {
        return jsonResponse({ type: 'ERR_STREAM_NETWORK', message: 'Gemini: response kosong' }, 502);
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var encoder = new TextEncoder();
      var buffer = '';

      function emitChunk(controller, json) {
        if (json.error) {
          var msg = json.error.message || 'Gemini API error';
          controller.enqueue(encoder.encode(sseLine({ action: 'error', type: 'ERR_STREAM_NETWORK', message: msg })));
          return;
        }
        var candidates = json.candidates;
        if (!candidates || !candidates.length) return;
        var content = candidates[0].content;
        if (!content || !content.parts) return;
        for (var i = 0; i < content.parts.length; i++) {
          var part = content.parts[i];
          if (part && typeof part.text === 'string' && part.text) {
            controller.enqueue(encoder.encode(sseLine({ action: 'success', role: 'assistant', message: part.text })));
          }
        }
      }

      function pump(controller) {
        return reader.read().then(function (r) {
          if (r.done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            try { controller.close(); } catch (e) {}
            return;
          }
          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              emitChunk(controller, JSON.parse(payload));
            } catch (e) {}
          }
          return pump(controller);
        }, function (err) {
          try { controller.error(err); } catch (e) {}
        });
      }

      if (signal) {
        signal.addEventListener('abort', function () {
          try { reader.cancel(); } catch (e) {}
        }, { once: true });
      }

      var stream = new ReadableStream({
        start: function (controller) {
          if (title) {
            controller.enqueue(encoder.encode('data: [CHAT_TITLE:' + title.replace(/]/g, '') + ']\n\n'));
          }
          pump(controller);
        },
        cancel: function () {
          try { reader.cancel(); } catch (e) {}
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive'
        }
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw err;
      return jsonResponse({ type: 'ERR_STREAM_NETWORK', message: 'Gemini: ' + (err && err.message ? err.message : err) }, 502);
    });
  }

  function installErrorCapture() {
    function showErr(msg) {
      try {
        var el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:12px;bottom:64px;z-index:2147483002;max-width:88vw;background:#111;color:#ffd7d7;border:1px solid #d93025;border-radius:10px;padding:10px 12px;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)';
        el.textContent = 'Zanz error: ' + msg;
        el.addEventListener('click', function () { try { el.remove(); } catch (e) {} });
        document.body.appendChild(el);
        setTimeout(function () { try { el.remove(); } catch (e) {} }, 20000);
      } catch (e) {}
    }
    if (window.addEventListener) {
      window.addEventListener('error', function (e) {
        var m = (e && e.message) || 'unknown';
        if (/ResizeObserver|Script error/i.test(m)) return;
        showErr(String(m).slice(0, 400));
      });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        var m = r && r.message ? r.message : String(r);
        if (/AbortError|ResizeObserver/i.test(m)) return;
        showErr('promise: ' + String(m).slice(0, 400));
      });
    }
  }

  function installFetchHook() {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      if (/\/zanzchat\/v1\/capabilities/.test(url)) {
        return jsonResponse({ accessLevel: 'public', flags: {}, experimentEnrollments: [], experimentStateResets: [] });
      }
      if (/\/zanzchat\/v1\/status/.test(url)) {
        return jsonResponse({ status: '1', statusV2: 1, features: {} });
      }
      if (method === 'POST' && /\/zanzchat\/v1\/chat$/.test(url)) {
        if (!getKey()) {
          return jsonResponse({ type: 'ERR_STREAM_NETWORK', message: 'Atur API Key Gemini dulu lewat tombol gerigi (Pengaturan Zanz Ai).' }, 401);
        }
        return geminiChat(init || {});
      }
      if (!getKey()) return origFetch(input, init);
      if (/\/zanzchat\/v1\/auth\/authorize/.test(url)) {
        return jsonResponse({});
      }
      if (/\/zanzchat\/v1\/auth\/token/.test(url) || /quack(dev)?\.(zanz\.ai|zanz\.com)\/api\/auth\/v2\/token/.test(url)) {
        return jsonResponse({});
      }
      if (/\/zanzchat\/v1\/auth\/logout/.test(url)) {
        return jsonResponse({ ok: true });
      }
      return origFetch(input, init);
    };
  }

  /* ===================== UI Pengaturan ===================== */

  var styles = [
    '#zanz-settings-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:44px;height:44px;border-radius:50%;border:1px solid rgba(0,0,0,.1);background:#fff;color:#333;box-shadow:0 2px 10px rgba(0,0,0,.15);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '#zanz-settings-btn:hover{transform:scale(1.06);box-shadow:0 4px 16px rgba(0,0,0,.22)}',
    '#zanz-settings-btn svg{width:22px;height:22px}',
    '#zanz-settings-btn .zanz-dot{position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:#1e9e5a;border:2px solid #fff;display:none}',
    '#zanz-settings-btn.zanz-active .zanz-dot{display:block}',
    '[data-theme="dark"] #zanz-settings-btn{background:#262626;color:#e8e8e8;border-color:rgba(255,255,255,.15)}',
    '[data-theme="dark"] #zanz-settings-btn .zanz-dot{border-color:#262626}',
    '#zanz-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '#zanz-overlay.zanz-open{display:flex}',
    '#zanz-modal{background:#fff;color:#222;border-radius:20px;max-width:420px;width:100%;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.3);max-height:90vh;overflow-y:auto}',
    '[data-theme="dark"] #zanz-modal{background:#1f1f1f;color:#f2f2f2}',
    '#zanz-modal h2{margin:0 0 4px;font-size:19px;font-weight:700}',
    '#zanz-modal .zanz-sub{font-size:13px;color:#666;margin:0 0 16px}',
    '[data-theme="dark"] #zanz-modal .zanz-sub{color:#a8a8a8}',
    '#zanz-modal label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}',
    '#zanz-modal input[type="password"],#zanz-modal input[type="text"]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid rgba(0,0,0,.16);border-radius:12px;font-size:14px;background:#fafafa;color:#222;outline:none}',
    '#zanz-modal input:focus{border-color:#3969ef}',
    '[data-theme="dark"] #zanz-modal input[type="password"],[data-theme="dark"] #zanz-modal input[type="text"]{background:#2b2b2b;color:#f2f2f2;border-color:rgba(255,255,255,.18)}',
    '#zanz-modal .zanz-row{display:flex;gap:8px;align-items:center}',
    '#zanz-modal .zanz-row input{flex:1}',
    '#zanz-modal .zanz-toggle{cursor:pointer;font-size:13px;color:#3969ef;background:none;border:none;padding:6px;white-space:nowrap}',
    '#zanz-modal .zanz-actions{display:flex;gap:10px;margin-top:18px}',
    '#zanz-modal .zanz-btn{flex:1;padding:11px 12px;border-radius:14px;border:1px solid rgba(0,0,0,.12);font-size:14px;font-weight:600;cursor:pointer;background:#f5f5f5;color:#222}',
    '#zanz-modal .zanz-btn-primary{background:#3969ef;color:#fff;border-color:transparent}',
    '[data-theme="dark"] #zanz-modal .zanz-btn{background:#2b2b2b;color:#f2f2f2}',
    '#zanz-modal .zanz-btn:hover{filter:brightness(.95)}',
    '#zanz-modal .zanz-note{font-size:12px;color:#777;margin-top:14px;line-height:1.5}',
    '[data-theme="dark"] #zanz-modal .zanz-note{color:#9c9c9c}',
    '#zanz-modal .zanz-status{font-size:13px;margin-top:14px;min-height:18px}',
    '#zanz-modal .zanz-status.ok{color:#1e9e5a}',
    '#zanz-modal .zanz-status.err{color:#d93025}',
    '#zanz-modal .zanz-close{position:absolute;top:14px;right:14px;cursor:pointer;background:none;border:none;font-size:18px;color:#888;padding:4px}',
    '#zanz-modal-wrap{position:relative}'
  ].join('');

  var gearSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  function buildUI() {
    var styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    var btn = document.createElement('button');
    btn.id = 'zanz-settings-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Pengaturan Zanz Ai');
    btn.innerHTML = gearSvg + '<span class="zanz-dot"></span>';
    document.body.appendChild(btn);

    var overlay = document.createElement('div');
    overlay.id = 'zanz-overlay';
    overlay.innerHTML =
      '<div id="zanz-modal-wrap"><button type="button" class="zanz-close" aria-label="Tutup">✕</button>' +
      '<div id="zanz-modal"><h2>Pengaturan Zanz Ai</h2>' +
      '<p class="zanz-sub">Hubungkan Gemini API agar chat diproses lewat Gemini.</p>' +
      '<label for="zanz-key">API Key Gemini</label>' +
      '<div class="zanz-row"><input type="password" id="zanz-key" placeholder="AIza..." autocomplete="off" spellcheck="false"/>' +
      '<button type="button" class="zanz-toggle" id="zanz-show">Lihat</button></div>' +
      '<div class="zanz-actions">' +
      '<button type="button" class="zanz-btn" id="zanz-clear">Hapus</button>' +
      '<button type="button" class="zanz-btn zanz-btn-primary" id="zanz-save">Simpan</button></div>' +
      '<div class="zanz-status" id="zanz-status"></div>' +
      '<p class="zanz-note">Key disimpan hanya di browser ini (localStorage). Chat dikirim langsung ke generativelanguage.googleapis.com. Model tetap dipilih lewat dropdown model di input chat — Zanz Ai otomatis memetakannya ke model Gemini terdekat. Klik "Hapus" untuk kembali memakai backend asli.</p>' +
      '</div></div>';
    document.body.appendChild(overlay);

    var keyInput = overlay.querySelector('#zanz-key');
    var showBtn = overlay.querySelector('#zanz-show');
    var statusEl = overlay.querySelector('#zanz-status');

    function refresh() {
      keyInput.value = getKey();
      statusEl.className = 'zanz-status';
      statusEl.textContent = '';
      btn.classList.toggle('zanz-active', !!getKey());
    }

    function open() { refresh(); overlay.classList.add('zanz-open'); }
    function close() { overlay.classList.remove('zanz-open'); }

    btn.addEventListener('click', open);
    overlay.querySelector('.zanz-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    showBtn.addEventListener('click', function () {
      var show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      showBtn.textContent = show ? 'Sembunyikan' : 'Lihat';
    });

    overlay.querySelector('#zanz-save').addEventListener('click', function () {
      var key = keyInput.value.trim();
      if (!key) {
        statusEl.className = 'zanz-status err';
        statusEl.textContent = 'Isi API key terlebih dahulu.';
        return;
      }
      lsSet(LS_KEY, key);
      statusEl.className = 'zanz-status ok';
      statusEl.textContent = 'Tersimpan. Key Gemini aktif untuk chat berikutnya.';
      btn.classList.add('zanz-active');
    });

    overlay.querySelector('#zanz-clear').addEventListener('click', function () {
      lsDel(LS_KEY);
      btn.classList.remove('zanz-active');
      statusEl.className = 'zanz-status ok';
      statusEl.textContent = 'Key dihapus. Chat kembali memakai backend asli.';
      refresh();
    });
  }

  installErrorCapture();
  installFetchHook();
  if (document.body) {
    buildUI();
  } else {
    document.addEventListener('DOMContentLoaded', buildUI);
  }
})();