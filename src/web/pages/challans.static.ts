export const challanStyle = (): string => `<style>
.ch-picker-results { position: relative; }
.ch-picker-dropdown { position: absolute; z-index: 20; left: 0; right: 0; top: 100%; background: #fff; border: 1px solid #dee2e6; border-radius: 6px; box-shadow: 0 6px 16px rgba(0,0,0,.08); max-height: 260px; overflow-y: auto; }
.ch-picker-dropdown .item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f1f1f1; }
.ch-picker-dropdown .item:hover { background: #f8f9fa; }
.ch-picker-dropdown .item:last-child { border-bottom: none; }
.ch-chip { display: inline-flex; align-items: center; gap: 6px; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 999px; padding: 4px 10px; font-size: 13px; margin: 2px; }
.ch-chip button { border: none; background: none; color: #4338ca; font-weight: bold; cursor: pointer; line-height: 1; padding: 0; }
</style>`;

/** Shared order-picker widget for /modules/challans/generate and /modules/challans/edit. `preselected` is
 * [{order_id, label}] already on the challan (edit mode) or [] (generate mode). */
export const challanPickerScript = (searchUrl: string, preselected: { order_id: number; label: string }[]): string => `<script>
(function () {
  const selected = new Map(${JSON.stringify(preselected.map((p) => [p.order_id, p.label]))});
  const chipsEl = document.getElementById('chPickerChips');
  const inputsEl = document.getElementById('chPickerInputs');
  const searchInput = document.getElementById('chPickerSearch');
  const dropdown = document.getElementById('chPickerDropdown');

  function render() {
    chipsEl.innerHTML = '';
    inputsEl.innerHTML = '';
    if (selected.size === 0) chipsEl.innerHTML = '<span class="text-muted small">No orders selected yet.</span>';
    selected.forEach(function (label, orderId) {
      const chip = document.createElement('span');
      chip.className = 'ch-chip';
      chip.innerHTML = '<span></span><button type="button" aria-label="Remove">×</button>';
      chip.querySelector('span').textContent = label;
      chip.querySelector('button').addEventListener('click', function () { selected.delete(orderId); render(); });
      chipsEl.appendChild(chip);
      const hidden = document.createElement('input');
      hidden.type = 'hidden'; hidden.name = 'order_ids[]'; hidden.value = String(orderId);
      inputsEl.appendChild(hidden);
    });
  }

  let debounceTimer = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; return; }
    debounceTimer = setTimeout(function () {
      fetch('${searchUrl}?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          const results = res.results || [];
          dropdown.innerHTML = '';
          if (!results.length) { dropdown.style.display = 'none'; return; }
          results.forEach(function (o) {
            const row = document.createElement('div');
            row.className = 'item';
            const code = o.short_order_code || o.order_number;
            row.textContent = code + ' — ' + o.customer_name + ' (' + o.mobile + ')';
            row.addEventListener('click', function () {
              selected.set(o.id, code + ' — ' + o.customer_name);
              render();
              dropdown.style.display = 'none';
              searchInput.value = '';
            });
            dropdown.appendChild(row);
          });
          dropdown.style.display = 'block';
        });
    }, 200);
  });
  document.addEventListener('click', function (e) { if (!dropdown.contains(e.target) && e.target !== searchInput) dropdown.style.display = 'none'; });

  document.getElementById('chPickerForm').addEventListener('submit', function (e) {
    if (selected.size === 0) { e.preventDefault(); alert('Select at least one order.'); }
  });

  render();
})();
</script>`;
