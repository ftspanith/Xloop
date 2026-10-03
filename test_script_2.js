
(function(){
  var path = window.location.pathname;
  var map = {
    'dashboard': 'bnav-dashboard',
    'orchestrator': 'bnav-orchestrator',
    'manager': 'bnav-manager',
    'fix-posters': 'bnav-posters',
    'bulk-import': 'bnav-import',
    'scraper': 'bnav-orchestrator',
    'add-movie': 'bnav-manager',
    'add-series': 'bnav-manager'
  };
  for (var key in map) {
    if (path.indexOf(key) !== -1) {
      var el = document.getElementById(map[key]);
      if (el) el.classList.add('active');
      break;
    }
  }
})();
