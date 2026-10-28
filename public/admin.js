// Progressive enhancement for admin pages. Everything works without this file; the server validates.
(function () {
  'use strict';

  // Forms marked data-busy="Label" disable the button that was used while a long POST runs.
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

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  // "A", "A and B", "A, B and C"
  function words(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  // Find places: the category picker. Select all / none, and a live count on the run button.
  each(document.querySelectorAll('[data-find-picker]'), function (form) {
    var boxes = form.querySelectorAll('input[name="category_id"]');
    var button = form.querySelector('[data-run-button]');
    function update() {
      var n = 0;
      each(boxes, function (b) { if (b.checked) n++; });
      if (!button) return;
      button.disabled = n === 0;
      button.textContent = n === 0 ? 'Pick a category' : 'Find & rank ' + n + (n === 1 ? ' category' : ' categories');
    }
    each(form.querySelectorAll('[data-select]'), function (link) {
      link.hidden = false;
      link.addEventListener('click', function () {
        var on = link.getAttribute('data-select') === 'all';
        each(boxes, function (b) { b.checked = on; });
        update();
      });
    });
    form.addEventListener('change', update);
    update();
  });

  // Find places: one form per category. At most data-max picks, and the summary and save label follow the boxes.
  each(document.querySelectorAll('form[data-picks]'), function (form) {
    var max = Number(form.getAttribute('data-max')) || 3;
    var boxes = form.querySelectorAll('input[name="location_id"]');
    var summary = form.querySelector('[data-summary]');
    var saves = form.querySelectorAll('[data-save]');
    var section = form.closest('section');

    function update(fromUser) {
      var count = 0, adds = [], removes = [];
      each(boxes, function (b) {
        var current = b.getAttribute('data-current') === '1';
        var name = b.getAttribute('data-short') || '';
        if (b.checked) count++;
        if (b.checked && !current) adds.push(name);
        if (!b.checked && current) removes.push(name);
      });
      var isChanged = adds.length > 0 || removes.length > 0;
      each(boxes, function (b) { b.disabled = !b.checked && count >= max; });

      var label = isChanged ? 'Save ' + count + ' pick' + (count === 1 ? '' : 's') : 'No changes';
      each(saves, function (s) {
        s.textContent = label;
        s.disabled = !isChanged || count === 0 || count > max;
      });
      if (!fromUser || !summary) return;

      var text, err = false;
      if (count === 0) { text = 'Pick up to ' + max + ' places.'; err = true; }
      else if (!isChanged) text = 'Same as what the family site shows now.';
      else {
        var parts = [];
        if (adds.length) parts.push('adds ' + words(adds));
        if (removes.length) parts.push('takes off ' + words(removes));
        text = 'Saving ' + parts.join(' and ') + '.';
        if (count < max) text += ' You have ' + count + ' of ' + max + ' picked.';
      }
      summary.textContent = text;
      summary.className = err ? 'change err' : 'change';
      summary.removeAttribute('role');
      summary.setAttribute('aria-live', 'polite');
      summary.hidden = false;
      if (section) each(section.querySelectorAll('.saved'), function (n) { n.hidden = true; });
    }

    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'location_id') update(true);
    });
    update(false);
  });
})();
