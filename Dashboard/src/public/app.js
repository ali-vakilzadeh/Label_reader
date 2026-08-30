/* Progressive enhancement only. Every page works with JavaScript disabled — the forms are
   real forms and the links are real links. This file adds convenience, never capability. */

(function () {
  'use strict';

  /* Select-all in the item grid. */
  var all = document.getElementById('select-all');
  if (all) {
    all.addEventListener('change', function () {
      document.querySelectorAll('input[name="ids"]').forEach(function (box) {
        box.checked = all.checked;
      });
    });
  }

  /* "Accept" buttons next to a suggestion fill the field; they never submit on their own,
     because a suggestion becomes a decision only when a person saves it. */
  document.querySelectorAll('[data-fill]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var field = document.querySelector('[name="' + btn.dataset.fill + '"]');
      if (field) {
        field.value = btn.dataset.value;
        field.focus();
      }
    });
  });

  /* HS code picker: a human choosing from the legal nomenclature. The suggestion engine
     deliberately never text-searches this list itself. */
  var hsInput = document.getElementById('hs-input');
  var hsResults = document.getElementById('hs-results');
  var hsName = document.getElementById('hs-name');
  if (hsInput && hsResults) {
    var timer = null;
    var search = function () {
      var q = hsInput.value.trim();
      if (q.length < 2) {
        hsResults.hidden = true;
        return;
      }
      fetch('/api/hs-codes?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          hsResults.innerHTML = '';
          rows.forEach(function (row) {
            var el = document.createElement('div');
            el.innerHTML = '<code>' + row.code + '</code>' + row.name;
            el.addEventListener('mousedown', function (ev) {
              ev.preventDefault();
              hsInput.value = row.code;
              if (hsName) hsName.textContent = row.name;
              hsResults.hidden = true;
            });
            hsResults.appendChild(el);
          });
          hsResults.hidden = rows.length === 0;
        })
        .catch(function () { hsResults.hidden = true; });
    };
    hsInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(search, 200);
    });
    hsInput.addEventListener('blur', function () {
      setTimeout(function () { hsResults.hidden = true; }, 150);
    });
  }

  /* Refresh the status banner without a full reload. The protocol's own guidance: status
     is up to 30 s stale, so poll once a minute and show timestamps rather than "live". */
  var banner = document.getElementById('status-banner');
  if (banner) {
    setInterval(function () {
      fetch('/api/status')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.banner) return;
          if (data.banner.code !== banner.dataset.code) {
            // The banner's shape changes with its level, so a full reload is simpler and
            // cheaper than patching class names, and it happens at most once per change.
            window.location.reload();
          }
        })
        .catch(function () { /* the middleware being unreachable is a normal state */ });
    }, 60000);
  }
})();
