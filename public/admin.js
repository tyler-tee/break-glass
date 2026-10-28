// Progressive enhancement for admin pages. Everything works without this file.
// Forms marked data-busy="Label" disable the button that was used while a long POST runs.
(function () {
  'use strict';
  var changed = [];

  function restore() {
    changed.forEach(function (item) {
      item.button.disabled = false;
      item.button.textContent = item.text;
      item.button.removeAttribute('aria-busy');
    });
    changed = [];
  }

  function onSubmit(event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-busy')) return;
    var button = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;
    var label = form.getAttribute('data-busy') || 'Working...';
    // Defer so the browser reads the button's name/value into the form data first.
    setTimeout(function () {
      if (event.defaultPrevented) return;
      changed.push({ button: button, text: button.textContent });
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label;
    }, 0);
  }

  document.addEventListener('submit', onSubmit);
  // Back/forward cache restores the page as it was left, so undo the busy state.
  window.addEventListener('pageshow', restore);
})();
