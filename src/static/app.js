// Lager interface enhancements. Every page works without this file; it only adds conveniences.
(function () {
  'use strict';
  var root = document.documentElement;
  var THEME_KEY = 'lager-theme';
  var THEMES = ['system', 'light', 'dark'];

  // Menus are <details>: close them on a click elsewhere, on Escape, and when another menu opens.
  var menus = function () { return document.querySelectorAll('details.menu[open]'); };
  document.addEventListener('click', function (e) {
    menus().forEach(function (m) { if (!m.contains(e.target)) m.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus().forEach(function (m) {
      m.removeAttribute('open');
      var s = m.querySelector('summary');
      if (s && m.contains(document.activeElement)) s.focus();
    });
  });
  document.querySelectorAll('details.menu').forEach(function (m) {
    // Tabbing out of an open menu closes it.
    m.addEventListener('focusout', function (e) {
      if (m.open && e.relatedTarget && !m.contains(e.relatedTarget)) m.removeAttribute('open');
    });
    m.addEventListener('toggle', function () {
      if (!m.open) return;
      document.querySelectorAll('details.menu[open]').forEach(function (o) { if (o !== m) o.removeAttribute('open'); });
    });
  });

  // Passwords: a button in the field shows or hides what was typed; on submit it is a password field again, for password managers.
  // Pasted keys (data-reveal="off") get none.
  var SHOW = document.body.getAttribute('data-show-password');
  var HIDE = document.body.getAttribute('data-hide-password');
  if (SHOW && HIDE) document.querySelectorAll('input[type="password"]:not([data-reveal="off"])').forEach(function (input) {
    var focused = document.activeElement === input;
    var wrap = document.createElement('span');
    wrap.className = 'reveal';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'reveal-btn';
    b.innerHTML = '<svg class="i" aria-hidden="true" focusable="false"><use href="#i-eye"></use></svg>';
    var set = function (shown) {
      input.type = shown ? 'text' : 'password';
      b.setAttribute('aria-pressed', String(shown));
      b.setAttribute('aria-label', shown ? HIDE : SHOW);
      b.firstChild.firstChild.setAttribute('href', shown ? '#i-eyeOff' : '#i-eye');
    };
    set(false);
    b.addEventListener('click', function () { set(input.type === 'password'); });
    if (input.form) input.form.addEventListener('submit', function () { set(false); });
    wrap.appendChild(b);
    if (focused) input.focus();
  });

  // Filters above long lists: entries without what was typed are hidden.
  document.querySelectorAll('input[data-filter]').forEach(function (input) {
    var box = input.parentNode;
    var none = box.querySelector('.filter-none');
    box.hidden = false;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var sel = input.getAttribute('data-filter');
      var left = 0;
      document.querySelectorAll(sel).forEach(function (el) {
        el.hidden = q !== '' && el.textContent.toLowerCase().indexOf(q) === -1;
        if (!el.hidden) left++;
        // A section left without entries goes too, heading and all.
        var sec = el.closest('section');
        if (sec && !sec.contains(box)) sec.hidden = !sec.querySelector(sel + ':not([hidden])');
      });
      if (none) none.textContent = left ? '' : none.getAttribute('data-none');
    });
  });

  // Dates: the server writes UTC; here they become the viewer's own time, in the page's language.
  var DATE_FORMATS = {
    datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    day: { year: 'numeric', month: 'short', day: 'numeric' }
  };
  document.querySelectorAll('time[datetime][data-local]').forEach(function (el) {
    var date = new Date(el.getAttribute('datetime'));
    var format = DATE_FORMATS[el.getAttribute('data-local')];
    if (!format || isNaN(date.getTime())) return;
    try {
      el.textContent = new Intl.DateTimeFormat(root.lang || undefined, format).format(date);
      if (el.hasAttribute('title')) el.title = new Intl.DateTimeFormat(root.lang || undefined, DATE_FORMATS.datetime).format(date);
    } catch (e) { /* the UTC text stays */ }
  });

  // A new instance's name: the address under it follows what is typed; opening "get your own" focuses the field.
  document.querySelectorAll('input[data-address-template]').forEach(function (input) {
    var out = document.querySelector('[data-address-for="' + input.id + '"]');
    var template = input.getAttribute('data-address-template');
    if (!out || !template) return;
    // Also at the start: a refused name comes back in the field.
    var update = function () { out.textContent = template.replace('__slug__', input.value.trim() || '…'); };
    update();
    input.addEventListener('input', update);
  });
  document.querySelectorAll('details.getown').forEach(function (panel) {
    panel.addEventListener('toggle', function () {
      var input = panel.open && panel.querySelector('input[name="slug"]');
      if (input) { input.focus(); input.select(); }
    });
  });

  // Copy buttons: text and labels come from data attributes.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    if (!navigator.clipboard) return;
    btn.hidden = false;
    var label = btn.querySelector('[data-label]');
    var original = label ? label.textContent : '';
    var timer;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(function () {
        if (label) label.textContent = btn.getAttribute('data-copied') || original;
        btn.classList.add('copy-done');
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (label) label.textContent = original;
          btn.classList.remove('copy-done');
        }, 1800);
      }, function () { /* clipboard refused: the text stays selectable */ });
    });
  });

  // Theme: system, light or dark, remembered in this browser only.
  var stored = function () {
    try { var v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  };
  var apply = function (theme) {
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    try { if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme); } catch (e) { /* not stored */ }
  };
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    var name = btn.querySelector('[data-theme-name]');
    var show = function (theme) {
      if (name) name.textContent = btn.getAttribute('data-' + theme) || theme;
      btn.setAttribute('data-current', theme);
    };
    show(stored());
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var next = THEMES[(THEMES.indexOf(stored()) + 1) % THEMES.length];
      apply(next);
      show(next);
    });
  });

  // Sending: the pressed button shows the form is on its way; pressing again sends nothing. Not disabled, so its name and value
  // still go with the form.
  // A stopped load shows no new page: after 100 s the form can be sent again, longer than any answer takes (the AI test waits up
  // to DEFAULT_REQUEST_TIMEOUT_MS, 90 s, in src/platform/ai.ts).
  var idle = function (form) {
    clearTimeout(form._busyTimer);
    form.removeAttribute('data-busy');
    form.querySelectorAll('[aria-busy="true"]').forEach(function (b) { b.removeAttribute('aria-busy'); });
  };
  var busy = function (form, button) {
    clearTimeout(form._busyTimer);
    form.setAttribute('data-busy', '');
    if (button) button.setAttribute('aria-busy', 'true');
    form._busyTimer = setTimeout(function () { idle(form); }, 100000);
  };
  // Capture: a busy form stops here, before its own listeners (a question would ask again).
  window.addEventListener('submit', function (e) {
    if (e.target.hasAttribute('data-busy')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('submit', function (e) {
    // A form that asks first (below) is sent once the answer is yes.
    if (!e.defaultPrevented) busy(e.target, e.submitter || e.target.querySelector('[type="submit"]'));
  });
  window.addEventListener('pageshow', function () { document.querySelectorAll('form[data-busy]').forEach(idle); });

  // Questions before changes that cannot be taken back: only a yes in the dialog sends the form, with confirmed=1; Cancel has the
  // focus. Without this script or <dialog>, the server asks on a page of its own.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      // Asked every time: a yes from before (page cache, a failed send) does not count again.
      if (typeof HTMLDialogElement === 'undefined') return;
      e.preventDefault();
      var trigger = e.submitter || form.querySelector('[type="submit"]');
      var dialog = document.createElement('dialog');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      dialog.setAttribute('aria-describedby', 'confirm-text');
      var title = document.createElement('h2');
      title.id = 'confirm-title';
      title.textContent = form.getAttribute('data-confirm');
      var text = document.createElement('p');
      text.id = 'confirm-text';
      text.textContent = form.getAttribute('data-confirm-text') || '';
      var row = document.createElement('div');
      row.className = 'btn-row';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-secondary';
      cancel.textContent = form.getAttribute('data-confirm-cancel') || 'Cancel';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn btn-danger';
      ok.textContent = form.getAttribute('data-confirm-ok') || 'OK';
      row.appendChild(cancel);
      row.appendChild(ok);
      dialog.appendChild(title);
      dialog.appendChild(text);
      dialog.appendChild(row);
      document.body.appendChild(dialog);
      var answered = false;
      cancel.addEventListener('click', function () { dialog.close(); });
      // Closing in any way (Cancel, Escape) gives the focus back to the button that asked.
      dialog.addEventListener('close', function () {
        dialog.remove();
        if (!answered && trigger && trigger.focus) trigger.focus();
      });
      ok.addEventListener('click', function () {
        answered = true;
        var input = form.querySelector('input[name="confirmed"]') || document.createElement('input');
        input.type = 'hidden';
        input.name = 'confirmed';
        input.value = '1';
        form.appendChild(input);
        dialog.close();
        busy(form, trigger);
        form.submit();
      });
      dialog.showModal();
      cancel.focus();
    });
  });

  // Confirm by typing: the danger button stays disabled until the name matches; the server checks it again.
  document.querySelectorAll('input[data-confirm]').forEach(function (input) {
    var form = input.form;
    var btn = form && (form.querySelector('button.btn-danger[type="submit"]') || form.querySelector('button[type="submit"]'));
    if (!btn) return;
    var check = function () { btn.disabled = input.value !== input.getAttribute('data-confirm'); };
    input.addEventListener('input', check);
    check();
  });
})();
