/**
 * URBAN DRY CLEAN - Generic Master-Data CRUD wiring.
 * Used by every simple master-data list page (categories/services/taxes/discounts/
 * urgent_levels/payment_types/brands/colors/defects/stores/workshops). Each page calls
 * initMasterCrud() with its entity name, API endpoint, and the modal/form element IDs it
 * rendered.
 *
 * Every calling page's own inline <script> executes BEFORE includes/footer.php's
 * <script src="bootstrap.bundle.min.js"> has loaded (footer.php is required after the page's
 * own script block) — so `bootstrap` does not exist yet at the moment initMasterCrud(opts) is
 * called. The actual setup work is deferred to DOMContentLoaded here, once, at the source, so
 * every page using this shared utility is fixed at once rather than each page needing its own
 * wrapper (same fix already applied individually to modules/pos/index.php and
 * modules/laundry/index.php).
 */
function initMasterCrud(opts) {
  document.addEventListener('DOMContentLoaded', function () {
  var entity = opts.entity;
  var apiUrl = opts.apiUrl;
  var modalEl = document.getElementById(opts.modalId);
  var modal = new bootstrap.Modal(modalEl);
  var form = document.getElementById(opts.formId);
  var errorBox = document.getElementById(opts.errorBoxId);
  var idField = form.querySelector('[name="id"]');
  var modalTitle = document.getElementById(opts.modalTitleId);

  function resetForm() {
    form.reset();
    idField.value = '';
    errorBox.classList.add('d-none');
    errorBox.textContent = '';
  }

  document.getElementById(opts.addButtonId).addEventListener('click', function () {
    resetForm();
    modalTitle.textContent = opts.addTitle || 'Add';
    modal.show();
  });

  document.querySelectorAll('[data-edit-row]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      resetForm();
      modalTitle.textContent = opts.editTitle || 'Edit';
      var row = btn.closest('tr');
      Object.keys(row.dataset).forEach(function (key) {
        var field = form.querySelector('[name="' + key + '"]');
        if (field) field.value = row.dataset[key];
      });
      idField.value = row.dataset.id;
      modal.show();
    });
  });

  document.querySelectorAll('[data-toggle-row]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.closest('tr').dataset.id;
      udcPost(apiUrl, { entity: entity, action: 'toggle', id: id }).then(function (res) {
        if (res.success) { location.reload(); } else { alert(res.message || 'Action failed.'); }
      });
    });
  });

  document.querySelectorAll('[data-delete-row]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!confirm('Delete this record? This cannot be undone.')) return;
      var id = btn.closest('tr').dataset.id;
      udcPost(apiUrl, { entity: entity, action: 'delete', id: id }).then(function (res) {
        if (res.success) { location.reload(); } else { alert(res.message || 'Could not delete this record.'); }
      });
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = { entity: entity, action: idField.value ? 'update' : 'create' };
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    udcPost(apiUrl, data).then(function (res) {
      if (res.success) {
        location.reload();
      } else {
        errorBox.textContent = res.message || 'Please correct the errors and try again.';
        errorBox.classList.remove('d-none');
      }
    });
  });
  });
}
