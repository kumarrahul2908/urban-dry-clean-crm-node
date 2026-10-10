document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.getElementById('udcSidebarToggle');
  var sidebar = document.getElementById('udcSidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      sidebar.classList.toggle('show');
    });
    document.addEventListener('click', function (e) {
      if (window.innerWidth < 992 && sidebar.classList.contains('show')
          && !sidebar.contains(e.target) && e.target !== toggle) {
        sidebar.classList.remove('show');
      }
    });
  }
});

/**
 * Shared JSON POST helper for AJAX calls to /api endpoints.
 * Automatically attaches the CSRF token found in <meta name="csrf-token">.
 */
async function udcPost(url, data) {
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var payload = Object.assign({}, data, { csrf_token: csrfMeta ? csrfMeta.content : '' });
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify(payload)
  });
  return res.json();
}
