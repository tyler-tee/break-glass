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

  // Find places: one form per category. The summary and save label follow the boxes.
  each(document.querySelectorAll('form[data-picks]'), function (form) {
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

      var label = isChanged ? 'Save ' + count + ' pick' + (count === 1 ? '' : 's') : 'No changes';
      each(saves, function (s) {
        s.textContent = label;
        s.disabled = !isChanged || count === 0;
      });
      if (!fromUser || !summary) return;

      var text, err = false;
      if (count === 0) { text = 'Pick at least 1 place.'; err = true; }
      else if (!isChanged) text = 'Same as what the family site shows now.';
      else {
        var parts = [];
        if (adds.length) parts.push('adds ' + words(adds));
        if (removes.length) parts.push('takes off ' + words(removes));
        text = 'Saving ' + parts.join(' and ') + '.';
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

  // House fact form: show only the fields that apply to the chosen kind. Hidden fields are disabled so they
  // are not posted. Without this script every field stays visible and the server validates.
  each(document.querySelectorAll('form[data-fact-form]'), function (form) {
    var radios = form.querySelectorAll('input[name="kind"]');
    var fields = form.querySelectorAll('[data-kinds]');
    function kind() {
      var k = '';
      each(radios, function (r) { if (r.checked) k = r.value; });
      return k;
    }
    function update() {
      var k = kind();
      each(fields, function (f) {
        var show = f.getAttribute('data-kinds').split(' ').indexOf(k) !== -1;
        f.hidden = !show;
        each(f.querySelectorAll('input, select, textarea'), function (el) { el.disabled = !show; });
      });
    }
    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'kind') update();
    });
    update();
  });

  // House photos: shrink the picture on the phone before it uploads. Drawing it onto a canvas applies the
  // camera's rotation and drops the location data. If the browser cannot decode it (for example HEIC), the file
  // is left as it was and the server explains.
  var MAX_EDGE = 1600;
  each(document.querySelectorAll('form[data-photo-form]'), function (form) {
    form.classList.add('js');
    var inputs = form.querySelectorAll('input[type="file"]');
    var label = form.querySelector('[data-photo-name]');
    function show(name) {
      if (!label) return;
      label.textContent = name ? 'Ready to upload: ' + name : '';
      label.hidden = !name;
    }
    function shrink(input) {
      var file = input.files && input.files[0];
      if (!file) return;
      // One photo at a time: clear the other input.
      each(inputs, function (other) { if (other !== input) other.value = ''; });
      show(file.name);
      if (!window.createImageBitmap || !window.DataTransfer || !HTMLCanvasElement.prototype.toBlob) return;
      createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
        var scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (bitmap.close) bitmap.close();
        canvas.toBlob(function (blob) {
          if (!blob) return;
          var name = (file.name.replace(/\.[^.]*$/, '') || 'photo') + '.jpg';
          var out = new File([blob], name, { type: 'image/jpeg' });
          var transfer = new DataTransfer();
          transfer.items.add(out);
          input.files = transfer.files;
          show(name);
        }, 'image/jpeg', 0.82);
      }).catch(function () { /* leave the file as it is */ });
    }
    each(inputs, function (input) {
      input.addEventListener('change', function () { shrink(input); });
    });
  });
})();
