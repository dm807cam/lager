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

  // Copy buttons: the text to copy and the confirmation label come from data attributes rendered by the server.
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

  // Questions before changes that cannot be taken back. The form carries the question; the dialog asks it, and only a yes sends the
  // form, with confirmed=1. Cancel has the focus, so Enter or Escape keep everything as it is. Without this script, or in a browser
  // without <dialog>, the server asks on a page of its own: the change never happens on one click either way.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      // Asked every time: a yes from before (a page from the back/forward cache, a send that failed) does not count again.
      if (typeof HTMLDialogElement === 'undefined') return;
      e.preventDefault();
      var trigger = e.submitter || document.activeElement;
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
        form.submit();
      });
      dialog.showModal();
      cancel.focus();
    });
  });

  // Confirm by typing: the danger button stays disabled until the name matches (a Cancel button next to it stays usable). The server checks it again.
  document.querySelectorAll('input[data-confirm]').forEach(function (input) {
    var form = input.form;
    var btn = form && (form.querySelector('button.btn-danger[type="submit"]') || form.querySelector('button[type="submit"]'));
    if (!btn) return;
    var check = function () { btn.disabled = input.value !== input.getAttribute('data-confirm'); };
    input.addEventListener('input', check);
    check();
  });
})();
