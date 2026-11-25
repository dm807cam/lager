/* Lager "Made with Lager" badge. The server includes this script only for people an instance is shared with and for
   public visitors, never for its owner and managers. The texts and the link come from data attributes of the script tag
   in the viewer's language. The badge lives in a shadow root, so the app's styles cannot reach it, and a viewer
   can hide it for this app on this device. Plain ES2020, no dependencies, no tracking. */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__lagerBadge) return;
  window.__lagerBadge = true;

  var KEY = 'lager.badge.hidden';
  var label = script.getAttribute('data-label') || 'Made with Lager';
  var linkLabel = script.getAttribute('data-link-label') || label;
  var closeLabel = script.getAttribute('data-close') || 'Hide';
  var href = script.getAttribute('data-href') || '';
  if (!/^https:\/\//.test(href)) return;

  function hidden() {
    try { return window.localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { window.localStorage.setItem(KEY, '1'); } catch (e) { /* the badge still goes away for this visit */ }
  }

  // The Lager mark: a shelf with three boxes, drawn inline so the badge needs no request of its own.
  var MARK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">'
    + '<rect x="1" y="1" width="22" height="22" rx="6" fill="#1f2a5c"/>'
    + '<path d="M5 6v13M19 6v13M5 12.5h14M5 19h14" stroke="#9fb0ff" stroke-width="1.6" stroke-linecap="round" fill="none"/>'
    + '<rect x="6.6" y="8" width="4.4" height="3.6" rx=".8" fill="#f58220"/>'
    + '<rect x="12.4" y="8.6" width="4.6" height="3" rx=".8" fill="#f8a65a"/>'
    + '<rect x="8.6" y="14.4" width="5.6" height="3.6" rx=".8" fill="#f58220"/></svg>';

  var CSS = ':host{all:initial;position:fixed;z-index:2147483000;'
    + 'right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px))}'
    + '.b{display:flex;align-items:center;gap:4px;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;'
    + 'color:#1d2333;background:rgba(255,255,255,.92);border:1px solid rgba(29,35,51,.16);border-radius:999px;'
    + 'box-shadow:0 2px 10px rgba(16,20,40,.14);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + 'a{display:flex;align-items:center;gap:6px;min-height:32px;box-sizing:border-box;padding:6px 4px 6px 7px;color:inherit;text-decoration:none;border-radius:999px}'
    + 'a:hover span{text-decoration:underline}'
    + 'button{all:unset;cursor:pointer;display:grid;place-items:center;width:32px;height:32px;margin-right:1px;'
    + 'border-radius:999px;color:#4a5168;font-size:15px;line-height:1}'
    + 'button:hover{background:rgba(29,35,51,.08)}'
    + 'a:focus-visible,button:focus-visible{outline:2px solid #3b5bdb;outline-offset:2px}'
    + '@media (prefers-color-scheme:dark){.b{color:#e8ebf5;background:rgba(24,28,42,.9);border-color:rgba(232,235,245,.18)}'
    + 'button{color:#b9c0d4}button:hover{background:rgba(232,235,245,.12)}a:focus-visible,button:focus-visible{outline-color:#9fb0ff}}'
    + '@media print{.b{display:none}}';

  function render() {
    if (hidden() || !document.body) return;
    var host = document.createElement('lager-badge');
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    var box = document.createElement('div');
    box.className = 'b';
    var link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', linkLabel);
    link.innerHTML = MARK;
    var text = document.createElement('span');
    text.textContent = label;
    link.appendChild(text);
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', closeLabel);
    close.title = closeLabel;
    close.textContent = '×';
    close.addEventListener('click', function () {
      remember();
      host.remove();
    });
    box.appendChild(link);
    box.appendChild(close);
    root.appendChild(style);
    root.appendChild(box);
    document.body.appendChild(host);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
