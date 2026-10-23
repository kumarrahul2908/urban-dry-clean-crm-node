// Rahul: Service and Category used to stay unselected (and the garment grid empty) until tapped. Pre-select "Dry Cleaning" (or the
// service this page already treats as active) and the first category ("Men" if present), and load the garment grid immediately.
(function preselectDefaults() {
  const svcTabs = Array.prototype.slice.call(document.querySelectorAll('.svc-tab'));
  const svc = svcTabs.find(function (b) { return b.textContent.trim().toLowerCase() === 'dry cleaning'; })
    || svcTabs.find(function (b) { return parseInt(b.dataset.id, 10) === activeServiceId; }) || svcTabs[0];
  if (svc) onServiceTabClick.call(svc);
  const catTabs = Array.prototype.slice.call(document.querySelectorAll('.cat-tab'));
  const cat = catTabs.find(function (b) { return b.textContent.trim().toLowerCase() === 'men'; }) || catTabs[0];
  if (cat) onCategoryTabClick.call(cat);
})();
